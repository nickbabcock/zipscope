import { createMemo, createRoot, createSignal, flush, untrack } from "solid-js";
import { beforeEach, expect, test, vi } from "vitest";
import { BEST_MATCH_ORDER, LocalMismatch, SORT_DESCENDING, SortColumn, State } from "../contracts";
import type { EntryCheck, ParseOutcome } from "../contracts";
import type { ArchiveSession } from "../session";
import { createArchiveView } from "./archive-view";

/** A session with the parts that the view uses. */
function fakeSession() {
  const finished = Promise.withResolvers<ParseOutcome>();
  let busy: (count: number, searching: boolean) => void = () => {};
  const session = {
    info: { name: "a.zip", bytes: 1, demo: false },
    reader: { storeBytes: () => 7, progress: () => 0, healthGeneration: () => 0 },
    health: () => new Promise(() => {}),
    onPrompt(listener: (prompt: undefined) => void) {
      listener(undefined);
      return () => {};
    },
    read: { onMemory: undefined as (() => void) | undefined },
    writeBytes: () => 0,
    onWriteMemory: undefined as (() => void) | undefined,
    onPublished: undefined as (() => void) | undefined,
    opened: Promise.resolve({ entriesHint: 3 }),
    finished: finished.promise,
    settleListing: () => Promise.resolve(),
    settleTreeOrder: () => Promise.resolve(),
    onBusy(listener: (count: number, searching: boolean) => void) {
      busy = listener;
      listener(0, false);
      return () => {};
    },
  };
  return {
    session: session as unknown as ArchiveSession & typeof session,
    finish: finished.resolve,
    busy: (count: number, searching = false) => busy(count, searching),
  };
}

