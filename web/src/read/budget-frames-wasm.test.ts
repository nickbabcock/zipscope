// A later Zstandard frame with a larger window, after the store grew
// between two reads. The window limit
// applies to each frame that starts, with the limit of that read. Its own
// file gives it a new wasm instance.
import { afterEach, expect, test, vi } from "vitest";
import { State } from "../contracts";
import { MiB, header, openWorker, setStore, total, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A Zstandard frame of RLE blocks of `a`, with a window of `2^log`. */
function rleFrame(log: number, blocks: number, block: number): Uint8Array {
  const frame = new Uint8Array(6 + blocks * 4);
  new DataView(frame.buffer).setUint32(0, 0xfd2fb528, true);
  frame[5] = (log - 10) << 3;
  for (let index = 0; index < blocks; index++) {
    const value = (index + 1 === blocks ? 1 : 0) | (1 << 1) | (block << 3);
    frame.set([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, 0x61], 6 + index * 4);
  }
  return frame;
}

test("a later frame with a larger window stays below the hard stop", async () => {
  // A case that failed before: a 40 MiB hard stop, and the store grows from
  // 10 to 32 MiB between the reads. The first frame has a 1 MiB window and
  // the second frame a 16 MiB window. Before the fix, the second read
  // allocated the 16 MiB window and the total was 52.56 MiB.
  const hard = 40 * MiB;
  const first = rleFrame(20, 8, 128 * 1024);
  const second = rleFrame(24, 8, 128 * 1024);
  const data = new Uint8Array(first.length + second.length);
  data.set(first);
  data.set(second, first.length);
  const body = new Uint8Array(2 * MiB).fill(0x61);
  const { bytes, page } = zip([{ name: "frames.txt", body, data, method: 93 }]);
  const slots = header(State.COMPLETE, 1);
  setStore(slots, 10 * MiB);
  const api = await openWorker(mocks.expose, bytes, slots, page, hard);
  const chunk = await api.read(0, 0, MiB);
  expect(chunk.state).toBe("reading");
  expect(chunk.bytes.length).toBe(MiB);
  expect(total(slots)).toBeLessThanOrEqual(hard);

  setStore(slots, 32 * MiB);
  const next = await api.read(0, MiB, MiB);
  expect(next.state).toBe("failed");
  expect(next.error).toMatch(/memory|window/i);
  expect(total(slots)).toBeLessThanOrEqual(hard);
});

test("the same stream decodes both frames when the limit leaves room", async () => {
  const hard = 64 * MiB;
  const first = rleFrame(20, 8, 128 * 1024);
  const second = rleFrame(24, 8, 128 * 1024);
  const data = new Uint8Array(first.length + second.length);
  data.set(first);
  data.set(second, first.length);
  const body = new Uint8Array(2 * MiB).fill(0x61);
  const { bytes, page } = zip([{ name: "frames.txt", body, data, method: 93 }]);
  const slots = header(State.COMPLETE, 1);
  setStore(slots, 10 * MiB);
  const api = await openWorker(mocks.expose, bytes, slots, page, hard);
  expect((await api.read(0, 0, MiB)).state).toBe("reading");
  const last = await api.read(0, MiB, MiB);
  expect(last.state).toBe("verified");
  expect(total(slots)).toBeLessThanOrEqual(hard);
});
