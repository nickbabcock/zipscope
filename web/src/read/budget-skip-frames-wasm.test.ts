// Several Zstandard frames in one skip: a
// read at an offset decodes and drops the frames before it, and the cap
// of the read wasm applies to them. Its own file gives it a new wasm
// instance.
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

test("several frames in one skip stay below the hard stop", async () => {
  const hard = 40 * MiB;
  const { bytes, page } = frames([22, 23, 20]);
  const slots = header(State.COMPLETE, 1);
  setStore(slots, 32 * MiB);
  const api = await openWorker(mocks.expose, bytes, slots, page, hard);
  // The read starts in the third frame, so it skips the first two.
  const chunk = await api.read(0, 2 * BLOCK, 1024);
  expect(total(slots)).toBeLessThanOrEqual(hard);
  expect(chunk.state).toBe("failed");
  expect(chunk.bytes.length).toBe(0);
});

test("the same skip works when the limit leaves room", async () => {
  // The first test of this file used some memory, which does not shrink.
  // With 32 MiB for the read worker, the frames fit.
  const hard = 64 * MiB;
  const { bytes, page } = frames([22, 23, 20]);
  const slots = header(State.COMPLETE, 1);
  setStore(slots, 32 * MiB);
  const api = await openWorker(mocks.expose, bytes, slots, page, hard);
  const chunk = await api.read(0, 2 * BLOCK, 1024);
  expect(chunk.state).toBe("reading");
  expect(chunk.offset).toBe(2 * BLOCK);
  expect(chunk.bytes.length).toBe(1024);
  expect(total(slots)).toBeLessThanOrEqual(hard);
});
