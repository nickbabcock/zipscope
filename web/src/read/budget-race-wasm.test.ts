// An interleaving that failed before: the parse worker grows while a scan
// call of the read worker grows the wayfinder table. Before the shared
// reservations, each worker saw the memory of the other only after the
// other published it, so both used the same room and
// the total passed the hard stop (2,101.31 MiB at the 2,048 MiB stop). Now
// both reserve on the shared counter before they grow, so the total stays
// at or below the hard stop exactly. Its own file gives it a new wasm
// instance.
import { afterEach, expect, test, vi } from "vitest";
import { HARD_BUDGET_BYTES, Header, State, readReserve } from "../contracts";
import { Reservations } from "../memory";
import * as readWasm from "../wasm/zipscope_read.js";
import { MiB, header, openWorker, readBytes, reserved, setStore, total, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
// A mocked module stays the same after `vi.resetModules`, so the worker
// gets the module that has the spies.
vi.mock("../wasm/zipscope_read.js", (importOriginal) => importOriginal());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("a parse growth during a scan call stays within the hard stop exactly", async () => {
  const hard = HARD_BUDGET_BYTES;
  const { bytes, page } = zip([{ name: "a.txt", body: new Uint8Array([0x61]) }], 1_100_000);
  const slots = header(State.PARSING, 1_100_001);
  setStore(slots, 1870 * MiB);
  const parse = new Reservations(slots, hard, readReserve(hard));
  const original = readWasm.ReadArchive.prototype.scan;
  let interleaved = false;
  let largest = 0;
  vi.spyOn(readWasm.ReadArchive.prototype, "scan").mockImplementation(function (
    this: readWasm.ReadArchive,
    count: number,
  ) {
    if (!interleaved && this.tableBytes() > 32 * MiB) {
      // The read worker has set its cap for this call. Now the parse worker
      // grows to the largest store that its rule permits. Before, it used
      // the `READ_KIB` of the last call. Now its reservation sees the
      // read reservation of this moment.
      expect(parse.reserveStore(parse.storeRoom())).toBe(true);
      Atomics.store(new Int32Array(slots), Header.STORE_KIB, parse.storeBytes() / 1024);
      interleaved = true;
    }
    const added = original.call(this, count);
    const { store, read } = reserved(slots);
    largest = Math.max(largest, store + read);
    return added;
  });
  const api = await openWorker(mocks.expose, bytes, slots, page);
  await api.settled();
  expect(interleaved).toBe(true);
  // The reservations never passed the hard stop, and the memory in use is
  // not more than the reservations.
  expect(largest).toBeGreaterThan(1870 * MiB);
  expect(largest).toBeLessThanOrEqual(hard);
  const { store, read } = reserved(slots);
  expect(store + read).toBeLessThanOrEqual(hard);
  expect(readBytes(slots)).toBeLessThanOrEqual(read);
  expect(total(slots)).toBeLessThanOrEqual(hard);
  // The parse worker kept the reserve, so the table and a preview fit.
  const chunk = await api.read(0, 0, 16);
  expect(chunk.state).toBe("verified");
  expect(new TextDecoder().decode(chunk.bytes)).toBe("a");
  expect(reserved(slots).store + reserved(slots).read).toBeLessThanOrEqual(hard);
}, 120_000);
