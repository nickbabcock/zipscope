// The zip of a folder when the store takes all but the reserve of the
// read worker: the zip does not fit, and the extraction fails
// before it writes a byte. Its own file gives it a new wasm instance.
import { afterEach, expect, test, vi } from "vitest";
import { PROGRESS_BYTES, State, readReserve } from "../contracts";
import { MiB, encoder, giveNames, header, openWorker, setStore, total, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

test("a zip that does not fit the memory limit fails before it writes", async () => {
  const hard = 96 * MiB;
  const extra = 60_000;
  const { bytes, pages } = zip([{ name: "x/0000000", body: encoder.encode("one") }], extra);
  const rows = 1 + extra;
  const slots = header(State.COMPLETE, rows);
  setStore(slots, hard - readReserve(hard));
  const api = await openWorker(mocks.expose, bytes, slots, pages, hard);
  await giveNames(
    api,
    pages,
    Array.from({ length: rows }, () => "x/0000000"),
  );
  await api.settled();
  const plan = await api.plan({ kind: "folder", path: "x/" });
  expect(plan.zipError).toContain("memory limit");
  const progress = new SharedArrayBuffer(PROGRESS_BYTES);
  const report = await api.extract(plan.id, { kind: "blob" }, progress);
  expect(report.outcome).toBe("failed");
  expect(report.error).toContain("memory limit");
  expect(report.written).toBe(0);
  expect(report.blob).toBeUndefined();
  expect(total(slots)).toBeLessThanOrEqual(hard);
}, 120_000);
