// A read whose second frame needs a new window ends the wasm call at the
// frame boundary. The worker then calls again
// under a new cap, so the preview still gets all the bytes. Its own file
// gives it a new wasm instance.
import { afterEach, expect, test, vi } from "vitest";
import { State } from "../contracts";
import * as readWasm from "../wasm/zipscope_read.js";
import { concat, header, openWorker, rleFrame, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
// A mocked module stays the same after `vi.resetModules`, so the worker
// gets the module that has the spies.
vi.mock("../wasm/zipscope_read.js", (importOriginal) => importOriginal());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("a second frame with a new window waits for the next call", async () => {
  const block = 128 * 1024;
  // The second frame needs a larger window. The third does not.
  const data = concat(rleFrame(20, 1, block), rleFrame(23, 1, block), rleFrame(20, 1, block));
  const body = new Uint8Array(3 * block).fill(0x61);
  const { bytes, page } = zip([{ name: "frames.txt", body, data, method: 93 }]);
  const original = readWasm.ReadArchive.prototype.read;
  const calls: number[] = [];
  vi.spyOn(readWasm.ReadArchive.prototype, "read").mockImplementation(function (
    this: readWasm.ReadArchive,
    max: number,
    window: number,
  ) {
    const out = original.call(this, max, window);
    calls.push(out.length);
    return out;
  });
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 1), page);
  const chunk = await api.read(0, 0, 1024 * 1024);
  // The first call ends at the boundary before the second frame.
  expect(calls).toEqual([block, 2 * block]);
  expect(chunk.bytes.length).toBe(3 * block);
  expect(chunk.state).toBe("verified");
});