beforeEach(() => {
  // Node has no animation frames. The view only stops its loop here.
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

const settle = async () => {
  for (let step = 0; step < 5; step++) await Promise.resolve();
  flush();
};

test("a new session gets a new view, and the old view takes no late values", async () => {
  const first = fakeSession();
  const second = fakeSession();
  const [session, setSession] = createSignal<ArchiveSession>(first.session);
  const view = createRoot(() =>
    createMemo(() => {
      const current = session();
      return untrack(() => createArchiveView(current));
    }),
  );
  flush();
  const old = untrack(view);
  await settle();
  expect(old.declared()).toBe(3);
  expect(old.phase()).toEqual({ kind: "opening" });
  expect(first.session.onPublished).toBeTypeOf("function");

  setSession(second.session);
  flush();
  const next = untrack(view);
  expect(next).not.toBe(old);
  // The owner disposed the old view: it is not connected to its session.
  expect(first.session.onPublished).toBeUndefined();
  expect(first.session.read.onMemory).toBeUndefined();
  // A late outcome of the old session does not change the new view.
  first.finish({ kind: "failed", rows: 0, message: "closed" });
  await settle();
  expect(next.phase()).toEqual({ kind: "opening" });
});

test("the sort status follows the searches in progress", async () => {
  const fake = fakeSession();
  const view = createRoot(() => createArchiveView(fake.session));
  flush();
  expect(view.sortStatus()).toBe("");
  // A short request shows no text.
  fake.busy(1);
  await settle();
  expect(view.sortStatus()).toBe("");
  fake.busy(0);
  await settle();
  fake.busy(1, true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  flush();
  expect(view.sortStatus()).toBe("Searching… (parse 0%)");
  fake.finish({ kind: "complete", rows: 1 });
  fake.busy(0);
  await settle();
  expect(view.sortStatus()).toBe("");
});

test("the status tells the best-match order, and only that order", async () => {
  const fake = fakeSession();
  // The views that the next frame reads.
  let sort = 0;
  let rows = 2;
  const reader = fake.session.reader as unknown as Record<string, unknown>;
  Object.assign(reader, {
    state: () => State.PARSING,
    committedRows: () => 2,
    visibleRows: () => 2,
    visibleFolders: () => 0,
    views: () => ({ sort, permutation: new Uint32Array(rows) }),
    stable: () => true,
    opened: () => true,
  });
  let frame: FrameRequestCallback = () => {};
  vi.stubGlobal("requestAnimationFrame", (draw: FrameRequestCallback) => {
    frame = draw;
    return 1;
  });
  const view = createRoot(() => createArchiveView(fake.session));
  const draw = () => {
    frame(0);
    flush();
  };
  flush();
  draw();
  expect(view.sortStatus()).toBe("");
  expect(view.sort()).toEqual({ column: SortColumn.ARCHIVE, descending: false });
  // A query with no sort chosen.
  sort = BEST_MATCH_ORDER;
  draw();
  expect(view.sortStatus()).toBe("Best match");
  expect(view.sort().column).toBe(BEST_MATCH_ORDER);
  // It is no choice, so the history entry keeps no sort.
  expect(view.sortChosen()).toBe(false);
  // A search that runs comes first.
  fake.busy(1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  flush();
  expect(view.sortStatus()).toBe("Searching… (parse 0%)");
  fake.busy(0);
  await settle();
  expect(view.sortStatus()).toBe("Best match");
  // A search with no result has no order to tell.
  rows = 0;
  draw();
  expect(view.sortStatus()).toBe("");
  rows = 2;
  draw();
  expect(view.sortStatus()).toBe("Best match");
  // A clear goes back to the sort of the folder.
  sort = SortColumn.SIZE | SORT_DESCENDING;
  draw();
  expect(view.sortStatus()).toBe("");
  expect(view.sort()).toEqual({ column: SortColumn.SIZE, descending: true });
  // A new search says so, also from a folder with an arrow. A sort still says
  // that it sorts.
  fake.busy(1, true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  flush();
  expect(view.sortStatus()).toBe("Searching… (parse 0%)");
  fake.busy(0);
  await settle();
  fake.busy(1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  flush();
  expect(view.sortStatus()).toBe("Sorting… (parse 0%)");
});

test("the end of the parse ends the default sort", async () => {
  const fake = fakeSession();
  const settleListing = vi.spyOn(fake.session, "settleListing");
  const settleTreeOrder = vi.spyOn(fake.session, "settleTreeOrder");
  createRoot(() => createArchiveView(fake.session));
  flush();
  expect(settleListing).not.toHaveBeenCalled();
  expect(settleTreeOrder).not.toHaveBeenCalled();
  fake.finish({ kind: "complete", rows: 1 });
  await settle();
  expect(settleListing).toHaveBeenCalledTimes(1);
  expect(settleTreeOrder).toHaveBeenCalledTimes(1);
});

test("two local header checks before one flush both count as findings", () => {
  const fake = fakeSession();
  const view = createRoot(() => createArchiveView(fake.session));
  flush();
  expect(view.findings()).toEqual([]);
  const check = (mismatches: number) => ({ mismatches, localName: "x" }) as EntryCheck;
  view.onCheck(1, check(LocalMismatch.NAME));
  view.onCheck(2, check(LocalMismatch.NAME));
  flush();
  const first = view.findings();
  expect(first).toHaveLength(1);
  expect(first[0]!.text).toMatch(/^2 previewed entries/);
  // One memo: each read gives the same list.
  expect(view.findings()).toBe(first);
});

test("a complete parse is listed after the outcome and a frame of all rows", async () => {
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  const fake = fakeSession();
  Object.assign(fake.session.reader, {
    state: () => State.COMPLETE,
    committedRows: () => 2,
    visibleRows: () => 2,
    visibleFolders: () => 1,
    views: () => undefined,
    stable: () => true,
    opened: () => true,
  });
  performance.mark("zipscope:open");
  const view = createRoot(() => createArchiveView(fake.session));
  flush();
  view.loop.schedule();
  frame?.(0);
  flush();
  // The worker did not report the outcome yet: the parse continues.
  expect(view.phase()).toEqual({ kind: "listing", progress: 1 });
  expect(view.rows()).toBe(2);
  fake.finish({ kind: "complete", rows: 2 });
  await settle();
  expect(view.phase().kind).toBe("listed");
});
