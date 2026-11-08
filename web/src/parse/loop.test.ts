import { describe, expect, test, vi } from "vitest";
import { CHUNK_BYTES, HEADER_BYTES, Header, Marks, PAGE_ROWS, State } from "../contracts";
import { MemoryLimitError } from "./budget";
import { FakeStore } from "./fake-store";
import { MERGE_INTERVAL_MS, parseInBatches, stepTreeOrder, TREE_ORDER_STEP_MS } from "./loop";
import { MirrorWriter } from "./publish";

function setup() {
  const store = new FakeStore(CHUNK_BYTES + PAGE_ROWS * 8 + 64);
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const writer = new MirrorWriter(
    header,
    () => {},
    () => store.memory,
  );
  return { store, header, view: new Int32Array(header), writer };
}

const names = (count: number) => Array.from({ length: count }, (_, i) => `f${i}`);

describe("stepTreeOrder", () => {
  test("stops at the step time, and returns true only for the last step", () => {
    let clock = 0;
    let left = 10;
    const parser = {
      treeOrderStep: (budget: number) => {
        expect(budget).toBeGreaterThan(0);
        clock += TREE_ORDER_STEP_MS / 2;
        return --left === 0;
      },
      treeOrderPending: () => left > 0,
    };
    const now = () => clock;
    expect(stepTreeOrder(parser, now)).toBe(false);
    expect(left).toBe(8);
    expect(stepTreeOrder(parser, now)).toBe(false);
    expect(left).toBe(6);
    clock = 0;
    left = 1;
    expect(stepTreeOrder(parser, now)).toBe(true);
  });

  test("stops when the job has no more work and did not end", () => {
    let calls = 0;
    const parser = {
      treeOrderStep: () => {
        calls++;
        return false;
      },
      treeOrderPending: () => false,
    };
    expect(stepTreeOrder(parser, () => 0)).toBe(false);
    expect(calls).toBe(1);
  });
});

describe("parseInBatches", () => {
  test("parses to the end and commits every row", async () => {
    const { store, header, view, writer } = setup();
    store.queue(names(5000));
    const outcome = await parseInBatches(store, writer, header);
    expect(outcome).toEqual({ kind: "complete", rows: 5000 });
    expect(Atomics.load(view, Header.STATE)).toBe(State.COMPLETE);
    expect(Atomics.load(view, Header.COMMITTED_ROWS)).toBe(5000);
    expect(Atomics.load(view, Header.PROGRESS)).toBe(1_000_000);
  });

  test("reports a terminal error and keeps the rows", async () => {
    const { store, header, view, writer } = setup();
    store.queue(names(100));
    store.failAfterQueue("bad record");
    const outcome = await parseInBatches(store, writer, header);
    expect(outcome).toEqual({ kind: "failed", rows: 100, message: "bad record" });
    expect(Atomics.load(view, Header.STATE)).toBe(State.FAILED);
    expect(Atomics.load(view, Header.COMMITTED_ROWS)).toBe(100);
  });

  test("stops at the next batch when the cancel flag is set", async () => {
    const { store, header, view, writer } = setup();
    store.queue(names(50_000));
    let batches = 0;
    const counting = {
      ...writer,
      publish: (source: FakeStore) => {
        writer.publish(source);
        batches++;
        if (batches === 2) {
          Atomics.store(view, Header.CANCEL, 1);
        }
      },
    };
    const outcome = await parseInBatches(store, counting, header, () => 0);
    expect(batches).toBe(2);
    expect(outcome.kind).toBe("cancelled");
    expect(outcome.rows).toBe(store.rows());
    expect(store.rows()).toBeLessThan(50_000);
    expect(Atomics.load(view, Header.STATE)).toBe(State.CANCELLED);
  });

  test("merges a sorted listing in separate steps, at most every 250 ms, and before the end", async () => {
    const { store, header, writer } = setup();
    store.queue(names(20_000));
    let clock = 0;
    const log: string[] = [];
    // A sorted listing: rows wait after each batch, and a merge takes
    // three steps.
    let waiting = false;
    let steps = 0;
    const parse = store.parse.bind(store);
    store.parse = (max) => {
      log.push(`parse ${clock}`);
      clock += 100;
      waiting = true;
      return parse(max);
    };
    store.mergePending = () => waiting || steps > 0;
    store.mergeViews = (budget) => {
      expect(budget).toBeGreaterThan(0);
      log.push(`merge ${clock}`);
      clock += 1;
      steps = (steps + 1) % 3;
      if (steps === 0) {
        waiting = false;
        return true;
      }
      return false;
    };
    const outcome = await parseInBatches(store, writer, header, () => clock);
    expect(outcome.kind).toBe("complete");
    // No merge before 250 ms. Each merge is three steps without a batch
    // between them. The last batch is followed by a final merge.
    const merges = log.filter((line) => line.startsWith("merge"));
    expect(merges.length).toBeGreaterThanOrEqual(6);
    expect(merges.length % 3).toBe(0);
    expect(log.at(-1)).toMatch(/^merge/);
    const lastParse = log.findLastIndex((line) => line.startsWith("parse"));
    let lastMerge = 0;
    for (const [index, line] of log.entries()) {
      const [kind, at] = line.split(" ") as [string, string];
      // The final merge after the last batch does not wait.
      if (kind === "merge" && index - 1 !== lastParse && log[index - 1]?.startsWith("parse")) {
        expect(Number(at) - lastMerge).toBeGreaterThanOrEqual(MERGE_INTERVAL_MS);
      }
      if (kind === "merge") {
        lastMerge = Number(at) + 1;
      }
    }
  });
});

