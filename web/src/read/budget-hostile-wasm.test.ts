// Hostile uses of the memory budget after a hard stop where the last parse
// batch took part of the reserve. Many rows are
// kept, and the reads ask for far rows, large windows and large outputs.
// Each read must give a clear failure or the data, the total must stay
// below the hard stop, and a small read must still work after the others.
// Its own file gives it a new wasm instance.
import { afterEach, expect, test, vi } from "vitest";
import { State } from "../contracts";
import { MiB, encoder, header, openWorker, rleFrame, setStore, total, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("far rows, large windows and large reads do not stop a small preview", async () => {
  // A hard stop of 32 MiB. The store took part of the 8 MiB reserve, as
  // in budget-overrun-wasm.test.ts. The parse worker kept 600,012 rows.
  const hard = 32 * MiB;
  const store = 29_164_544;
  const small = Array.from({ length: 10 }, (_, index) => ({
    name: `f${index}.txt`,
    body: encoder.encode(`body ${index}`),
  }));
  // A Zstandard frame with the largest window (32 MiB), and a stored
  // entry of 8 MiB.
  const blocks = 64;
  const block = 128 * 1024;
  const zstd = {
    name: "window.txt",
    body: new Uint8Array(blocks * block).fill(0x61),
    data: rleFrame(25, blocks, block),
    method: 93,
  };
  const large = { name: "large.bin", body: new Uint8Array(8 * MiB).fill(0x62) };
  const { bytes, pages } = zip([...small, zstd, large], 600_000);
  const rows = small.length + 2 + 600_000;
  const slots = header(State.FAILED, rows);
  setStore(slots, store);
  const api = await openWorker(mocks.expose, bytes, slots, pages, hard);
  await api.settled();
  expect(total(slots)).toBeLessThanOrEqual(hard);

  // The table of all rows does not fit. The read fails with a clear
  // reason.
  const far = await api.read(rows - 1, 0, 1024);
  expect(far.state).toBe("failed");
  expect(far.error).toMatch(/memory limit/);
  expect(total(slots)).toBeLessThanOrEqual(hard);

  // The far read grew the table only while the room of a read stayed
  // free, so a small read still fits.
  const first = await api.read(1, 0, 1024);
  expect(first.error).toBeUndefined();
  expect(text(first.bytes)).toBe("body 1");
  expect(first.state).toBe("verified");
  expect(total(slots)).toBeLessThanOrEqual(hard);

  // The 32 MiB window does not fit below the limit.
  const window = await api.read(small.length, 0, MiB);
  expect(window.state).toBe("failed");
  expect(window.error).toMatch(/memory|window/i);
  expect(total(slots)).toBeLessThanOrEqual(hard);

  // A read of 8 MiB does not fit either.
  const output = await api.read(small.length + 1, 0, 8 * MiB);
  expect(output.state).toBe("failed");
  expect(output.error).toMatch(/memory limit/);
  expect(total(slots)).toBeLessThanOrEqual(hard);

  // The far read again, and then a small read of a different row.
  expect((await api.read(rows - 1, 0, 1024)).state).toBe("failed");
  const last = await api.read(9, 0, 1024);
  expect(last.error).toBeUndefined();
  expect(text(last.bytes)).toBe("body 9");
  expect(last.state).toBe("verified");
  await api.settled();
  expect(total(slots)).toBeLessThanOrEqual(hard);
}, 60_000);

test("a Zstandard read with a small window works after a refused far read", async () => {
  // The room fits the start of the read module and a Zstandard frame with
  // a window of 128 KiB, but not the table of all rows. The refused read
  // of the far row keeps the room of one read free above the wasm memory.
  // It does not keep the room of the background pass (half the reserve)
  // free, so a later frame with a larger window can fail.
  const hard = 32 * MiB;
  const store = 29_164_544;
  const frame = rleFrame(17, 4, 128 * 1024);
  const zstd = {
    name: "small-window.txt",
    body: new Uint8Array(4 * 128 * 1024).fill(0x61),
    data: frame,
    method: 93,
  };
  const { bytes, pages } = zip([zstd], 600_000);
  const rows = 600_001;
  const slots = header(State.FAILED, rows);
  setStore(slots, store);
  const api = await openWorker(mocks.expose, bytes, slots, pages, hard);
  expect((await api.read(rows - 1, 0, 1024)).state).toBe("failed");
  const chunk = await api.read(0, 0, 64 * 1024);
  expect(chunk.error).toBeUndefined();
  expect(chunk.bytes.length).toBe(64 * 1024);
  expect(chunk.state).toBe("reading");
  expect(total(slots)).toBeLessThanOrEqual(hard);
}, 60_000);
