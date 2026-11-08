import { afterEach, expect, test, vi } from "vitest";
import {
  HEADER_BYTES,
  HEALTH_FIELDS,
  Header,
  LAYOUT_VERSION,
  SORT_DESCENDING,
  SortColumn,
  State,
  HealthField,
  Marks,
} from "../contracts";
import type { ParseWorkerApi } from "../contracts";
import { findings } from "../health/findings";
import { FakeStore } from "./fake-store";

const mocks = vi.hoisted(() => ({ expose: vi.fn(), init: vi.fn(), open: vi.fn(), full: false }));
vi.mock("comlink", () => ({ expose: mocks.expose }));
vi.mock("../wasm/zipscope_core.js", () => ({
  default: mocks.init,
  layoutVersion: () => LAYOUT_VERSION,
  memoryFull: () => mocks.full,
  memorySlack: () => 0,
  setMemorySlack: () => {},
  Parser: { open: mocks.open },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.full = false;
});

test("the control-name and wrapped counts have only the rows that a publish counted", async () => {
  vi.resetModules();
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(12 * 2 ** 20);
  store.queue([{ name: "kept\u202E", comment: "" }]);
  mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
  const vector = new Float64Array(HEALTH_FIELDS);
  vector[HealthField.CONTROL_NAME_ROWS] = 1;
  vector[HealthField.CONTROL_NAME_EXAMPLE] = 0;
  vector[HealthField.WRAPPED_ROWS] = 1;
  vector[HealthField.WRAPPED_EXAMPLE] = 0;
  vector[HealthField.INTO_DIRECTORY_ROWS] = 1;
  vector[HealthField.INTO_DIRECTORY_EXAMPLE] = 0;
  const markedFrom = vi.fn(() => 1);
  const intoDirectoryFrom = vi.fn(() => 1);
  mocks.open.mockReturnValue(
    Object.assign(store, {
      entriesHint: () => 1,
      health: () => vector.slice(),
      markedFrom,
      intoDirectoryFrom,
    }),
  );
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  // The publish fails at the hard stop, so the committed count stays 0.
  await api.open(
    new File([], "limit.zip"),
    { mirror() {} },
    { budget: { soft: 27 * 2 ** 20, hard: 28 * 2 ** 20 } },
  );
  const outcome = await api.finished();
  expect(outcome.rows).toBe(0);
  const report = await api.health();
  expect(markedFrom).toHaveBeenCalledWith(0, Marks.CONTROL_NAME);
  expect(markedFrom).toHaveBeenCalledWith(0, Marks.WRAPPED_OFFSET);
  expect(report.controlNames).toEqual({ rows: 0, example: -1 });
  expect(report.wrapped).toEqual({ rows: 0, example: -1 });
  expect(intoDirectoryFrom).toHaveBeenCalledWith(0);
  expect(report.intoDirectory).toEqual({ rows: 0, example: -1 });
});

test("a refused mirror allocation reports the hard stop and actual memory", async () => {
  vi.resetModules();
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(12 * 2 ** 20);
  store.queue([{ name: "kept", comment: "comment" }]);
  mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
  mocks.open.mockReturnValue(
    Object.assign(store, {
      entriesHint: () => 1,
      health: () => new Float64Array(HEALTH_FIELDS),
    }),
  );
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  const { header } = await api.open(
    new File([], "limit.zip"),
    { mirror() {} },
    {
      // The hard stop keeps 8 MiB for the read worker, so the store can
      // use 20 MiB.
      budget: { soft: 27 * 2 ** 20, hard: 28 * 2 ** 20 },
    },
  );
  const outcome = await api.finished();
  expect(outcome.kind).toBe("failed");
  expect(outcome.rows).toBe(0);
  const report = await api.health();
  expect(report.rows).toBe(0);
  expect(report.budget.hardReached).toBe(true);
  // The hard stop is one finding, not also a parse error.
  expect(report.error).toBeUndefined();
  expect(findings(report, outcome).map((finding) => finding.id)).toEqual(["memory-limit"]);
  expect(report.budget.storeBytes).toBe(16 * 2 ** 20 + HEADER_BYTES);
  expect(Atomics.load(new Int32Array(header), Header.STORE_KIB)).toBe(
    Math.ceil(report.budget.storeBytes / 1024),
  );
  expect(Atomics.load(new Int32Array(header), Header.STATE)).toBe(State.FAILED);
  // After the hard stop the worker refuses each view request, also when
  // the request could fit, so the UI can turn the view controls off.
  await expect(api.search("kept")).rejects.toThrow("memory limit");
  expect((await api.health()).budget.refused).toBe("search");
});

test("a rejected memory prompt remains in the health panel", async () => {
  vi.resetModules();
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(12 * 2 ** 20);
  mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
  mocks.open.mockReturnValue(
    Object.assign(store, {
      entriesHint: () => 1,
      health: () => new Float64Array(HEALTH_FIELDS),
    }),
  );
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  await api.open(
    new File([], "prompt.zip"),
    {
      mirror() {},
      confirmMemory: () => Promise.reject(new Error("prompt unavailable")),
    },
    { budget: { soft: 10 * 2 ** 20, hard: 30 * 2 ** 20 } },
  );
  const outcome = await api.finished();
  expect(outcome.kind).toBe("failed");
  const report = await api.health();
  expect(report.error).toContain("prompt unavailable");
  expect(findings(report, outcome).map((finding) => finding.id)).toContain("parse-error");
});

test("an archive open error is available in the health report", async () => {
  vi.resetModules();
  vi.stubGlobal("FileReaderSync", class {});
  mocks.init.mockResolvedValue({ memory: { buffer: new ArrayBuffer(65536) } });
  mocks.open.mockImplementation(() => {
    throw new Error("invalid end record");
  });
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  await expect(api.open(new File([], "broken.zip"), { mirror() {} })).rejects.toThrow(
    "invalid end record",
  );
  const outcome = await api.finished();
  const report = await api.health();
  expect(report.rows).toBe(0);
  expect(findings(report, outcome)[0]).toMatchObject({ id: "parse-error", severity: "error" });
  expect(report.error).toBe("invalid end record");
});

test("a view request cannot pass the hard limit while parsing is paused", async () => {
  vi.resetModules();
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(12 * 2 ** 20);
  store.queue(Array.from({ length: 10 }, (_, row) => `f${row}`));
  const parse = store.parse.bind(store);
  store.parse = (count) => parse(Math.min(count, 2));
  mocks.init.mockResolvedValue({
    memory: {
      get buffer() {
        return store.memory;
      },
    },
  });
  mocks.open.mockReturnValue(
    Object.assign(store, {
      entriesHint: () => 10,
      health: () => new Float64Array(HEALTH_FIELDS),
      sort() {
        store.grow(25 * 2 ** 20);
        return true;
      },
    }),
  );
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  const answer = Promise.withResolvers<boolean>();
  const confirm = vi.fn(() => answer.promise);
  const { header } = await api.open(
    new File([], "view-limit.zip"),
    { mirror() {}, confirmMemory: confirm },
    {
      // The hard stop keeps 8 MiB for the read worker.
      budget: { soft: 16 * 2 ** 20, hard: 30 * 2 ** 20 },
    },
  );
  await expect.poll(() => confirm.mock.calls.length).toBe(1);
  const before = Atomics.load(new Int32Array(header), Header.COMMITTED_ROWS);
  expect(before).toBe(2);
  const waiting = await api.health();
  expect(findings(waiting).some((finding) => finding.text.includes("when you chose"))).toBe(false);
  await expect(api.sort(1, false)).rejects.toThrow("memory limit");
  const outcome = await api.finished();
  expect(outcome).toMatchObject({ kind: "failed", rows: before });
  expect(Atomics.load(new Int32Array(header), Header.STATE)).toBe(State.FAILED);
  const report = await api.health();
  expect(report.budget.hardReached).toBe(true);
  expect(report.budget.storeBytes).toBeGreaterThan(report.budget.limits.hard);
  expect(report.budget.refused).toBe("sort");
  expect(report.error).toBeUndefined();
  expect(findings(report, outcome).map((finding) => finding.id)).toEqual(["memory-limit"]);
  expect(findings(report, outcome)[0]!.text).toMatch(
    /^The sort could not run at the 30.0\u00a0MiB memory limit\./,
  );
  answer.resolve(true);
  await Promise.resolve();
  expect(store.rows()).toBe(before);
});

test("a bounded view build stops at the first step that crosses the hard limit", async () => {
  vi.resetModules();
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(12 * 2 ** 20);
  store.queue(Array.from({ length: 10 }, (_, row) => `f${row}`));
  const parse = store.parse.bind(store);
  store.parse = (count) => parse(Math.min(count, 2));
  let building = false;
  let steps = 0;
  mocks.init.mockResolvedValue({
    memory: {
      get buffer() {
        return store.memory;
      },
    },
  });
  mocks.open.mockReturnValue(
    Object.assign(store, {
      entriesHint: () => 10,
      health: () => new Float64Array(HEALTH_FIELDS),
      sort() {
        building = true;
        return true;
      },
      viewsBuilding: () => building,
      mergePending: () => building,
      mergeViews() {
        steps++;
        store.grow((24 + steps) * 2 ** 20);
        if (steps === 3) building = false;
        return !building;
      },
    }),
  );
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  const answer = Promise.withResolvers<boolean>();
  const confirm = vi.fn(() => answer.promise);
  const { header } = await api.open(
    new File([], "bounded-view.zip"),
    { mirror() {}, confirmMemory: confirm },
    {
      // The hard stop keeps 8 MiB for the read worker.
      budget: { soft: 16 * 2 ** 20, hard: 30 * 2 ** 20 },
    },
  );
  await expect.poll(() => confirm.mock.calls.length).toBe(1);
  await expect(api.sort(1, false)).rejects.toThrow("memory limit");
  expect(steps).toBe(1);
  expect(await api.finished()).toMatchObject({ kind: "failed", rows: 2 });
  expect(Atomics.load(new Int32Array(header), Header.STATE)).toBe(State.FAILED);
  answer.resolve(true);
  await Promise.resolve();
  expect(steps).toBe(1);
});

test("a view request that published its listing does not fail at the limit", async () => {
  vi.resetModules();
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(12 * 2 ** 20);
  store.queue(["a", "b"]);
  let building = false;
  let armed = false;
  let requested = false;
  const version = store.permutationVersion.bind(store);
  mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
  mocks.open.mockReturnValue(
    Object.assign(store, {
      entriesHint: () => 2,
      health: () => new Float64Array(HEALTH_FIELDS),
      // The default sort at the end of the parse is not the request here.
      sort(_column: number, _descending: boolean) {
        if (!requested) return false;
        building = true;
        armed = true;
        return true;
      },
      viewsBuilding: () => building,
      mergePending: () => building,
      mergeViews() {
        building = false;
        return true;
      },
      // The publish of the sorted listing takes the last room below the
      // limit.
      permutationVersion() {
        if (armed) mocks.full = true;
        return version();
      },
    }),
  );
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  await api.open(new File([], "last-room.zip"), { mirror() {} });
  expect(await api.finished()).toMatchObject({ kind: "complete" });
  // The UI keeps the view state of a request that resolves, so the sort
  // resolves: its listing shows.
  requested = true;
  await expect(api.sort(1, false)).resolves.toBeUndefined();
  expect(mocks.full).toBe(true);
  // The next request does not fit.
  await expect(api.search("a")).rejects.toThrow("memory limit");
  const report = await api.health();
  expect(report.budget.refused).toBe("search");
  expect(findings(report, { kind: "complete", rows: 2 })[0]!.text).toBe(
    "The search could not run at the 2.00\u00a0GiB memory limit.",
  );
});

test("a request resolves when another request published its listing and filled memory", async () => {
  vi.resetModules();
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(12 * 2 ** 20);
  store.queue(["a", "b"]);
  let waiting = 0;
  let version = 0;
  mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
  mocks.open.mockReturnValue(
    Object.assign(store, {
      entriesHint: () => 2,
      health: () => new Float64Array(HEALTH_FIELDS),
      sort() {
        waiting = 3;
        return true;
      },
      // The search replaces the sort build. Its listing keeps the sort
      // column, so it is the listing of the sort too.
      search() {
        waiting = 1;
      },
      viewsBuilding: () => waiting > 0,
      mergePending: () => waiting > 0,
      mergeViews() {
        waiting--;
        if (waiting === 0) version++;
        return waiting === 0;
      },
      // The publish of the complete listing takes the last room below the
      // limit.
      permutationVersion() {
        if (version > 0) mocks.full = true;
        return version;
      },
    }),
  );
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  await api.open(new File([], "other-publish.zip"), { mirror() {} });
  expect(await api.finished()).toMatchObject({ kind: "complete" });
  // One merge step for each turn.
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 5));
  const sorted = api.sort(1, false);
  const searched = api.search("a");
  await expect(searched).resolves.toBeUndefined();
  await expect(sorted).resolves.toBeUndefined();
  expect(mocks.full).toBe(true);
  await expect(api.sort(2, false)).rejects.toThrow("memory limit");
});

