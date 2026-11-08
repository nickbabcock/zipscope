import { describe, expect, test } from "vitest";
import { FileReaderAt, WindowReaderAt } from "./reader";

// Uses absolute offsets without a large allocation.
function fixture(size: number) {
  const reads: [number, number][] = [];
  const file = {
    size,
    slice(start: number, end: number) {
      const length = Math.max(0, Math.min(end, size) - Math.min(start, size));
      reads.push([start, length]);
      return { start, size: length } as unknown as Blob;
    },
  } as Blob;
  const sync = {
    readAsArrayBuffer(blob: Blob) {
      const start = (blob as unknown as { start: number }).start;
      return Uint8Array.from({ length: blob.size }, (_, i) => (start + i) % 251).buffer;
    },
  };
  return { file, sync, reads };
}

for (const kind of ["direct", "window"] as const) {
  describe(kind, () => {
    test("reads exact bytes at offsets past 2^32 and at EOF", () => {
      const size = 2 ** 32 + 31;
      const { file, sync } = fixture(size);
      const reader =
        kind === "direct" ? new FileReaderAt(file, sync) : new WindowReaderAt(file, sync, 16);
      for (const offset of [2 ** 32 - 3, 2 ** 32 + 3, size - 3, size, size + 10]) {
        const buffer = new Uint8Array(8).fill(255);
        const n = reader.readAt(offset, buffer);
        expect(n).toBe(Math.min(8, Math.max(0, size - offset)));
        expect([...buffer.subarray(0, n)]).toEqual(
          Array.from({ length: n }, (_, i) => (offset + i) % 251),
        );
        expect([...buffer.subarray(n)]).toEqual(Array.from({ length: 8 - n }, () => 255));
      }
    });
  });
}

describe("window", () => {
  test("returns short reads at a window edge and refills at the next byte", () => {
    const { file, sync, reads } = fixture(100);
    const reader = new WindowReaderAt(file, sync, 16);
    const buffer = new Uint8Array(7);
    expect(reader.readAt(20, buffer)).toBe(7);
    expect(reader.readAt(33, buffer)).toBe(3);
    expect([...buffer.subarray(0, 3)]).toEqual([33, 34, 35]);
    expect(reader.readAt(36, buffer)).toBe(7);
    expect([...buffer]).toEqual([36, 37, 38, 39, 40, 41, 42]);
    expect(reads).toEqual([
      [20, 16],
      [36, 16],
    ]);
    expect(reader.retainedBytes).toBe(16);
  });

  test("bypasses the cache for requests at least as large as the window", () => {
    const { file, sync, reads } = fixture(100);
    const reader = new WindowReaderAt(file, sync, 16);
    for (const length of [16, 40]) {
      const buffer = new Uint8Array(length);
      expect(reader.readAt(10, buffer)).toBe(length);
      expect([...buffer]).toEqual(Array.from({ length }, (_, i) => i + 10));
    }
    expect(reads).toEqual([
      [10, 16],
      [10, 40],
    ]);
    expect(reader.retainedBytes).toBe(0);
  });

  test("refills on backward reads and does no I/O for empty reads", () => {
    const { file, sync, reads } = fixture(100);
    const reader = new WindowReaderAt(file, sync, 16);
    reader.readAt(50, new Uint8Array(1));
    reader.readAt(0, new Uint8Array(1));
    expect(reader.readAt(0, new Uint8Array(0))).toBe(0);
    expect(reader.readAt(100, new Uint8Array(2))).toBe(0);
    expect(reader.readAt(101, new Uint8Array(2))).toBe(0);
    expect(reads).toEqual([
      [50, 16],
      [0, 16],
    ]);
  });

  test("does not retain the wasm view", () => {
    const { file, sync } = fixture(100);
    const reader = new WindowReaderAt(file, sync, 16);
    const memory = new WebAssembly.Memory({ initial: 1 });
    reader.readAt(0, new Uint8Array(memory.buffer, 0, 4));
    memory.grow(1);
    const buffer = new Uint8Array(memory.buffer, 0, 4);
    reader.readAt(4, buffer);
    expect([...buffer]).toEqual([4, 5, 6, 7]);
  });
});

test("uses a 4 MiB window by default", () => {
  const { file, sync, reads } = fixture(8 * 1024 * 1024);
  const reader = new WindowReaderAt(file, sync);
  reader.readAt(10, new Uint8Array(1));
  expect(reads).toEqual([[10, 4 * 1024 * 1024]]);
});

test("releases the previous window before a refill or a large read", () => {
  const { file, sync } = fixture(100);
  const retainedAtRead: number[] = [];
  const reader = new WindowReaderAt(
    file,
    {
      readAsArrayBuffer(blob) {
        retainedAtRead.push(reader.retainedBytes);
        return sync.readAsArrayBuffer(blob);
      },
    },
    16,
  );
  reader.readAt(0, new Uint8Array(4));
  reader.readAt(16, new Uint8Array(4));
  reader.readAt(32, new Uint8Array(40));
  expect(retainedAtRead).toEqual([0, 0, 0]);
  expect(reader.retainedBytes).toBe(0);
});

test("returns a short source read without changing the remaining output", () => {
  const { file, sync } = fixture(100);
  const reader = new WindowReaderAt(
    file,
    {
      readAsArrayBuffer(blob) {
        return sync.readAsArrayBuffer(blob).slice(0, 3);
      },
    },
    16,
  );
  const buffer = new Uint8Array(8).fill(255);
  expect(reader.readAt(20, buffer)).toBe(3);
  expect([...buffer]).toEqual([20, 21, 22, 255, 255, 255, 255, 255]);
  expect(reader.readAt(23, buffer)).toBe(3);
  expect([...buffer.subarray(0, 3)]).toEqual([23, 24, 25]);
});

test("close releases the window and prevents further reads", () => {
  const { file, sync, reads } = fixture(100);
  const reader = new WindowReaderAt(file, sync, 16);
  reader.readAt(0, new Uint8Array(4));
  expect(reader.retainedBytes).toBe(16);
  reader.close();
  reader.close();
  expect(reader.retainedBytes).toBe(0);
  expect(() => reader.readAt(0, new Uint8Array(4))).toThrow("Reader is closed");
  expect(reads).toHaveLength(1);
});

test("a failed refill does not retain the previous window", () => {
  const { file, sync } = fixture(100);
  let calls = 0;
  const reader = new WindowReaderAt(
    file,
    {
      readAsArrayBuffer(blob) {
        if (++calls === 2) throw new Error("Read failed");
        return sync.readAsArrayBuffer(blob);
      },
    },
    16,
  );
  reader.readAt(0, new Uint8Array(4));
  expect(() => reader.readAt(16, new Uint8Array(4))).toThrow("Read failed");
  expect(reader.retainedBytes).toBe(0);
});
