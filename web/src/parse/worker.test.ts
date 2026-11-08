import { afterEach, expect, test, vi } from "vitest";
import { Header, LAYOUT_VERSION, SortColumn } from "../contracts";
import type { ParseWorkerApi } from "../contracts";
import { FakeStore } from "./fake-store";
import type { FileReaderAt, WindowReaderAt } from "./reader";

const mocks = vi.hoisted(() => ({
  expose: vi.fn(),
  init: vi.fn(),
  open: vi.fn(),
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test.for(["complete", "failed", "cancelled", "trap", "open", "setup"])(
  "releases the reader after %s",
  async (kind) => {
    vi.resetModules();
    vi.stubGlobal(
      "FileReaderSync",
      class {
        readAsArrayBuffer(blob: Blob) {
          return new ArrayBuffer(blob.size);
        }
      },
    );
    vi.stubGlobal("crypto", {
      getRandomValues: (values: Uint32Array) => {
        values.set([0x89abcdef, 0x12345678]);
        return values;
      },
    });
    const store = new FakeStore(64);
    if (kind === "failed") store.failAfterQueue("Bad record");
    if (kind === "trap") {
      store.parse = () => {
        throw new Error("Trap");
      };
    }
    mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
    let reader: WindowReaderAt | undefined;
    let probes: FileReaderAt | undefined;
    mocks.open.mockImplementation(
      (source: WindowReaderAt, _size: number, _seed: bigint, headers: FileReaderAt) => {
        reader = source;
        probes = headers;
        source.readAt(0, new Uint8Array(1));
        if (kind === "open") throw new Error("Open failed");
        return Object.assign(store, {
          entriesHint() {
            if (kind === "setup") throw new Error("Setup failed");
            return 0;
          },
        });
      },
    );
    const workerPath = "./worker";
    await import(workerPath);
    const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
    const file = new File([new Uint8Array(32)], "test.zip");
    const opening = api.open(file, { mirror() {} });
    if (kind === "open" || kind === "setup") {
      await expect(opening).rejects.toThrow();
    } else {
      const { header } = await opening;
      expect(reader!.retainedBytes).toBe(32);
      if (kind === "cancelled") Atomics.store(new Int32Array(header), Header.CANCEL, 1);
    }
    const result = await api.finished();
    expect(mocks.open).toHaveBeenCalledWith(reader, file.size, 0x1234567889abcdefn, probes);
    expect(result.kind).toBe(
      kind === "trap" || kind === "open" || kind === "setup" ? "failed" : kind,
    );
    expect(reader!.retainedBytes).toBe(0);
    expect(() => reader!.readAt(0, new Uint8Array(1))).toThrow("Reader is closed");
    expect(() => probes!.readAt(0, new Uint8Array(1))).toThrow("Reader is closed");
  },
);

test("publishes view requests after the reader closes", async () => {
  vi.resetModules();
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(32768);
  const list = vi.fn(() => true);
  const expand = vi.fn(() => true);
  const refresh = vi.spyOn(store, "refreshViews");
  const parser = Object.assign(store, { entriesHint: () => 0, list, expand });
  let reader: WindowReaderAt | undefined;
  mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
  mocks.open.mockImplementation((source: WindowReaderAt) => {
    reader = source;
    return parser;
  });
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  const mirror = vi.fn();
  const { header } = await api.open(new File([], "test.zip"), { mirror });
  await expect(api.finished()).resolves.toMatchObject({ kind: "complete" });
  expect(() => reader!.readAt(0, new Uint8Array(1))).toThrow("Reader is closed");
  expect(mirror.mock.calls.map(([value]) => value.kind)).toEqual([
    "folders",
    "rollups",
    "permutation",
    "permutationInfo",
    "tree",
    "rollups",
    "permutation",
    "permutationInfo",
    "tree",
  ]);

  store.setViews({
    folders: [0, 0, 0xffffffff, 0xffffffff],
    rollups: [42, 21, 1],
    permutation: [],
    permutationFolder: 0,
    tree: [0, 0, 0, 0],
  });
  const view = new Int32Array(header);
  const generation = Atomics.load(view, Header.VIEW_GENERATION);
  const refreshes = refresh.mock.calls.length;
  await api.list(0);
  await api.expand(0, true);
  expect(list).toHaveBeenCalledWith(0);
  expect(expand).toHaveBeenCalledWith(0, true);
  expect(refresh).toHaveBeenCalledTimes(refreshes + 2);
  // The list publishes the new views. The fake expand changes no view, and
  // the views that show are the views of the store, so it publishes
  // nothing.
  expect(Atomics.load(view, Header.VIEW_GENERATION)).toBe(generation + 1);
  expect(Atomics.load(view, Header.FOLDER_COUNT)).toBe(1);
  const active = Atomics.load(view, Header.ACTIVE_SET);
  const rollups = mirror.mock.calls.find(
    ([value]) => value.kind === "rollups" && value.set === active,
  )![0];
  expect([...new Float64Array(rollups.buffer).subarray(0, 3)]).toEqual([42, 21, 1]);
});

test("sort and search end their listing in steps after parsing, then publish", async () => {
  vi.resetModules();
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(32768);
  const calls: string[] = [];
  let waiting = 0;
  const parser = Object.assign(store, {
    entriesHint: () => 0,
    sort: vi.fn((column: number) => {
      calls.push(`sort ${column}`);
      waiting = 2;
      return column <= 6;
    }),
    search: vi.fn((query: string) => {
      calls.push(`search ${query}`);
      waiting = 1;
    }),
    mergePending: () => waiting > 0,
    viewsBuilding: () => waiting > 0,
    mergeViews: (budget: number) => {
      // Each step has a budget. 0 would end the work in one call.
      expect(budget).toBeGreaterThan(0);
      calls.push("step");
      waiting--;
      return waiting === 0;
    },
  });
  mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
  mocks.open.mockImplementation(() => parser);
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  const { header } = await api.open(new File([], "test.zip"), { mirror() {} });
  await api.finished();
  const view = new Int32Array(header);
  const generation = Atomics.load(view, Header.VIEW_GENERATION);
  calls.length = 0;
  await api.sort(SortColumn.NAME, true);
  await api.search("Readme");
  expect(calls).toEqual(["sort 1", "step", "step", "search Readme", "step"]);
  expect(parser.sort).toHaveBeenCalledWith(SortColumn.NAME, true);
  // One publish when the listing ends. The request then ends with no
  // second publish and no check that can fail it.
  expect(Atomics.load(view, Header.VIEW_GENERATION)).toBe(generation + 2);
  await expect(api.sort(99 as SortColumn, false)).rejects.toThrow("Sort column 99");
});

test("a tree request runs before a large sort finishes", async () => {
  vi.resetModules();
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(32768);
  let waiting = 0;
  const parser = Object.assign(store, {
    entriesHint: () => 0,
    sort: () => {
      waiting = 6;
      return true;
    },
    expand: vi.fn(() => true),
    mergePending: () => waiting > 0,
    viewsBuilding: () => waiting > 0,
    mergeViews: () => --waiting === 0,
  });
  mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
  mocks.open.mockImplementation(() => parser);
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  await api.open(new File([], "test.zip"), { mirror() {} });
  await api.finished();
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 5));
  let sorted = false;
  const sorting = api.sort(SortColumn.NAME, false).then(() => (sorted = true));
  await api.expand(0, true);
  expect(parser.expand).toHaveBeenCalledWith(0, true);
  expect(waiting).toBeGreaterThan(0);
  expect(sorted).toBe(false);
  await sorting;
  expect(waiting).toBe(0);
});

test("the job of the tree order and the default sort take turns, and requests are answered", async () => {
  vi.resetModules();
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(32768);
  const calls: string[] = [];
  let sorting = 0;
  let sortingTree = 0;
  const parser = Object.assign(store, {
    entriesHint: () => 0,
    defaultSort: () => {
      sorting = 12;
      return SortColumn.NAME;
    },
    startTreeOrder: () => {
      sortingTree = 12;
    },
    expand: vi.fn(() => true),
    mergePending: () => sorting > 0,
    viewsBuilding: () => sorting > 0,
    mergeViews: () => {
      calls.push("sort");
      return --sorting === 0;
    },
    treeOrderPending: () => sortingTree > 0,
    treeOrderStep: () => {
      calls.push("tree");
      return --sortingTree === 0;
    },
  });
  mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
  mocks.open.mockImplementation(() => parser);
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  // One small budget uses all the time of a step.
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 100));
  await api.open(new File([], "test.zip"), { mirror() {} });
  await api.finished();
  const settled = api.settleListing();
  const tree = api.settleTreeOrder();
  await api.expand(0, true);
  expect(parser.expand).toHaveBeenCalledWith(0, true);
  expect(sorting).toBeGreaterThan(0);
  expect(sortingTree).toBeGreaterThan(0);
  await Promise.all([settled, tree]);
  expect(sorting).toBe(0);
  expect(sortingTree).toBe(0);
  // While both have work, neither one makes two steps in a row.
  const lastOfFirstDone = Math.min(calls.lastIndexOf("sort"), calls.lastIndexOf("tree"));
  const overlap = calls.slice(0, lastOfFirstDone + 1);
  expect(overlap.length).toBeGreaterThan(20);
  overlap.forEach((call, index) => {
    if (index > 0) expect(call).not.toBe(overlap[index - 1]);
  });
});
