// Measures view-request latency while a sorted search listing grows during
// parsing, in headless Chromium. The spec promises that a view request
// waits at most one batch (~8 ms), also when a sort is incremental at 1M
// rows. The script compares three orders of a search that matches every
// entry: archive order that the user chose, the order with no sort chosen
// (best match), and a name sort. It checks the final order. Late in the
// parse it requests a new sort (at 40%, name sort only) and a new search (at
// 70%), which make a listing of the whole parsed prefix in steps. The
// requests that wait behind them are in the results.
//
// Two more cases check archives with costly sorts after the parse: 250,000
// child folders of the root, and 1,000 names with a 60,000-byte common
// prefix. Each round measures a tree request alone, then a tree request
// sent just after a name sort request, so it waits behind that sort.
//
// After the parse, it also measures searches of the main archive: one that
// matches all rows, one with few matches, and a query that gets longer one
// key at a time, from all rows to few rows.
//
// With an archive of varied sizes, made from the manifest, it measures a Cancel
// with rows waiting (the time from the click to the listing with all matches of
// the parsed rows), and a query typed one key at a time during the parse. With
// `--stops-only`, it runs only these two cases.
//
// Each `--flat` archive has nearly all its rows in the root folder. For it, the
// script reports the time from the end of the parse to the default sort
// (Size), and the time of a name sort of all rows after the parse.
//
// The latency budgets do not gate: only a wrong result makes the exit
// status 1.
//
// The tree order cases open an archive, send tree requests after "Listed", and
// report the time from "Listed" to the frame with the name order of the tree, the
// time to the default sort, the requests during that time, and the first rows.
// With `--tree-order-only`, it runs only these cases.
//
// Usage: node scripts/bench-sort.ts <archive.zip> [--json <out.json>] [--flat <archive.zip>]...
// The archive needs a `<archive.zip>.names.txt` manifest. Use a shuffled
// archive (`generate --shuffle`), so that name order is not archive order.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import type { Page } from "@playwright/test";
import { preview } from "vite";
import { openArchive, waitForOutcome } from "../e2e/listing.ts";
import { TARGET_BATCH_MS } from "../src/parse/batch.ts";

const args = process.argv.slice(2);
const optionValues = new Set(
  args.flatMap((arg, index) => (arg === "--json" || arg === "--flat" ? [index + 1] : [])),
);
const archive = args.find((arg, index) => !arg.startsWith("--") && !optionValues.has(index));
if (archive === undefined) {
  console.error("usage: bench-sort <archive.zip> [--json <out.json>] [--flat <archive.zip>]...");
  process.exit(2);
}
const jsonIndex = args.indexOf("--json");
const jsonOut = jsonIndex === -1 ? undefined : args[jsonIndex + 1];
const flatArchives = args.flatMap((arg, index) =>
  arg === "--flat" && args[index + 1] !== undefined ? [args[index + 1]!] : [],
);
const stopsOnly = args.includes("--stops-only");
const treeOrderOnly = args.includes("--tree-order-only");

/** The searches that match every generated name. The second does not
 *  contain the first, so it makes the listing again. */
const QUERY = "GENERATED";
const LATE_QUERY = "ENTRY-NAME";
/** Searches of the main archive after the parse. */
const SEARCH_CASES = [
  { label: "search that matches all rows", queries: [QUERY, LATE_QUERY] },
  { label: "search with few matches", queries: ["file-0000042", "module-042/component-07/"] },
];
/** One key at a time: all rows match first, and few rows match last. */
const TYPED_QUERY = "file-0000042";
/** The time between two view requests from the page. */
const REQUEST_INTERVAL_MS = 20;

/** Writes a stored zip with empty entries. `size` gives the size that the
 *  directory declares for an entry. */
