/*
ASSUMED API
MirrorSink.confirmMemory(usage: { rows: number; bytes: number }): Promise<boolean>
MirrorWriter.allocatedBytes(): number

The worker must use the Comlink sink for the budget question. Use 1 GiB
and 2 GiB as the default limits. Keep finished pending during the question.
Cancellation must not wait for the answer. A refusal cancels. An approval
cannot bypass the hard limit. These tests replace the parser and writer
to report large memory use without large allocations.
The names may change. Record a reason for a change to an expected result.
*/

import { afterEach, expect, test, vi } from "vitest";
import { CHUNK_BYTES, Header, LAYOUT_VERSION, State } from "../contracts";
import type { ParseWorkerApi } from "../contracts";
import { FakeStore } from "./fake-store";

const mocks = vi.hoisted(() => ({
  expose: vi.fn(),
  init: vi.fn(),
  open: vi.fn(),
  hard: false,
  /** The memory that the writer reports, when a test sets it. */
  allocated: undefined as number | undefined,
  stop: undefined as number | undefined,
}));

vi.mock("comlink", () => ({ expose: mocks.expose }));
vi.mock("../wasm/zipscope_core.js", () => ({
  default: mocks.init,
  layoutVersion: () => LAYOUT_VERSION,
  memoryFull: () => false,
  memorySlack: () => 0,
  setMemorySlack: () => {},
  Parser: { open: mocks.open },
}));
vi.mock("./publish", () => ({
  MirrorWriter: class {
    private bytes = 0;
    private batches = 0;
    private readonly slots: Int32Array;

    constructor(header: SharedArrayBuffer) {
      this.slots = new Int32Array(header);
    }

    allocatedBytes() {
      return mocks.allocated ?? this.bytes;
    }

    stopBytes() {
      return mocks.stop ?? this.bytes;
    }

    shows() {
      return true;
    }

    publish(source: { rows(): number }) {
      this.batches++;
      this.bytes = mocks.hard && this.batches > 1 ? 2 ** 31 : 2 ** 30;
      Atomics.store(this.slots, Header.STORE_KIB, this.bytes / 1024);
      Atomics.store(this.slots, Header.COMMITTED_ROWS, source.rows());
    }
  },
}));

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const release of cleanup.splice(0)) release();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.allocated = undefined;
  mocks.stop = undefined;
});

test.for(["continue", "refuse", "cancel", "hard"] as const)(
  "the exposed worker connects the memory prompt and handles %s",
  async (action) => {
    vi.resetModules();
    mocks.hard = action === "hard";
    vi.stubGlobal("FileReaderSync", class {});
    const store = new FakeStore(CHUNK_BYTES + 2 ** 20);
    store.queue(Array.from({ length: 10 }, (_, row) => `f${row}`));
    const parse = store.parse.bind(store);
    const calls = vi.spyOn(store, "parse").mockImplementation((limit) => parse(Math.min(limit, 2)));
    mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
    mocks.open.mockReturnValue(Object.assign(store, { entriesHint: () => 10 }));
    const workerPath = "./worker";
    await import(workerPath);
    const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
    const answer = Promise.withResolvers<boolean>();
    const confirmMemory = vi.fn(() => answer.promise);
    const { header } = await api.open(new File([], "budget.zip"), {
      mirror() {},
      confirmMemory,
    });
    const slots = new Int32Array(header);
    cleanup.push(() => {
      Atomics.store(slots, Header.CANCEL, 1);
      answer.resolve(false);
    });
    const finished = api.finished();
    let settled = false;
    void finished.then(() => {
      settled = true;
    });
    await expect.poll(() => confirmMemory.mock.calls.length, { timeout: 1000 }).toBe(1);
    const rows = Atomics.load(slots, Header.COMMITTED_ROWS);
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(10);
    expect(confirmMemory).toHaveBeenCalledWith({ rows, bytes: 2 ** 30 });
    expect(Atomics.load(slots, Header.STATE)).toBe(State.PAUSED);
    expect(settled).toBe(false);
    const batches = calls.mock.calls.length;
    if (action === "cancel") {
      Atomics.store(slots, Header.CANCEL, 1);
    } else {
      answer.resolve(action !== "refuse");
    }
    const result = await finished;
    expect(result.kind).toBe(
      action === "continue" ? "complete" : action === "hard" ? "failed" : "cancelled",
    );
    expect(confirmMemory).toHaveBeenCalledTimes(1);
    if (action === "continue") {
      expect(result.rows).toBe(10);
    } else if (action === "hard") {
      expect(result.rows).toBeGreaterThan(rows);
      expect(result.rows).toBeLessThan(10);
      expect(Atomics.load(slots, Header.STATE)).toBe(State.FAILED);
    } else {
      expect(result.rows).toBe(rows);
      expect(calls).toHaveBeenCalledTimes(batches);
      expect(Atomics.load(slots, Header.STATE)).toBe(State.CANCELLED);
    }
  },
);

