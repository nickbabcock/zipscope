// The navigation puts the location back when the worker refuses a view
// request. The fake
// deps give each request a promise that the test settles.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createRoot, flush } from "solid-js";
import { createNavigation } from "./navigation";
import type { Navigation } from "./navigation";
import type { HistoryLike, NavState } from "./history";

/** A history stack like the one of a browser tab. `go` sends `popstate`. */
class FakeHistory implements HistoryLike {
  entries: unknown[] = [null];
  at = 0;

  get state(): unknown {
    return this.entries[this.at];
  }
  pushState(data: unknown): void {
    this.entries = [...this.entries.slice(0, this.at + 1), structuredClone(data)];
    this.at++;
  }
  replaceState(data: unknown): void {
    this.entries[this.at] = structuredClone(data);
  }
  go(delta: number): void {
    this.at = Math.max(0, Math.min(this.entries.length - 1, this.at + delta));
    const event = new Event("popstate");
    Object.defineProperty(event, "state", { value: structuredClone(this.state) });
    window.dispatchEvent(event);
  }
}

interface Request<T> {
  value: T;
  resolve(): void;
  reject(): void;
}

let history: FakeHistory;
let lists: Request<number>[];
let searches: Request<string>[];
/** What the worker published. */
let shown: { query: string; folder: number | undefined };
let nav: Navigation;
let dispose: () => void;

function request<T>(list: Request<T>[], value: T): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  list.push({ value, resolve, reject: () => reject(new Error("memory limit")) });
  return promise;
}

/** Lets the promise handlers run, and applies the signal writes. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flush();
}

/** The state of the current history entry, after a replace that waits. */
function entry(): NavState {
  window.dispatchEvent(new Event("pagehide"));
  return history.state as NavState;
}

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  history = new FakeHistory();
  lists = [];
  searches = [];
  shown = { query: "", folder: 0 };
  createRoot((done) => {
    dispose = done;
    nav = createNavigation({
      narrow: () => false,
      history,
      list: (folder) => request(lists, folder),
      search: (query) => request(searches, query),
      shownQuery: () => shown.query,
      shownFolder: () => shown.folder,
    });
  });
  nav.openArchive("session", { name: "a.zip", demo: false });
  // The table lists the root.
  nav.report(0, [{ folder: 0, label: "a.zip", root: true }]);
  flush();
});

afterEach(() => {
  dispose();
  vi.unstubAllGlobals();
});

test("a refused last search goes back, and a stale search does nothing", async () => {
  nav.search("a");
  nav.search("ab");
  expect(searches.map((search) => search.value)).toEqual(["a", "ab"]);
  searches[0]!.reject();
  await settle();
  // The stale search does not change the location.
  expect(nav.query()).toBe("ab");
  searches[1]!.reject();
  await settle();
  expect(nav.query()).toBe("");
  expect(entry().query).toBe("");
});

test("a refused search goes back to the search that the worker published", async () => {
  nav.search("a");
  shown.query = "a";
  searches[0]!.resolve();
  await settle();
  nav.search("ab");
  searches[1]!.reject();
  await settle();
  expect(nav.query()).toBe("a");
  expect(entry().query).toBe("a");
  // The next search starts from the query that shows.
  nav.search("a");
  expect(searches).toHaveLength(2);
});

test("a list that is refused after Back does not change the entry of Back", async () => {
  nav.navigateToFolder(5);
  flush();
  expect(lists.map((list) => list.value)).toEqual([5]);
  history.go(-1);
  flush();
  // The landing entry lists the root again.
  expect(lists.map((list) => list.value)).toEqual([5, 0]);
  lists[0]!.reject();
  await settle();
  expect(entry().folder).toBe(0);
  expect(nav.folder()).toBe(0);
  lists[1]!.resolve();
  await settle();
  expect(entry().folder).toBe(0);
  // The entry of the refused push keeps its folder until it shows again.
  expect((history.entries[history.at + 1] as NavState).folder).toBe(5);
});

test("a folder push with a refused list and a refused search ends at the listing", async () => {
  nav.search("x");
  shown = { query: "x", folder: undefined };
  searches[0]!.resolve();
  await settle();
  nav.navigateToFolder(3);
  flush();
  expect(lists.map((list) => list.value)).toEqual([3]);
  expect(searches.map((search) => search.value)).toEqual(["x", ""]);
  lists[0]!.reject();
  searches[1]!.reject();
  await settle();
  // The search results of "x" in the root still show.
  expect(entry()).toMatchObject({ folder: 0, query: "x" });
  expect(nav.query()).toBe("x");
  expect(nav.folder()).toBe(0);
});

test("each entry keeps the path of its listing for the reopen door", () => {
  expect(history.state).toMatchObject({ path: null });
  nav.navigateToFolder(3);
  // The listed folder is the end of a compact chain: folder 4.
  nav.report(4, [
    { folder: 0, label: "a.zip", root: true },
    { folder: 2, label: "app", root: false },
    { folder: 4, label: "src/main", root: false },
  ]);
  // The path is in the entry at once, with no wait.
  expect((history.state as NavState).path).toBe("app/src/main");
  expect((history.state as NavState).folder).toBe(3);
});

test("restore shows the location of an entry of an earlier session", () => {
  const earlier = {
    ...entry(),
    session: "earlier",
    folder: 7,
    path: "docs",
    query: "guide",
    preview: true,
    entry: "docs/guide.md",
    row: 2,
  };
  nav.restore(earlier);
  flush();
  expect(nav.query()).toBe("guide");
  expect(nav.entry()).toBe("docs/guide.md");
  expect(lists.map((list) => list.value)).toEqual([7]);
  expect(searches.map((search) => search.value)).toEqual(["guide"]);
  const now = entry();
  expect(now).toMatchObject({ session: "session", folder: 7, path: "docs", query: "guide" });
  // After the user moved, a late restore does nothing.
  nav.navigateToFolder(9);
  nav.restore({ ...earlier, folder: 11 });
  expect(entry().folder).toBe(9);
});