test("final health checks yield and publish marks before finished resolves", async () => {
  const { store, header, view, writer } = setup();
  store.grow(store.memory.byteLength + PAGE_ROWS * 2);
  store.queue(["kept"]);
  const turn = Promise.withResolvers<void>();
  let steps = 0;
  let clock = 0;
  let settled = false;
  const parser = Object.assign(store, {
    finishChecks() {
      steps++;
      if (steps === 1) queueMicrotask(() => turn.resolve());
      if (steps === 20) store.markRow(0, Marks.OVERLAP);
      return steps === 20;
    },
  });
  const finished = parseInBatches(parser, writer, header, () => (clock += 4));
  void finished.then(() => {
    settled = true;
  });
  await turn.promise;
  expect(settled).toBe(false);
  expect(steps).toBeLessThan(20);
  expect(Atomics.load(view, Header.STATE)).toBe(State.PARSING);
  expect(await finished).toEqual({ kind: "complete", rows: 1 });
  expect(steps).toBe(20);
  expect(store.markUpdateCount()).toBe(0);
  expect(Atomics.load(view, Header.STATE)).toBe(State.COMPLETE);
});

test("a parser exception cannot publish rows beyond the committed prefix", async () => {
  const { store, header, view, writer } = setup();
  store.queue(["kept-one", "kept-two", "uncommitted", "unread"]);
  const parse = store.parse.bind(store);
  let calls = 0;
  store.parse = () => {
    calls++;
    if (calls === 1) return parse(2);
    parse(1);
    throw new Error("parse failed after append");
  };
  const outcome = await parseInBatches(store, writer, header);
  expect(outcome).toEqual({ kind: "failed", rows: 2, message: "parse failed after append" });
  expect(store.rows()).toBe(3);
  expect(Atomics.load(view, Header.COMMITTED_ROWS)).toBe(2);
  expect(Atomics.load(view, Header.STATE)).toBe(State.FAILED);
});

test("the end of the rows calls the hook one time, before the publish of the last rows", async () => {
  const { store, header } = setup();
  store.queue(["a", "b"]);
  const writer = { publish: vi.fn() };
  let published = -1;
  const onRowsEnd = vi.fn(() => {
    published = writer.publish.mock.calls.length;
    return false;
  });
  const outcome = await parseInBatches(store, writer, header, undefined, undefined, onRowsEnd);
  expect(outcome.kind).toBe("complete");
  expect(onRowsEnd).toHaveBeenCalledTimes(1);
  expect(onRowsEnd).toHaveBeenCalledWith(false);
  expect(writer.publish.mock.calls.length).toBeGreaterThan(published);
});

test("a large listing of the hook does not hold the end of the parse", async () => {
  const { store, header } = setup();
  store.queue(["a"]);
  store.mergePending = () => true;
  store.viewsBuilding = () => true;
  const mergeViews = vi.spyOn(store, "mergeViews");
  const outcome = await parseInBatches(
    store,
    { publish() {} },
    header,
    undefined,
    undefined,
    () => true,
  );
  expect(outcome.kind).toBe("complete");
  expect(mergeViews).not.toHaveBeenCalled();
});

test("a parse that the user stopped does not call the hook", async () => {
  const { store, header } = setup();
  store.queue(["a"]);
  Atomics.store(new Int32Array(header), Header.CANCEL, 1);
  const onRowsEnd = vi.fn(() => false);
  const outcome = await parseInBatches(
    store,
    { publish() {} },
    header,
    undefined,
    undefined,
    onRowsEnd,
  );
  expect(outcome.kind).toBe("cancelled");
  expect(onRowsEnd).not.toHaveBeenCalled();
});

/** A store with a sorted listing: rows wait after each batch, and a merge takes
 *  three steps. */
function waitingStore(store: FakeStore, log: string[]) {
  let waiting = false;
  let steps = 0;
  const parse = store.parse.bind(store);
  store.parse = (max) => {
    log.push("parse");
    waiting = true;
    return parse(max);
  };
  store.mergePending = () => waiting;
  store.mergeViews = () => {
    log.push("merge");
    steps = (steps + 1) % 3;
    if (steps === 0) waiting = false;
    return steps === 0;
  };
  return { waiting: () => waiting };
}