// The default sort of 10 rows needs 320 bytes, 32 bytes for each row.
const SOFT = 2 ** 30;
const HARD = 2 ** 31;
const NEED = 320;

/** Parses 10 rows with these bytes in use. Returns the sort spy and the prompt. */
async function parseWith(allocated: number, stop: number, answer = true) {
  vi.resetModules();
  mocks.hard = false;
  mocks.allocated = allocated;
  mocks.stop = stop;
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(CHUNK_BYTES + 2 ** 20);
  store.queue(Array.from({ length: 10 }, (_, row) => `f${row}`));
  store.setViews({
    folders: [0, 0, 0xffffffff, 0xffffffff],
    rollups: [0, 0, 0],
    permutation: [],
    permutationFolder: 0,
    tree: [0, 0, 0, 0],
  });
  const sort = vi.spyOn(store, "defaultSort");
  const treeOrder = vi.spyOn(store, "startTreeOrder");
  mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
  mocks.open.mockReturnValue(Object.assign(store, { entriesHint: () => 10 }));
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  const confirmMemory = vi.fn(() => Promise.resolve(answer));
  await api.open(
    new File([], "budget.zip"),
    { mirror() {}, confirmMemory },
    { budget: { soft: SOFT, hard: HARD } },
  );
  const result = await api.finished();
  expect(result.kind).toBe("complete");
  expect(result.rows).toBe(10);
  return { sort, treeOrder, confirmMemory };
}

test.for([
  ["one byte below the soft budget starts", SOFT - NEED - 1, 0, true],
  ["at the soft budget does not start", SOFT - NEED, 0, false],
  ["one byte below the hard stop starts", 0, HARD - NEED - 1, true],
  ["at the hard stop does not start", 0, HARD - NEED, false],
] as const)("the default sort %s, with no prompt", async ([, allocated, stop, starts]) => {
  const { sort, confirmMemory } = await parseWith(allocated, stop);
  expect(confirmMemory).not.toHaveBeenCalled();
  if (starts) {
    expect(sort).toHaveBeenCalledTimes(1);
  } else {
    expect(sort).not.toHaveBeenCalled();
  }
});

// The job of the tree order needs 16 bytes for the one folder of the fake, and
// the default sort of the fake does not start. At each edge, no prompt shows
// and the tree stays in archive order.
test.for([
  ["one byte below the soft budget starts", SOFT - 16 - 1, 0, true],
  ["at the soft budget does not start", SOFT - 16, 0, false],
  ["one byte below the hard stop starts", 0, HARD - 16 - 1, true],
  ["at the hard stop does not start", 0, HARD - 16, false],
] as const)("the tree order %s, with no prompt", async ([, allocated, stop, starts]) => {
  const { treeOrder, confirmMemory } = await parseWith(allocated, stop);
  expect(confirmMemory).not.toHaveBeenCalled();
  expect(treeOrder).toHaveBeenCalledTimes(starts ? 1 : 0);
});

test("after the user accepts the prompt, only the hard stop limits the tree order", async () => {
  const over = await parseWith(SOFT, 0);
  expect(over.confirmMemory).toHaveBeenCalledTimes(1);
  expect(over.treeOrder).toHaveBeenCalledTimes(1);
  mocks.expose.mockClear();
  const stopped = await parseWith(SOFT, HARD - 16);
  expect(stopped.confirmMemory).toHaveBeenCalledTimes(1);
  expect(stopped.treeOrder).not.toHaveBeenCalled();
});

/** Parses with the parse stopped by the test. Returns the spy of the job. */
async function stopParse(kind: "cancel" | "stop", allocated: number) {
  vi.resetModules();
  mocks.hard = false;
  mocks.allocated = allocated;
  mocks.stop = 0;
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(CHUNK_BYTES + 2 ** 20);
  store.queue(Array.from({ length: 10 }, (_, row) => `f${row}`));
  const treeOrder = vi.spyOn(store, "startTreeOrder");
  mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
  mocks.open.mockReturnValue(Object.assign(store, { entriesHint: () => 10 }));
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  const { header } = await api.open(
    new File([], "budget.zip"),
    {
      mirror() {},
      // A cancel does not wait for an answer.
      confirmMemory: () =>
        kind === "stop" ? Promise.resolve(false) : Promise.withResolvers<boolean>().promise,
    },
    { budget: { soft: SOFT, hard: HARD } },
  );
  if (kind === "cancel") Atomics.store(new Int32Array(header), Header.CANCEL, 1);
  const result = await api.finished();
  await api.settleTreeOrder();
  return { result, treeOrder };
}

