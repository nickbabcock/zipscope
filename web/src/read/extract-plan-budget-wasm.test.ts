// The plan of a large folder at the memory limit of the read worker: the
// plan rejects with the memory error, and the wasm does not trap. Its own
// file gives it a new wasm instance.
import { afterEach, expect, test, vi } from "vitest";
import { State } from "../contracts";
import { MiB, encoder, giveNames, header, openWorker, setStore, total, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

test("a plan that fills the memory limit rejects with the memory error", async () => {
  const hard = 96 * MiB;
  const extra = 200_000;
  const { bytes, pages } = zip([{ name: "x/0", body: encoder.encode("one") }], extra);
  const rows = 1 + extra;
  const slots = header(State.COMPLETE, rows);
  // 40 MiB for the read worker: the wayfinder table (about 8 MiB) fits,
  // and the plan (about 500 bytes for each row) does not.
  setStore(slots, hard - 40 * MiB);
  const api = await openWorker(mocks.expose, bytes, slots, pages, hard);
  // Long names: 230 "a", the row number and ".txt".
  await giveNames(
    api,
    pages,
    Array.from({ length: rows }, (_, row) => `x/${"a".repeat(230)}${row}.txt`),
  );
  await api.settled();
  const error = await api.plan({ kind: "folder", path: "x/" }).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(String(error)).toMatch(/memory limit leaves no room/);
  expect(String(error)).not.toMatch(/read module|unreachable/);
  // Only the memory-limit text: no text of the Rust allocator.
  expect(String(error)).not.toMatch(/capacity|allocation/);
  expect(total(slots)).toBeLessThanOrEqual(hard);
  // The worker still answers: a small plan works after the error.
  const entry = await api.plan({ kind: "entry", row: 0 });
  expect(entry.files).toBe(1);
}, 120_000);