function zip(names: string[], size?: (index: number) => number): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [index, text] of names.entries()) {
    const name = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(name.length, 28);
    if (size !== undefined) {
      central.writeUInt32LE(size(index), 20);
      central.writeUInt32LE(size(index), 24);
    }
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Math.min(names.length, 0xffff), 8);
  end.writeUInt16LE(Math.min(names.length, 0xffff), 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** Numbers 0 to `count` - 1 in a fixed order that is not sorted. */
function shuffled(count: number): number[] {
  return Array.from({ length: count }, (_, index) => (index * 7919) % count);
}

const COSTLY_CASES = [
  {
    label: "250,000 child folders",
    names: () => shuffled(250_000).map((n) => `d${String(n).padStart(7, "0")}/f`),
  },
  {
    label: "1,000 names with a 60,000-byte prefix",
    names: () => shuffled(1000).map((n) => `${"p".repeat(60_000)}${String(n).padStart(4, "0")}`),
  },
  {
    // A name and a query that repeat one byte made the old matcher slow.
    label: "100 names of 60,000 `a`s, searched for `a`s and `b`",
    names: () => shuffled(100).map((n) => `${"a".repeat(60_000)}${String(n).padStart(3, "0")}`),
    queries: [`${"a".repeat(30_000)}b`, `${"a".repeat(1024)}b`],
  },
  {
    // Each name matches, so each match also finds the place in the name.
    label: "100 names of 60,000 `a`s, each one matches",
    names: () => shuffled(100).map((n) => `${"a".repeat(60_000)}${String(n).padStart(3, "0")}`),
    queries: ["a".repeat(30_000), "a".repeat(1024)],
  },
  {
    // The first hit is in the folder part, and the base name is long too.
    label: "100 names of 30,000 `a`s, a slash and 30,000 `b`s",
    names: () => shuffled(100).map((n) => `${"a".repeat(30_000)}/${"b".repeat(30_000)}${n}`),
    queries: ["a".repeat(1024), `${"a".repeat(1024)}/${"b".repeat(1024)}`],
  },
  {
    // All leading zeros, so a comparison reads each run with no shortcut.
    label: "1,000 names of 60,000 zeros and a number",
    names: () => shuffled(1000).map((n) => `${"0".repeat(60_000)}${n}`),
  },
  {
    // Digit runs that are longer than any integer type.
    label: "1,000 names with a 60,000-digit number",
    names: () => shuffled(1000).map((n) => `${String(n).padStart(4, "0")}${"7".repeat(60_000)}`),
  },
];
const COSTLY_ROUNDS = 6;

// Runs in the page after the parse. Each round toggles the root tree row
// alone, then clicks the Name header (or, with `queries`, sets a search)
// and toggles the root row at once. A search is cleared after each round,
// so that each search scans all names again.
// The measured clicks sort by name, up or down. A click to archive order
// is not measured: its result is fast, and the page then lays out the new
// rows on the main thread, which delays the next reply. Returns the
// durations of the tree requests.
async function costlyRounds({ rounds, queries }: { rounds: number; queries?: string[] }) {
  const measures = () =>
    performance.getEntriesByName("zipscope:view-request") as PerformanceMeasure[];
  const settle = async (count: number) => {
    while (measures().length < count) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  const toggle = () =>
    document
      .querySelector<HTMLElement>('#tree-viewport [data-row="0"] [data-part="toggle"]')
      ?.click();
  const header = () => document.querySelector<HTMLElement>('[data-column="name"] button')?.click();
  const search = (value: string) => {
    const input = document.getElementById("search-input") as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const lastExpand = (from: number) =>
    measures()
      .slice(from)
      .filter((m) => m.detail === "expand")
      .map((m) => m.duration);
  const alone: number[] = [];
  const behind: number[] = [];
  const sorts: number[] = [];
  for (let round = 0; round < rounds; round++) {
    let from = measures().length;
    toggle();
    await settle(from + 1);
    alone.push(...lastExpand(from));
    from = measures().length;
    if (queries === undefined) {
      header();
    } else {
      search(queries[round % queries.length]!);
    }
    toggle();
    await settle(from + 2);
    behind.push(...lastExpand(from));
    sorts.push(
      ...measures()
        .slice(from)
        .filter((m) => m.detail === "sort" || m.detail === "search")
        .map((m) => m.duration),
    );
    if (queries !== undefined) {
      from = measures().length;
      search("");
      await settle(from + 1);
    } else if (
      document.querySelector('[data-column="name"]')?.getAttribute("aria-sort") === "descending"
    ) {
      from = measures().length;
      header();
      await settle(from + 1);
    }
  }
  return { alone, behind, sorts };
}

/** The tree order cases, after the main archive. `row` is the tree row that
 *  the requests open and close. It must not hide the listed folder. */
const TREE_ORDER_CASES = [
  {
    label: "250,000 child folders",
    row: 0,
    names: () => shuffled(250_000).map((n) => `d${String(n).padStart(7, "0")}/f`),
  },
  {
    label: "1,000 child folders with a 60,000-byte prefix",
    row: 0,
    names: () => shuffled(1000).map((n) => `${"p".repeat(60_000)}${String(n).padStart(4, "0")}/f`),
  },
];
/** The time that a case waits for the tree order after the default sort. A
 *  build with no tree order gets no such frame. */
const TREE_ORDER_WAIT_MS = 2000;

// Runs in the page before the archive opens. It marks the frame of the name
// order and the frame of the default sort. From "Listed" to the later of the
// two, it sends tree requests.
function watchTreeOrder({ row, interval }: { row: number; interval: number }) {
  const named = () => document.getElementById("tree-viewport")?.dataset.order === "name";
  const sorted = () =>
    document.querySelector('[data-column="size"]')?.getAttribute("aria-sort") === "descending";
  const marked = (name: string) => performance.getEntriesByName(name).length > 0;
  const watch = () => {
    if (!marked("zipscope:tree-order") && named()) performance.mark("zipscope:tree-order");
    if (!marked("zipscope:sort-landed") && sorted()) performance.mark("zipscope:sort-landed");
    if (!marked("zipscope:tree-order") || !marked("zipscope:sort-landed")) {
      requestAnimationFrame(watch);
    }
  };
  requestAnimationFrame(watch);
  const send = () => {
    if (marked("zipscope:tree-order") && marked("zipscope:sort-landed")) return;
    if (marked("zipscope:listed")) {
      document
        .querySelector<HTMLElement>(`#tree-viewport [data-row="${row}"] [data-part="toggle"]`)
        ?.click();
    }
    setTimeout(send, interval);
  };
  setTimeout(send, interval);
}

// Runs in the page after the parse. It types `query` one key at a time, and
// waits for the listing of each key. A tree request goes behind each key.
// It clears the search at the end. Returns the durations of the searches,
// and of the tree requests.
async function typedRound(query: string) {
  const measures = () =>
    performance.getEntriesByName("zipscope:view-request") as PerformanceMeasure[];
  const settle = async (count: number) => {
    while (measures().length < count) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  const search = (value: string) => {
    const input = document.getElementById("search-input") as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const toggle = () =>
    document
      .querySelector<HTMLElement>('#tree-viewport [data-row="0"] [data-part="toggle"]')
      ?.click();
  const searches: number[] = [];
  const behind: number[] = [];
  for (let length = 1; length <= query.length; length++) {
    const from = measures().length;
    search(query.slice(0, length));
    toggle();
    await settle(from + 2);
    for (const measure of measures().slice(from)) {
      (measure.detail === "search" ? searches : behind).push(measure.duration);
    }
  }
  const from = measures().length;
  search("");
  await settle(from + 1);
  return { searches, behind };
}

// Runs in the page before the open. When the first rows show, it sets the
// search. At `at` percent of the parse it clicks Cancel. It records the time
// from the click to the frame with the end of the parse, and to the frame with
// the last merge: there all parsed rows match, so the listing has them all.
function driveCancel({ query, at }: { query: string; at: number }) {
  const state = {
    clicked: 0,
    ended: 0,
    merged: 0,
    atEnd: { listed: 0, parsed: 0 },
    done: false,
  };
  (globalThis as { benchCancel?: typeof state }).benchCancel = state;
  let searched = false;
  const counts = () => ({
    listed: Number(document.getElementById("list-viewport")?.getAttribute("aria-rowcount")) - 1,
    parsed: Number(document.getElementById("row-count")?.textContent?.replace(/,/g, "")),
  });
  const tick = () => {
    const first = performance.getEntriesByName("zipscope:first-rows").length > 0;
    const progress = Number(
      document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") ?? 0,
    );
    if (first && !searched) {
      searched = true;
      const input = document.getElementById("search-input") as HTMLInputElement;
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (searched && state.clicked === 0 && progress >= at) {
      state.clicked = performance.now();
      document.getElementById("cancel-button")?.click();
    }
    if (state.clicked > 0) {
      const text = document.getElementById("status")?.textContent ?? "";
      if (state.ended === 0 && text.includes("Cancelled after")) state.ended = performance.now();
      const now = counts();
      if (
        state.ended > 0 &&
        (now.listed === now.parsed || performance.now() - state.ended > 3000)
      ) {
        state.merged = performance.now();
        state.atEnd = now;
        state.done = true;
        return;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Runs in the page before the open. At `at` percent of the parse it types the
// query one key at a time, with `interval` ms between the keys.
function driveKeys({ query, at, interval }: { query: string; at: number; interval: number }) {
  let typed = 0;
  let started = false;
  const key = () => {
    typed += 1;
    const input = document.getElementById("search-input") as HTMLInputElement;
    input.value = query.slice(0, typed);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (typed < query.length) setTimeout(key, interval);
  };
  const tick = () => {
    const progress = Number(
      document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") ?? 0,
    );
    if (!started && progress >= at) {
      started = true;
      key();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Measures a Cancel with rows waiting and keys during a parse, at varied
 *  sizes. */
async function stopCases(url: string, names: string[]) {
  const file = path.join(path.dirname(archive!), "sort-sized.zip");
  writeFileSync(
    file,
    zip(names, (index) => (index * 2654435761) % 2 ** 30),
  );
  const ms = (value: number) => `${value.toFixed(0)} ms`;
  const cancels: { ended: number; merged: number; parsed: number; listed: number }[] = [];
  for (let round = 0; round < 5; round++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(driveCancel, { query: QUERY, at: 30 + round * 10 });
    await openArchive(page, file);
    await page.waitForFunction(
      () => (globalThis as { benchCancel?: { done: boolean } }).benchCancel?.done,
      undefined,
      { timeout: 60_000 },
    );
    const result = await page.evaluate(() => {
      const state = (
        globalThis as unknown as {
          benchCancel: {
            clicked: number;
            ended: number;
            merged: number;
            atEnd: { listed: number; parsed: number };
          };
        }
      ).benchCancel;
      return {
        ended: state.ended - state.clicked,
        merged: state.merged - state.clicked,
        ...state.atEnd,
      };
    });
    cancels.push(result);
    await context.close();
  }
  console.log(`Cancel with rows waiting, ${names.length} rows of varied sizes, no sort chosen:`);
  for (const { ended, merged, parsed, listed } of cancels) {
    console.log(
      `  click to the end of the parse ${ms(ended)}, to the listing with all rows ${ms(merged)}: ${listed} of ${parsed}`,
    );
  }
  const keys: { searches: number[]; listedMs: number }[] = [];
  for (let round = 0; round < 3; round++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(driveKeys, { query: "generated-entry", at: 20, interval: 120 });
    await openArchive(page, file);
    const outcome = await waitForOutcome(page, 600_000);
    if (outcome.outcome !== "complete") {
      throw new Error(`keys during the parse: ${outcome.status}`);
    }
    await page.waitForTimeout(500);
    keys.push(
      await page.evaluate(() => {
        const marks = Object.fromEntries(
          performance.getEntriesByType("mark").map((m) => [m.name, m.startTime]),
        );
        return {
          searches: (performance.getEntriesByName("zipscope:view-request") as PerformanceMeasure[])
            .filter((m) => m.detail === "search")
            .map((m) => m.duration),
          listedMs: (marks["zipscope:listed"] ?? NaN) - (marks["zipscope:open"] ?? NaN),
        };
      }),
    );
    await context.close();
  }
  console.log("Keys during the parse, 120 ms apart, all rows match:");
  for (const { searches, listedMs } of keys) {
    const sorted = [...searches].sort((a, b) => a - b);
    console.log(
      `  listed in ${ms(listedMs)}, ${searches.length} searches, ${ms(sorted[0] ?? NaN)} to ${ms(sorted.at(-1) ?? NaN)}: ${searches.map((value) => value.toFixed(0)).join(", ")}`,
    );
  }
  return { cancels, keys };
}

interface Latency {
  requests: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Requests that took longer than 16 ms: two batches. */
  over16: number;
}

function latency(values: number[]): Latency {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    requests: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? 0,
    over16: sorted.filter((ms) => ms > 16).length,
  };
}

/** The order of a listing run: archive order that the user chose, no sort
 *  chosen, or a name sort. */
type RunOrder = "archive" | "none" | "name";

// Runs in the page. When the first rows show, it sets the search. For an
// archive order run, it first goes through the three steps of the Name
// header. At 40% of the parse it sorts by name (name runs only), at 70% it
// sets another search. It toggles the root tree row every `interval` ms until
// the listing ends. Each toggle is one `expand` view request.
function drive({
  query,
  lateQuery,
  order,
  interval,
}: {
  query: string;
  lateQuery: string;
  order: RunOrder;
  interval: number;
}) {
  const nameHeader = () => document.querySelector<HTMLElement>('[data-column="name"]');
  /** The states of the Name header after each click of the cycle. */
  const cycle: (string | null)[] = order === "archive" ? ["ascending", "descending", null] : [];
  let clicks = 0;
  const state = {
    started: false,
    sorted: false,
    searched: false,
    done: false,
    lateRows: [] as number[],
  };
  (globalThis as { benchSort?: typeof state }).benchSort = state;
  const search = (value: string) => {
    const input = document.getElementById("search-input") as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const rows = () => Number(document.getElementById("row-count")?.textContent?.replace(/,/g, ""));
  const tick = () => {
    const first = performance.getEntriesByName("zipscope:first-rows").length > 0;
    const listed = performance.getEntriesByName("zipscope:listed").length > 0;
    const progress = Number(
      document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") ?? 0,
    );
    if (first && clicks < cycle.length) {
      if (clicks === 0 || nameHeader()?.getAttribute("aria-sort") === (cycle[clicks - 1] ?? null)) {
        clicks += 1;
        nameHeader()?.querySelector("button")?.click();
      }
    } else if (
      first &&
      !state.started &&
      (clicks === 0 || nameHeader()?.getAttribute("aria-sort") === null)
    ) {
      state.started = true;
      search(query);
    }
    if (state.started && !state.sorted && progress >= 40) {
      state.sorted = true;
      if (order === "name") {
        state.lateRows.push(rows());
        document.querySelector<HTMLElement>('[data-column="name"] button')?.click();
      }
    }
    if (state.started && !state.searched && progress >= 70) {
      state.searched = true;
      state.lateRows.push(rows());
      search(lateQuery);
    }
    if (state.started && !listed) {
      document
        .querySelector<HTMLElement>('#tree-viewport [data-row="0"] [data-part="toggle"]')
        ?.click();
    }
    if (listed) {
      state.done = true;
      return;
    }
    setTimeout(tick, interval);
  };
  tick();
}

interface Run {
  order: RunOrder;
  listedMs: number;
  /** `expand` requests that started before the listing ended, and did
   *  not wait behind a search or sort request. */
  expand: number[];
  /** `expand` requests that waited behind a search or sort request. */
  behind: number[];
  /** The search and sort requests, which work on all parsed rows. */
  setup: { kind: string; ms: number }[];
  firstNames: string[];
  rowCount: number;
  /** Parsed rows when the late sort and search were requested. */
  lateRows: number[];
}

async function run(page: Page, url: string, order: RunOrder): Promise<Run> {
  await page.goto(url);
  await page.evaluate(drive, {
    query: QUERY,
    lateQuery: LATE_QUERY,
    order,
    interval: REQUEST_INTERVAL_MS,
  });
  await openArchive(page, archive!);
  const outcome = await waitForOutcome(page, 600_000);
  if (outcome.outcome !== "complete") {
    throw new Error(`parsing did not complete: ${outcome.status}`);
  }
  await page.waitForFunction(
    () => (globalThis as { benchSort?: { done: boolean } }).benchSort?.done,
  );
  // Wait for the frame that shows the final listing.
  await page.waitForTimeout(500);
  return page.evaluate((listed) => {
    const marks = Object.fromEntries(
      performance.getEntriesByType("mark").map((m) => [m.name, m.startTime]),
    );
    const listedAt = marks["zipscope:listed"] ?? Infinity;
    const measures = performance.getEntriesByName("zipscope:view-request") as PerformanceMeasure[];
    const labels = [...document.querySelectorAll<HTMLElement>("#list-viewport [data-row]")]
      .filter((row) => !row.hidden)
      .sort((a, b) => Number(a.dataset.row) - Number(b.dataset.row))
      .map((row) => row.querySelector<HTMLElement>('[data-part="label"]')?.title ?? "");
    return {
      order: listed,
      listedMs: listedAt - (marks["zipscope:open"] ?? 0),
      ...(() => {
        const full = measures.filter((m) => m.detail !== "expand");
        const during = measures.filter((m) => m.detail === "expand" && m.startTime < listedAt);
        const waited = (m: PerformanceMeasure) =>
          full.some(
            (f) => m.startTime < f.startTime + f.duration && m.startTime + m.duration > f.startTime,
          );
        return {
          expand: during.filter((m) => !waited(m)).map((m) => m.duration),
          behind: during.filter(waited).map((m) => m.duration),
        };
      })(),
      setup: measures
        .filter((m) => m.detail !== "expand")
        .map((m) => ({ kind: String(m.detail), ms: m.duration })),
      firstNames: labels.slice(0, 20),
      rowCount: Number(document.getElementById("list-viewport")?.getAttribute("aria-rowcount")) - 1,
      lateRows: (globalThis as unknown as { benchSort: { lateRows: number[] } }).benchSort.lateRows,
    };
  }, order);
}

const port = process.env.ZIPSCOPE_PORT;
const server = await preview({
  configFile: new URL("../vite.config.ts", import.meta.url).pathname,
  preview: { port: Number(port ?? 0), strictPort: port !== undefined, open: false },
  logLevel: "warn",
});
const browser = await chromium.launch({
  channel: process.env.BENCH_CHANNEL ?? "chromium",
  headless: true,
});
// Only a wrong run sets `failed`: a wrong listing or order, or a run that
// did not send all its requests. The latency budgets are goals that the
// nightly job reports; a slow runner does not fail the job.
let failed = false;
const budgets: { name: string; budget: string; value: string; ok: boolean }[] = [];

/** Runs one tree order case. Returns its result, for the JSON report. */
async function treeOrderCase(url: string, label: string, file: string, row: number) {
  const ms = (value: number) => `${value.toFixed(1)} ms`;
  const line = (l: Latency) =>
    `${l.requests} requests, p50 ${ms(l.p50)}, p95 ${ms(l.p95)}, max ${ms(l.max)}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(url);
  await page.evaluate(watchTreeOrder, { row, interval: REQUEST_INTERVAL_MS });
  await openArchive(page, file);
  const outcome = await waitForOutcome(page, 600_000);
  if (outcome.outcome !== "complete") {
    throw new Error(`${label}: parsing did not complete: ${outcome.status}`);
  }
  await page.waitForFunction(
    () => performance.getEntriesByName("zipscope:sort-landed").length > 0,
    { timeout: 600_000 },
  );
  await page
    .waitForFunction(() => performance.getEntriesByName("zipscope:tree-order").length > 0, {
      timeout: TREE_ORDER_WAIT_MS,
    })
    .catch(() => {});
  const result = await page.evaluate(() => {
    const at = (name: string) => performance.getEntriesByName(name)[0]?.startTime ?? NaN;
    const listed = at("zipscope:listed");
    const requests = performance.getEntriesByName("zipscope:view-request") as PerformanceMeasure[];
    return {
      firstRowsMs: at("zipscope:first-rows") - at("zipscope:open"),
      listedMs: listed - at("zipscope:open"),
      treeOrderMs: at("zipscope:tree-order") - listed,
      sortMs: at("zipscope:sort-landed") - listed,
      requests: requests.filter((m) => m.detail === "expand").map((m) => m.duration),
      store: document.getElementById("store-memory")?.textContent ?? "",
    };
  });
  // Row 0 is the listed folder here, so the rounds start no other listing.
  const rounds =
    row === 0 ? await page.evaluate(costlyRounds, { rounds: COSTLY_ROUNDS }) : undefined;
  await context.close();
  console.log(`${label}, tree order:`);
  console.log(
    `  first rows ${ms(result.firstRowsMs)}, listed ${ms(result.listedMs)}, tree order lands ${ms(result.treeOrderMs)} after that, default sort lands ${ms(result.sortMs)} after that`,
  );
  console.log(
    `  tree request from "Listed" to the last landing: ${line(latency(result.requests))}`,
  );
  if (rounds !== undefined) {
    console.log(`  tree request after the landing, alone: ${line(latency(rounds.alone))}`);
    console.log(
      `  tree request after the landing, behind a name sort: ${line(latency(rounds.behind))}`,
    );
  }
  return { label, ...result, rounds };
}

/** Runs the tree order cases. */
async function treeOrderCases(url: string) {
  const results = [];
  for (const [index, { label, row, names }] of TREE_ORDER_CASES.entries()) {
    const file = path.join(path.dirname(archive!), `tree-order-${index}.zip`);
    writeFileSync(file, zip(names()));
    results.push(await treeOrderCase(url, label, file, row));
  }
  // Row 2 is a child folder of the listed folder: it opens with no new listing.
  results.push(await treeOrderCase(url, path.basename(archive!), archive!, 2));
  return results;
}
try {
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) {
    throw new Error("the preview server has no local URL");
  }
  const names = readFileSync(`${archive}.names.txt`, "utf8").split("\n").slice(0, -1);
  if (treeOrderOnly) {
    await treeOrderCases(url);
    await browser.close();
    await server.close();
    process.exit(0);
  }
  if (stopsOnly) {
    await stopCases(url, names);
    await browser.close();
    await server.close();
    process.exit(0);
  }
  // The generated numbers of one place have the same length and no name
  // has an upper case letter, so here the name order is the byte order.
  const matches = names.filter((name) => name.toLowerCase().includes(LATE_QUERY.toLowerCase()));
  const expected = [...matches].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // Alternate the listings, so that all see the same load on the machine,
  // and pool the requests of all runs.
  const runCount = 3;
  const orders: RunOrder[] = ["archive", "none", "name"];
  const results: Run[] = [];
  for (let index = 0; index < runCount * orders.length; index++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    results.push(await run(await context.newPage(), url, orders[index % orders.length]!));
    await context.close();
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? NaN;
  const runs: Run[] = orders.map((order) => {
    const group = results.filter((result) => result.order === order);
    return {
      ...group.at(-1)!,
      listedMs: median(group.map((result) => result.listedMs)),
      expand: group.flatMap((result) => result.expand),
      behind: group.flatMap((result) => result.behind),
      setup: group.flatMap((result) => result.setup),
    };
  });
  const ms = (value: number) => `${value.toFixed(1)} ms`;
  const line = (l: Latency) =>
    `${l.requests} requests, p50 ${ms(l.p50)}, p95 ${ms(l.p95)}, p99 ${ms(l.p99)}, max ${ms(l.max)}, ${l.over16} over 16 ms`;
  const version = browser.version();
  console.log(`archive: ${archive} (${names.length} entries, headless Chromium ${version})`);
  console.log(
    `searches "${QUERY}", then "${LATE_QUERY}" at 70%, match ${expected.length} entries; a request every ${REQUEST_INTERVAL_MS} ms while parsing`,
  );
  const report: Record<string, unknown>[] = [];
  const labels: Record<RunOrder, string> = {
    archive: "archive order, chosen",
    none: "no sort chosen, incremental",
    name: "name sort, incremental",
  };
  const baseline = latency([...runs[0]!.expand, ...runs[0]!.behind]);
  // Allow one millisecond of clock and message noise at p95. The largest
  // request can add at most one batch to the archive-order maximum.
  const p95Limit = Math.max(TARGET_BATCH_MS, baseline.p95) + 1;
  const maxLimit = baseline.max + TARGET_BATCH_MS;
  for (const result of runs) {
    const label = labels[result.order];
    // All `expand` requests, also those that ran while a search or sort
    // request made its listing in steps.
    const stats = latency([...result.expand, ...result.behind]);
    const behind = latency(result.behind);
    const setup = result.setup.map((s) => `${s.kind} ${ms(s.ms)}`).join(", ");
    console.log(`${label}: listed in ${ms(result.listedMs)} (median of ${runCount} runs)`);
    console.log(`  late requests at parsed rows: ${result.lateRows.join(", ")} (last run)`);
    console.log(`  view-request latency during parse: ${line(stats)}`);
    console.log(`  of these, during a search or sort request: ${line(behind)}`);
    console.log(`  search and sort requests (time to their listing): ${setup}`);
    report.push({ label, listedMs: result.listedMs, latency: stats, behind, setup: result.setup });
    if (
      stats.requests === 0 ||
      !result.setup.some((request) => request.kind === "search") ||
      (result.order !== "none" && !result.setup.some((request) => request.kind === "sort")) ||
      result.lateRows.length !== (result.order === "name" ? 2 : 1)
    ) {
      failed = true;
      console.error("  the run did not exercise all mid-parse requests");
    }
    if (result.rowCount !== expected.length) {
      failed = true;
      console.error(`  the listing has ${result.rowCount} rows, expected ${expected.length}`);
    }
    if (result.order !== "archive") {
      const withinBudget = stats.p95 <= p95Limit && stats.max <= maxLimit;
      console.log(
        `  latency budget: p95 <= ${ms(p95Limit)}, max <= ${ms(maxLimit)}: ${withinBudget ? "within budget" : "over budget"}`,
      );
      budgets.push({
        name: label,
        budget: `p95 <= ${ms(p95Limit)}, max <= ${ms(maxLimit)}`,
        value: `p95 ${ms(stats.p95)}, max ${ms(stats.max)}`,
        ok: withinBudget,
      });
      // All names have the same tier and the size 0, so with no sort chosen
      // the rows stay in archive order.
      const order = result.order === "name" ? "name order" : "archive order";
      const want = (result.order === "name" ? expected : matches).slice(
        0,
        result.firstNames.length,
      );
      if (JSON.stringify(result.firstNames) !== JSON.stringify(want)) {
        failed = true;
        console.error(
          `  the first rows are not in ${order}:\n    ${result.firstNames.join("\n    ")}`,
        );
      } else {
        console.log(`  order check: the first ${want.length} rows are in ${order}`);
      }
    }
  }
  const searched: Record<string, unknown>[] = [];
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(url);
    await openArchive(page, archive);
    const outcome = await waitForOutcome(page, 600_000);
    if (outcome.outcome !== "complete" || outcome.rows !== names.length) {
      throw new Error(`searches: parsing did not complete: ${outcome.status}`);
    }
    for (const { label, queries } of SEARCH_CASES) {
      const result = await page.evaluate(costlyRounds, { rounds: COSTLY_ROUNDS, queries });
      const alone = latency(result.alone);
      const behind = latency(result.behind);
      const limit = alone.max + TARGET_BATCH_MS + 1;
      const pass = behind.max <= limit;
      console.log(`${label}, after the parse:`);
      console.log(`  tree request alone: ${line(alone)}`);
      console.log(`  tree request behind a search: ${line(behind)}`);
      console.log(`  search requests: ${result.sorts.map(ms).join(", ")}`);
      console.log(
        `  latency budget: max <= ${ms(limit)}: ${pass ? "within budget" : "over budget"}`,
      );
      budgets.push({
        name: `${label}, after the parse`,
        budget: `max <= ${ms(limit)}`,
        value: `max ${ms(behind.max)}`,
        ok: pass,
      });
      searched.push({ label, alone, behind, sorts: result.sorts });
    }
    const typed = await page.evaluate(typedRound, TYPED_QUERY);
    console.log(`"${TYPED_QUERY}", one key at a time, after the parse:`);
    console.log(`  search requests: ${typed.searches.map(ms).join(", ")}`);
    console.log(`  tree request behind a key: ${line(latency(typed.behind))}`);
    searched.push({ label: "typed", ...typed });
    await context.close();
  }
  const costly: Record<string, unknown>[] = [];
  for (const { label, names, queries } of COSTLY_CASES) {
    const file = path.join(path.dirname(archive), `sort-costly-${costly.length}.zip`);
    const list = names();
    writeFileSync(file, zip(list));
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(url);
    await openArchive(page, file);
    const outcome = await waitForOutcome(page, 600_000);
    if (outcome.outcome !== "complete" || outcome.rows !== list.length) {
      throw new Error(`${label}: parsing did not complete: ${outcome.status}`);
    }
    const result = await page.evaluate(costlyRounds, { rounds: COSTLY_ROUNDS, queries });
    await context.close();
    const alone = latency(result.alone);
    const behind = latency(result.behind);
    const limit = alone.max + TARGET_BATCH_MS + 1;
    // Too few requests is a wrong run. A slow request is only reported.
    if (behind.requests !== COSTLY_ROUNDS) {
      failed = true;
      console.error(`  ${behind.requests} requests behind a sort, expected ${COSTLY_ROUNDS}`);
    }
    const pass = behind.max <= limit;
    console.log(`${label}, after the parse:`);
    console.log(`  tree request alone: ${line(alone)}`);
    const kind = queries === undefined ? "name sort" : "search";
    console.log(`  tree request behind a ${kind}: ${line(behind)}`);
    console.log(`  ${kind} requests: ${result.sorts.map(ms).join(", ")}`);
    console.log(`  latency budget: max <= ${ms(limit)}: ${pass ? "within budget" : "over budget"}`);
    budgets.push({
      name: `${label}, after the parse`,
      budget: `max <= ${ms(limit)}`,
      value: `max ${ms(behind.max)}`,
      ok: pass,
    });
    costly.push({ label, alone, behind, sorts: result.sorts });
  }
  const flat: Record<string, unknown>[] = [];
  for (const file of flatArchives) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(url);
    // The size header has its arrow when the frame draws the default sort.
    await page.evaluate(() => {
      const watch = () => {
        const size = document.querySelector('[data-column="size"]');
        if (size?.getAttribute("aria-sort") === "descending") {
          performance.mark("zipscope:landed");
        } else {
          requestAnimationFrame(watch);
        }
      };
      requestAnimationFrame(watch);
    });
    await openArchive(page, file);
    const outcome = await waitForOutcome(page, 600_000);
    if (outcome.outcome !== "complete") {
      throw new Error(`${file}: parsing did not complete: ${outcome.status}`);
    }
    await page.waitForFunction(() => performance.getEntriesByName("zipscope:landed").length > 0, {
      timeout: 600_000,
    });
    const marks = await page.evaluate(() =>
      Object.fromEntries(performance.getEntriesByType("mark").map((m) => [m.name, m.startTime])),
    );
    const firstRowsMs = (marks["zipscope:first-rows"] ?? NaN) - (marks["zipscope:open"] ?? NaN);
    const listedMs = (marks["zipscope:listed"] ?? NaN) - (marks["zipscope:open"] ?? NaN);
    const landingMs = (marks["zipscope:landed"] ?? NaN) - (marks["zipscope:listed"] ?? NaN);
    const result = await page.evaluate(costlyRounds, { rounds: COSTLY_ROUNDS });
    await context.close();
    const behind = latency(result.behind);
    console.log(`${path.basename(file)} (${outcome.rows} rows, nearly all in the root folder):`);
    console.log(
      `  first rows ${ms(firstRowsMs)}, listed ${ms(listedMs)}, default sort lands ${ms(landingMs)} after that`,
    );
    console.log(`  name sort of all rows: ${result.sorts.map(ms).join(", ")}`);
    console.log(`  tree request alone: ${line(latency(result.alone))}`);
    console.log(`  tree request behind a name sort: ${line(behind)}`);
    flat.push({ file, firstRowsMs, listedMs, landingMs, sorts: result.sorts, behind });
  }
  const treeOrder = await treeOrderCases(url);
  // Last: these large archives raise the maximum of the requests after them.
  const stops = await stopCases(url, names);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined) {
    appendFileSync(
      summary,
      [
        `### Incremental sort benchmark: ${path.basename(archive)} (Chromium ${version})`,
        "",
        "| Listing | Listed | Requests | p50 | p95 | max |",
        "| --- | --- | --- | --- | --- | --- |",
        ...runs.map((r) => {
          const l = latency([...r.expand, ...r.behind]);
          return `| ${labels[r.order]} | ${ms(r.listedMs)} | ${l.requests} | ${ms(l.p50)} | ${ms(l.p95)} | ${ms(l.max)} |`;
        }),
        "",
        "| Latency budget | Budget | Value | Result |",
        "| --- | --- | --- | --- |",
        ...budgets.map(
          (b) =>
            `| ${b.name} | ${b.budget} | ${b.value} | ${b.ok ? "within budget" : "over budget"} |`,
        ),
        "",
      ].join("\n"),
    );
  }
  if (jsonOut !== undefined) {
    writeFileSync(
      jsonOut,
      JSON.stringify(
        { archive, chromium: version, report, stops, searched, costly, flat, treeOrder, budgets },
        null,
        2,
      ),
    );
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
