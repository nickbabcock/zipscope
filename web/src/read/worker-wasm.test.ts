// The read worker with the real read wasm (`mise run build:wasm` makes it),
// for a preview after a budget stop, the memory of hostile Zstandard data,
// and data with more than one frame.
import { afterEach, expect, test, vi } from "vitest";
import { State } from "../contracts";
import { MiB, encoder, header, openWorker, readBytes, zip } from "./wasm-harness";
import { COLUMN_ID, COLUMN_LAYOUT, Marks, WRAPPED_REASON, columnView } from "../contracts";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

test("previews a listed row after a budget stop and reads no other rows", async () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({
    name: `kept/${index}.txt`,
    body: encoder.encode(`body ${index}`),
  }));
  // The parse worker stopped after 10 of 600,010 records.
  const { bytes, page } = zip(entries, 600_000);
  const stopped = header(State.FAILED, 10);
  const api = await openWorker(mocks.expose, bytes, stopped, page);
  await api.settled();
  const chunk = await api.read(7, 0, 1024);
  expect(new TextDecoder().decode(chunk.bytes)).toBe("body 7");
  expect(chunk.state).toBe("verified");
  await expect(api.read(10, 0, 1024)).rejects.toThrow("not listed");
  const bounded = readBytes(stopped);
  expect(bounded).toBeGreaterThan(0);

  // With all rows committed, the table of 600,010 rows (about 29 MiB)
  // makes the memory larger.
  const complete = header(State.COMPLETE, 600_010);
  const all = await openWorker(mocks.expose, bytes, complete, page);
  await all.settled();
  expect(readBytes(complete)).toBeGreaterThan(bounded + 16 * MiB);
}, 60_000);

/** A Zstandard frame of RLE blocks of `a`, with a window of `2^log`. */
function rleFrame(log: number, blocks: number, block: number): Uint8Array {
  const frame = new Uint8Array(6 + blocks * 4);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 0xfd2fb528, true);
  frame[4] = 0;
  frame[5] = (log - 10) << 3;
  for (let index = 0; index < blocks; index++) {
    const last = index + 1 === blocks ? 1 : 0;
    const value = last | (1 << 1) | (block << 3);
    frame[6 + index * 4] = value & 0xff;
    frame[7 + index * 4] = (value >>> 8) & 0xff;
    frame[8 + index * 4] = (value >>> 16) & 0xff;
    frame[9 + index * 4] = 0x61;
  }
  return frame;
}

/** A Zstandard frame with one raw block of `text`. */
function rawFrame(text: string): Uint8Array {
  const body = encoder.encode(text);
  const frame = new Uint8Array(9 + body.length);
  new DataView(frame.buffer).setUint32(0, 0xfd2fb528, true);
  frame[5] = 0;
  const value = 1 | (body.length << 3);
  frame[6] = value & 0xff;
  frame[7] = (value >>> 8) & 0xff;
  frame[8] = (value >>> 16) & 0xff;
  frame.set(body, 9);
  return frame;
}

function skippable(length: number): Uint8Array {
  const frame = new Uint8Array(8 + length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 0x184d2a50, true);
  view.setUint32(4, length, true);
  return frame;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

test("hostile Zstandard data does not grow the worker memory much", async () => {
  // A case that failed before: 4,106 bytes make 128 MiB with a 32 MiB window,
  // and the central directory gives one byte. Before the fix, this read
  // grew the memory from about 2 MiB to 258 MiB.
  const data = rleFrame(25, 1025, 128 * 1024);
  const { bytes, page } = zip([
    { name: "bomb.txt", body: encoder.encode("a"), data, method: 93, size: 1 },
    // A 1 GiB window.
    { name: "wide.txt", body: encoder.encode("a"), data: rleFrame(30, 4, 1000), method: 93 },
  ]);
  const slots = header(State.COMPLETE, 2);
  const api = await openWorker(mocks.expose, bytes, slots, page);
  const before = readBytes(slots);
  const bomb = await api.read(0, 0, 1);
  expect(bomb.state).toBe("failed");
  expect(bomb.error).toContain("longer");
  const wide = await api.read(1, 0, 1024);
  expect(wide.state).toBe("failed");
  expect(wide.bytes.length).toBe(0);
  expect(readBytes(slots) - before).toBeLessThan(48 * MiB);
});

test("decodes Zstandard data with more than one frame and skippable frames", async () => {
  const data = concat(
    skippable(5),
    rawFrame("hello"),
    skippable(0),
    rawFrame(" world"),
    skippable(20),
  );
  const { bytes, page } = zip([
    { name: "frames.txt", body: encoder.encode("hello world"), data, method: 93 },
  ]);
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 1), page);
  const chunk = await api.read(0, 0, 1024);
  expect(new TextDecoder().decode(chunk.bytes)).toBe("hello world");
  expect(chunk.state).toBe("verified");
});

test("a row with an offset that wrapped is refused by its mark, and the others read", async () => {
  const entries = [
    { name: "kept.txt", body: encoder.encode("kept") },
    { name: "marked.txt", body: encoder.encode("marked") },
  ];
  const { bytes, page } = zip(entries);
  columnView(page, COLUMN_LAYOUT[COLUMN_ID.marks]!)[1] = Marks.WRAPPED_OFFSET;
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 2), page);
  await api.settled();
  const refused = await api.read(1, 0, 1024);
  expect(refused.state).toBe("failed");
  expect(refused.error).toBe(WRAPPED_REASON);
  expect(refused.check.error).toBe(WRAPPED_REASON);
  expect(refused.bytes.length).toBe(0);
  const kept = await api.read(0, 0, 1024);
  expect(new TextDecoder().decode(kept.bytes)).toBe("kept");
  expect(kept.state).toBe("verified");
}, 60_000);
