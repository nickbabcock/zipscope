// Several Zstandard frames in one read: a
// later frame with a larger window cannot grow the memory past the hard
// stop, because the allocator of the read wasm has a hard cap. Its own
// file gives it a new wasm instance.
import { afterEach, expect, test, vi } from "vitest";
import { State } from "../contracts";
import { MiB, concat, header, openWorker, rleFrame, setStore, total, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const BLOCK = 128 * 1024;

/** An entry of Zstandard frames, each of one 128 KiB RLE block of `a`,
 *  with the window logs `logs`. */
function frames(logs: number[]) {
  const data = concat(...logs.map((log) => rleFrame(log, 1, BLOCK)));
  const body = new Uint8Array(logs.length * BLOCK).fill(0x61);
  return zip([{ name: "frames.txt", body, data, method: 93 }]);
}

test("several frames in one read stay below the hard stop", async () => {
  // A case that failed before: a 40 MiB hard stop, a 32 MiB store, and
  // frames with 4 MiB and 8 MiB windows in one read. Before the cap, the
  // read was verified, and the total was 46.81 MiB.
  const hard = 40 * MiB;
  const { bytes, page } = frames([22, 23]);
  const slots = header(State.COMPLETE, 1);
  setStore(slots, 32 * MiB);
  const api = await openWorker(mocks.expose, bytes, slots, page, hard);
  const chunk = await api.read(0, 0, MiB);
  expect(total(slots)).toBeLessThanOrEqual(hard);
  // The cap stops the second frame in the middle of the read. The bytes
  // of the first frame come with the error.
  expect(chunk.state).toBe("failed");
  expect(chunk.error).toMatch(/memory|allocat/i);
  expect(chunk.bytes.length).toBe(BLOCK);
  expect(chunk.bytes.every((byte) => byte === 0x61)).toBe(true);
});
