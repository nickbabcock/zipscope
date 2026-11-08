import { describe, expect, test } from "vitest";
import { JOB_CHECK_ROWS, RowReaderAt } from "./row-reader";

// A file of `size` bytes, where the byte at `at` is `at % 251`.
function fixture(size: number) {
  const reads: [number, number][] = [];
  const state = { failure: undefined as Error | undefined };
  const file = {
    size,
    slice(start: number, end: number) {
      const length = Math.max(0, Math.min(end, size) - Math.min(start, size));
      return { start, size: length } as unknown as Blob;
    },
  } as Blob;
  const sync = {
    readAsArrayBuffer(blob: Blob) {
      if (state.failure !== undefined) throw state.failure;
      const { start, size: length } = blob as unknown as { start: number; size: number };
      reads.push([start, length]);
      return Uint8Array.from({ length }, (_, i) => (start + i) % 251).buffer;
    },
  };
  return { file, sync, reads, state };
}

const WINDOW = 16;
const changed = () => new DOMException("The file changed", "NotReadableError");

function setup(size = 1000) {
  const made = fixture(size);
  return { ...made, reader: new RowReaderAt(made.file, made.sync, WINDOW) };
}

function bytes(buffer: Uint8Array) {
  return [...buffer];
}

const expected = (at: number, count: number) =>
  Array.from({ length: count }, (_, i) => (at + i) % 251);

describe("a preview and a single entry", () => {
  test("read each record from the file, also when the window holds it", () => {
    const { reader, reads } = setup();
    const buffer = new Uint8Array(4);
    reader.readAt(100, buffer);
    expect(reader.records.readAt(104, buffer)).toBe(4);
    expect(reader.records.readAt(104, buffer)).toBe(4);
    expect(bytes(buffer)).toEqual(expected(104, 4));
    expect(reads).toEqual([
      [100, WINDOW],
      [104, 4],
      [104, 4],
    ]);
  });

  test("keep the window and make no second window", () => {
    const { reader, reads } = setup();
    const buffer = new Uint8Array(4);
    reader.readAt(100, buffer);
    reader.records.readAt(900, buffer);
    reader.readAt(104, buffer);
    expect(reads).toHaveLength(2);
    expect(reader.retainedBytes).toBe(WINDOW);
    expect(reader.jobWindowBytes).toBe(0);
  });

  test("a failed read empties the window, and a later read can recover", () => {
    const { reader, state, reads } = setup();
    const buffer = new Uint8Array(4);
    reader.readAt(100, buffer);
    state.failure = changed();
    expect(reader.readAt(104, buffer)).toBe(4);
    expect(() => reader.records.readAt(900, buffer)).toThrow("The file changed");
    expect(reader.retainedBytes).toBe(0);
    expect(() => reader.readAt(104, buffer)).toThrow("The file changed");
    state.failure = undefined;
    expect(reader.readAt(104, buffer)).toBe(4);
    expect(bytes(buffer)).toEqual(expected(104, 4));
    expect(reads.at(-1)).toEqual([104, WINDOW]);
  });

  test("give no bytes past the end of the file, with no read", () => {
    const { reader, reads } = setup(100);
    const buffer = new Uint8Array(8);
    expect(reader.records.readAt(100, buffer)).toBe(0);
    expect(reader.records.readAt(101, buffer)).toBe(0);
    expect(reads).toEqual([]);
    expect(reader.records.readAt(97, buffer)).toBe(3);
  });
});

