// The preload of the front door calls `warm` in each worker, and the
// archive can call `open` before the wasm loaded. Both must wait for one
// load: a second wasm instance would replace the exports while objects of
// the first instance still exist.
import { afterEach, expect, test, vi } from "vitest";
import type { ParseWorkerApi, ReadWorkerApi } from "../contracts";

const mocks = vi.hoisted(() => ({ expose: vi.fn(), coreInit: vi.fn(), readInit: vi.fn() }));
vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
vi.mock("../wasm/zipscope_core.js", () => ({
  default: mocks.coreInit,
  layoutVersion: () => -1,
  Parser: { open: vi.fn() },
}));
vi.mock("../wasm/zipscope_read.js", () => ({
  default: mocks.readInit,
  heapBytes: () => 0,
  memorySlack: () => 0,
  setMemoryCap: () => {},
  setMemorySlack: () => {},
  // The test stops the open after the load.
  ReadArchive: {
    open: () => {
      throw new Error("no archive in this test");
    },
  },
}));

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** Returns an init mock that completes only when `release` is called. */
function delayed(init: typeof mocks.coreInit) {
  const gate = Promise.withResolvers<{ memory: { buffer: ArrayBuffer } }>();
  init.mockReturnValue(gate.promise);
  return () => gate.resolve({ memory: { buffer: new ArrayBuffer(65536) } });
}

test("the parse worker loads its wasm one time for warm and open", async () => {
  vi.stubGlobal("FileReaderSync", class {});
  const release = delayed(mocks.coreInit);
  const workerPath = "../parse/worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls.at(-1)![0] as ParseWorkerApi;
  const warm = api.warm();
  const open = api.open(new File([], "a.zip"), { mirror() {} });
  open.catch(() => {});
  release();
  await warm;
  // The mock layout version is wrong, so the open fails after the load.
  await expect(open).rejects.toThrow("layout");
  expect(mocks.coreInit).toHaveBeenCalledTimes(1);
});

test("the read worker loads its wasm one time for warm and open", async () => {
  vi.stubGlobal("FileReaderSync", class {});
  const release = delayed(mocks.readInit);
  const workerPath = "../read/worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls.at(-1)![0] as ReadWorkerApi;
  const warm = api.warm();
  const open = api.open(new File([], "a.zip"), new SharedArrayBuffer(4096), []);
  open.catch(() => {});
  release();
  await warm;
  await expect(open).rejects.toThrow("no archive in this test");
  expect(mocks.readInit).toHaveBeenCalledTimes(1);
});

test("a failed load is tried again", async () => {
  const release = delayed(mocks.coreInit);
  mocks.coreInit.mockRejectedValueOnce(new Error("Failed to fetch"));
  const workerPath = "../parse/worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls.at(-1)![0] as ParseWorkerApi;
  await expect(api.warm()).rejects.toThrow("Failed to fetch");
  const again = api.warm();
  release();
  await again;
  expect(mocks.coreInit).toHaveBeenCalledTimes(2);
});