test("a parse that fails with a parse error gets the tree order", async () => {
  vi.resetModules();
  mocks.hard = false;
  mocks.allocated = 0;
  mocks.stop = 0;
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(CHUNK_BYTES + 2 ** 20);
  store.queue(Array.from({ length: 10 }, (_, row) => `f${row}`));
  store.failAfterQueue("Bad record");
  const treeOrder = vi.spyOn(store, "startTreeOrder");
  mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
  mocks.open.mockReturnValue(Object.assign(store, { entriesHint: () => 10 }));
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  await api.open(
    new File([], "budget.zip"),
    { mirror() {} },
    { budget: { soft: SOFT, hard: HARD } },
  );
  const result = await api.finished();
  expect(result.kind).toBe("failed");
  expect(treeOrder).toHaveBeenCalledTimes(1);
});

test("a cancelled parse gets the tree order when it has room", async () => {
  const { result, treeOrder } = await stopParse("cancel", 0);
  expect(result.kind).toBe("cancelled");
  expect(treeOrder).toHaveBeenCalledTimes(1);
});

test("a cancel at the soft budget leaves the tree in archive order", async () => {
  // The prompt waits, and the cancel flag is set: the person did not accept.
  const { result, treeOrder } = await stopParse("cancel", SOFT);
  expect(result.kind).toBe("cancelled");
  expect(treeOrder).not.toHaveBeenCalled();
});

test("Stop at the memory prompt leaves the tree in archive order", async () => {
  const { result, treeOrder } = await stopParse("stop", SOFT);
  expect(result.kind).toBe("cancelled");
  expect(treeOrder).not.toHaveBeenCalled();
});

test("the hard stop leaves the tree in archive order", async () => {
  vi.resetModules();
  mocks.hard = false;
  mocks.allocated = 0;
  mocks.stop = HARD;
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(CHUNK_BYTES + 2 ** 20);
  store.queue(Array.from({ length: 10 }, (_, row) => `f${row}`));
  const treeOrder = vi.spyOn(store, "startTreeOrder");
  mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
  mocks.open.mockReturnValue(Object.assign(store, { entriesHint: () => 10 }));
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  await api.open(
    new File([], "budget.zip"),
    { mirror() {} },
    { budget: { soft: SOFT, hard: HARD } },
  );
  const result = await api.finished();
  expect(result.kind).toBe("failed");
  await api.settleTreeOrder();
  expect(treeOrder).not.toHaveBeenCalled();
});

test("the job stops at the hard stop, and the tree stays in archive order", async () => {
  vi.resetModules();
  mocks.hard = false;
  mocks.allocated = 0;
  mocks.stop = 0;
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(CHUNK_BYTES + 2 ** 20);
  store.queue(Array.from({ length: 10 }, (_, row) => `f${row}`));
  // A job that needs many steps, each with all the time of a turn. The memory
  // limit comes during it.
  let clock = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += 100));
  let left = 1000;
  const steps = vi.fn(() => {
    left--;
    return left === 0;
  });
  const parser = Object.assign(store, {
    entriesHint: () => 10,
    treeOrderPending: () => left > 0,
    treeOrderStep: steps,
    // The first request sees the hard stop.
    list: () => {
      mocks.stop = HARD;
      return true;
    },
  });
  mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
  mocks.open.mockReturnValue(parser);
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  await api.open(
    new File([], "budget.zip"),
    { mirror() {} },
    { budget: { soft: SOFT, hard: HARD } },
  );
  await api.finished();
  await expect(api.list(0)).rejects.toThrow();
  await api.settleTreeOrder();
  expect(left).toBeGreaterThan(0);
  const made = steps.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(steps.mock.calls.length).toBe(made);
  now.mockRestore();
});

test("after the user accepts the prompt, only the hard stop limits the default sort", async () => {
  const over = await parseWith(SOFT, 0);
  expect(over.confirmMemory).toHaveBeenCalledTimes(1);
  expect(over.sort).toHaveBeenCalledTimes(1);
  mocks.expose.mockClear();
  const stopped = await parseWith(SOFT, HARD - NEED);
  expect(stopped.confirmMemory).toHaveBeenCalledTimes(1);
  expect(stopped.sort).not.toHaveBeenCalled();
});