describe("a job", () => {
  test("has a second window, so a record does not replace the data window", () => {
    const { reader, reads } = setup();
    const records = reader.startJob();
    const buffer = new Uint8Array(4);
    reader.readAt(100, buffer);
    records.readAt(900, buffer);
    expect(bytes(buffer)).toEqual(expected(900, 4));
    reader.readAt(104, buffer);
    records.readAt(904, buffer);
    expect(reads).toEqual([
      [100, WINDOW],
      [900, WINDOW],
    ]);
    expect(reader.retainedBytes).toBe(WINDOW);
    expect(reader.jobWindowBytes).toBe(WINDOW);
  });

  test("a read comes from the window that holds it, and fills no other", () => {
    const { reader, reads } = setup();
    const records = reader.startJob();
    const buffer = new Uint8Array(4);
    reader.readAt(100, buffer);
    records.readAt(104, buffer);
    expect(reader.jobWindowBytes).toBe(0);
    records.readAt(900, buffer);
    reader.readAt(904, buffer);
    expect(bytes(buffer)).toEqual(expected(904, 4));
    expect(reads).toHaveLength(2);
    expect(reader.retainedBytes).toBe(WINDOW);
  });

  test("goes to the file at each JOB_CHECK_ROWS rows, also when both windows hold the bytes", () => {
    expect(JOB_CHECK_ROWS).toBe(256);
    const { reader, reads } = setup();
    const records = reader.startJob();
    const buffer = new Uint8Array(4);
    reader.readAt(100, buffer);
    records.readAt(900, buffer);
    reads.length = 0;
    for (let row = 0; row < 2 * JOB_CHECK_ROWS + 1; row++) {
      reader.startJobRow();
      records.readAt(900, buffer);
      expect(bytes(buffer)).toEqual(expected(900, 4));
      reader.readAt(100, buffer);
      // A second read of a record of the row is not a check.
      records.readAt(900, buffer);
    }
    expect(reads).toEqual([
      [900, 4],
      [900, 4],
      [900, 4],
    ]);
  });

  test("the row at the check is refused, and the row before it is not", () => {
    const { reader, state } = setup();
    const records = reader.startJob();
    const buffer = new Uint8Array(4);
    reader.startJobRow();
    // The check does not fill a window, so the next read fills the second one.
    records.readAt(900, buffer);
    records.readAt(900, buffer);
    state.failure = changed();
    for (let row = 1; row < JOB_CHECK_ROWS; row++) {
      reader.startJobRow();
      expect(records.readAt(900, buffer)).toBe(4);
    }
    reader.startJobRow();
    expect(() => records.readAt(900, buffer)).toThrow("The file changed");
  });

  for (const [name, fail] of Object.entries({
    "a fill of the data window": (reader: RowReaderAt, buffer: Uint8Array) =>
      reader.readAt(500, buffer),
    "a fill of the second window": (
      _: RowReaderAt,
      buffer: Uint8Array,
      records: { readAt(at: number, into: Uint8Array): number },
    ) => records.readAt(700, buffer),
    "a read of a preview during the job": (reader: RowReaderAt, buffer: Uint8Array) =>
      reader.records.readAt(100, buffer),
    "a check": (
      reader: RowReaderAt,
      buffer: Uint8Array,
      records: { readAt(at: number, into: Uint8Array): number },
    ) => {
      reader.startJobRow();
      records.readAt(900, buffer);
    },
  })) {
    test(`${name} that fails empties both windows and refuses all later reads`, () => {
      const { reader, state, reads } = setup();
      const records = reader.startJob();
      const buffer = new Uint8Array(4);
      reader.readAt(100, buffer);
      records.readAt(900, buffer);
      state.failure = changed();
      expect(() => fail(reader, buffer, records)).toThrow("The file changed");
      expect(reader.retainedBytes).toBe(0);
      expect(reader.jobWindowBytes).toBe(0);
      // The refusal stays although the file can be read again.
      state.failure = undefined;
      const before = reads.length;
      expect(() => reader.readAt(104, buffer)).toThrow("The file changed");
      expect(() => records.readAt(904, buffer)).toThrow("The file changed");
      expect(() => reader.records.readAt(104, buffer)).toThrow("The file changed");
      reader.startJobRow();
      expect(() => records.readAt(904, buffer)).toThrow("The file changed");
      expect(reads).toHaveLength(before);
    });
  }

  test("ends with no second window, and a later job starts with no refusal", () => {
    const { reader, state } = setup();
    const records = reader.startJob();
    const buffer = new Uint8Array(4);
    records.readAt(900, buffer);
    expect(reader.jobWindowBytes).toBe(WINDOW);
    state.failure = changed();
    expect(() => records.readAt(100, buffer)).toThrow("The file changed");
    reader.endJob();
    expect(reader.jobWindowBytes).toBe(0);
    state.failure = undefined;
    expect(reader.readAt(100, buffer)).toBe(4);
    const next = reader.startJob();
    reader.startJobRow();
    expect(next.readAt(900, buffer)).toBe(4);
    expect(reader.jobWindowBytes).toBe(0);
  });

  test("one job at a time", () => {
    const { reader } = setup();
    reader.startJob();
    expect(() => reader.startJob()).toThrow("A job is in progress");
  });

  test("close frees the second window", () => {
    const { reader } = setup();
    const records = reader.startJob();
    records.readAt(900, new Uint8Array(4));
    reader.close();
    expect(reader.jobWindowBytes).toBe(0);
    expect(reader.retainedBytes).toBe(0);
  });
});
