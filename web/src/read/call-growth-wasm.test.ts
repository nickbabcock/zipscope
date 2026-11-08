// One wasm call of the read module grows its memory by at most
// READ_CALL_GROWTH_BYTES, also with the largest window.
// A case that failed before: the ruzstd fallback grew by
// 129.5 MiB for a 1 MiB read with a 32 MiB window; the fallback is removed,
// and the C decoder grows by about 33.5 MiB. Its own file gives it a new
// wasm instance.
import { expect, test } from "vitest";
import { READ_CALL_GROWTH_BYTES } from "../contracts";
import * as glue from "../wasm/zipscope_read.js";
import { MiB, concat, rleFrame, zip } from "./wasm-harness";

const instance = await glue.default();
const memory = () => instance.memory.buffer.byteLength;

const BLOCK = 128 * 1024;

/** An entry of 48 MiB of RLE blocks, in one frame with a window of `2^log`. */
function archive(log: number) {
  const blocks = 384;
  const body = new Uint8Array(blocks * BLOCK).fill(0x61);
  const { bytes } = zip([
    { name: "z.txt", body, data: concat(rleFrame(log, blocks, BLOCK)), method: 93 },
  ]);
  const reader = {
    readAt(offset: number, buffer: Uint8Array) {
      const part = bytes.subarray(offset, offset + buffer.length);
      buffer.set(part);
      return part.length;
    },
  };
  const opened = glue.ReadArchive.open(reader as never, reader as never, bytes.length);
  opened.scan(1);
  opened.start(0, 32 * MiB).free();
  return opened;
}

test("a read with the largest window stays within READ_CALL_GROWTH_BYTES", () => {
  for (const read of [MiB, 16 * MiB]) {
    const opened = archive(25);
    const before = memory();
    const data = opened.read(read, 32 * MiB);
    expect(data.length).toBe(read);
    expect(opened.streamState()).toBe(0);
    expect(memory() - before).toBeLessThanOrEqual(READ_CALL_GROWTH_BYTES);
    opened.free();
  }
});
