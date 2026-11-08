// The wayfinder table grows in chunks of 65,536 rows (2.5 MiB), not by
// doubling. Each scan call grows the read
// worker memory by at most one chunk. Its own file gives it a new wasm
// instance.
import { afterEach, expect, test, vi } from "vitest";
import { State } from "../contracts";
import * as readWasm from "../wasm/zipscope_read.js";
import { MiB, header, openWorker, readBytes, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
// A mocked module stays the same after `vi.resetModules`, so the worker
// gets the module that has the spies.
vi.mock("../wasm/zipscope_read.js", (importOriginal) => importOriginal());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("a large table grows by one chunk in each scan call", async () => {
  const rows = 1_000_001;
  const { bytes, page } = zip([{ name: "a.txt", body: new Uint8Array([0x61]) }], rows - 1);
  const slots = header(State.COMPLETE, rows);
  const original = readWasm.ReadArchive.prototype.scan;
  let last = -1;
  let largest = 0;
  let table = 0;
  vi.spyOn(readWasm.ReadArchive.prototype, "scan").mockImplementation(function (
    this: readWasm.ReadArchive,
    count: number,
  ) {
    const before = readBytes(slots);
    if (last >= 0) largest = Math.max(largest, before - last);
    last = before;
    const added = original.call(this, count);
    table = this.tableBytes();
    return added;
  });
  const api = await openWorker(mocks.expose, bytes, slots, page);
  await api.settled();
  largest = Math.max(largest, readBytes(slots) - last);
  // One chunk is 2.5 MiB. With doubling, one step of a table of 1M rows
  // (40 MB) would be about 16 MiB or more.
  expect(largest).toBeLessThanOrEqual(2.75 * MiB);
  // 16 chunks hold 1,000,001 rows, with no doubling room.
  expect(table).toBeLessThanOrEqual(16 * 2.5 * MiB + 64 * 1024);
}, 120_000);