test("a cancel makes the last merge in steps, and then the parse ends", async () => {
  const { store, header, view, writer } = setup();
  store.queue(names(20_000));
  const log: string[] = [];
  const { waiting } = waitingStore(store, log);
  const parse = store.parse.bind(store);
  store.parse = (max) => {
    const count = parse(max);
    Atomics.store(view, Header.CANCEL, 1);
    return count;
  };
  const publish = vi.spyOn(writer, "publish");
  const outcome = await parseInBatches(store, writer, header, () => 0);
  expect(outcome.kind).toBe("cancelled");
  expect(waiting()).toBe(false);
  expect(log).toEqual(["parse", "merge", "merge", "merge"]);
  // The last publish has the merged listing.
  expect(publish).toHaveBeenLastCalledWith(store, true);
  expect(Atomics.load(view, Header.STATE)).toBe(State.CANCELLED);
});

test("a stop does not wait for a listing in steps, which ends after the parse", async () => {
  const { store, header, view, writer } = setup();
  store.queue(names(20_000));
  const log: string[] = [];
  waitingStore(store, log);
  store.viewsBuilding = () => true;
  const parse = store.parse.bind(store);
  store.parse = (max) => {
    const count = parse(max);
    Atomics.store(view, Header.CANCEL, 1);
    return count;
  };
  const outcome = await parseInBatches(store, writer, header, () => 0);
  expect(outcome.kind).toBe("cancelled");
  expect(log).toEqual(["parse"]);
});

test("the prompt shows after the last merge, and Stop has no rows left to merge", async () => {
  const { store, header, writer } = setup();
  store.queue(names(20_000));
  const log: string[] = [];
  const { waiting } = waitingStore(store, log);
  let used = 0;
  const parse = store.parse.bind(store);
  store.parse = (max) => {
    used = 10;
    return parse(max);
  };
  writer.allocatedBytes = () => used;
  let atPrompt: boolean | undefined;
  const outcome = await parseInBatches(store, writer, header, () => 0, {
    softBytes: 5,
    hardBytes: 2 ** 40,
    confirm: () => {
      atPrompt = waiting();
      log.push("prompt");
      return Promise.resolve(false);
    },
  });
  expect(outcome.kind).toBe("cancelled");
  expect(atPrompt).toBe(false);
  expect(log).toEqual(["parse", "merge", "merge", "merge", "prompt"]);
});

describe("the last merge at the hard stop", () => {
  /** Stops at the hard stop after the second batch, with the rows of the first
   *  batch published. `waits` is false when no row waits for a merge. */
  function stopped(
    publish: (source: unknown, last?: boolean) => void,
    { memoryFull = false, waits = true } = {},
  ) {
    const { store, header } = setup();
    store.queue(names(20_000));
    const log: string[] = [];
    const rows = waitingStore(store, log);
    const onRowsMissing = vi.fn();
    const onHardStop = vi.fn();
    let stop = 0;
    let batches = 0;
    const parse = store.parse.bind(store);
    store.parse = (max) => {
      batches += 1;
      if (batches === 2) stop = 100;
      return parse(max);
    };
    if (!waits) {
      // A view flag can keep `mergePending` true with no row that waits.
      store.rowsWaiting = () => false;
    } else {
      store.rowsWaiting = rows.waiting;
    }
    let behind = false;
    const writer = {
      publish(source: unknown, last?: boolean) {
        publish(source, last);
        behind = store.rowsWaiting();
      },
      listingBehind: () => behind,
      stopBytes: () => stop,
      allocatedBytes: () => 0,
    };
    const run = parseInBatches(store, writer as never, header, () => 0, {
      softBytes: 2 ** 40,
      hardBytes: 100,
      confirm: () => Promise.resolve(true),
      memoryFull: () => memoryFull && stop > 0,
      onHardStop,
      onRowsMissing,
    });
    return { run, log, rows, onRowsMissing, onHardStop };
  }

  test("runs when the room allows it, and no row is missing", async () => {
    const lastCalls: unknown[] = [];
    const test = stopped((_source, last) => {
      if (last === true) lastCalls.push(last);
    });
    const outcome = await test.run;
    expect(outcome.kind).toBe("failed");
    expect(test.rows.waiting()).toBe(false);
    expect(lastCalls).toHaveLength(1);
    expect(test.onRowsMissing).not.toHaveBeenCalled();
  });

  test("tells that rows are missing when the mirror has no room", async () => {
    const test = stopped((_source, last) => {
      if (last === true) throw new MemoryLimitError(100, 100);
    });
    const outcome = await test.run;
    expect(outcome.kind).toBe("failed");
    expect(test.onRowsMissing).toHaveBeenCalledTimes(1);
  });

  test("tells that rows are missing when the core has no room", async () => {
    const test = stopped(() => {}, { memoryFull: true });
    const outcome = await test.run;
    expect(outcome.kind).toBe("failed");
    // The core does no more work that grows, so the last merge does not run.
    expect(test.log).toEqual(["parse", "parse"]);
    expect(test.onRowsMissing).toHaveBeenCalledTimes(1);
  });

  test("says nothing when the published listing has the rows", async () => {
    // Other work waits, and the core has no room, so no merge runs. No row of
    // the status is absent from the listing.
    const test = stopped(() => {}, { memoryFull: true, waits: false });
    const outcome = await test.run;
    expect(outcome.kind).toBe("failed");
    expect(test.onRowsMissing).not.toHaveBeenCalled();
  });
});