test("the published sort is the sort of the listing, also when a later request is refused", async () => {
  // Sort A and sort B overlap, A publishes the listing of
  // B, and a search is refused before B wakes. B rejects, but its sort
  // shows, so the UI must read the sort from the published views.
  vi.resetModules();
  vi.stubGlobal("FileReaderSync", class {});
  const store = new FakeStore(12 * 2 ** 20);
  store.queue(["a", "b"]);
  let waiting = 0;
  let version = 0;
  mocks.init.mockResolvedValue({ memory: { buffer: store.memory } });
  mocks.open.mockReturnValue(
    Object.assign(store, {
      entriesHint: () => 2,
      health: () => new Float64Array(HEALTH_FIELDS),
      sort() {
        waiting = 2;
        return true;
      },
      // The search starts a build that does not fit.
      search() {
        waiting = 5;
        mocks.full = true;
      },
      viewsBuilding: () => waiting > 0,
      mergePending: () => waiting > 0,
      mergeViews() {
        waiting--;
        if (waiting === 0) version++;
        return waiting === 0;
      },
      permutationVersion: () => version,
    }),
  );
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  const { header } = await api.open(new File([], "refused-later.zip"), { mirror() {} });
  expect(await api.finished()).toMatchObject({ kind: "complete" });
  const slots = new Int32Array(header);
  const listed = () =>
    Atomics.load(
      slots,
      Atomics.load(slots, Header.ACTIVE_SET) === 0 ? Header.LISTING_SORT_0 : Header.LISTING_SORT_1,
    );
  expect(listed()).toBe(0);
  // One merge step for each turn.
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 5));
  const first = api.sort(SortColumn.NAME, false);
  const second = api.sort(SortColumn.SIZE, true);
  const settled = second.then(
    () => "resolved",
    () => "rejected",
  );
  await first;
  // The search runs before the second sort wakes.
  await expect(api.search("a")).rejects.toThrow("memory limit");
  // The second sort rejects, because the refused search changed the views
  // after the publish. The published sort is still the second sort.
  expect(await settled).toBe("rejected");
  expect(listed()).toBe(SortColumn.SIZE | SORT_DESCENDING);
});
