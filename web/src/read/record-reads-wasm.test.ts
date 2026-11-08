// The reads of the rows, with the real read wasm and the real row reader. Each
// row reads its central-directory record and its local header. These tests count
// the reads, because a count is exact and cannot flake. The baseline gives one
// `WindowReaderAt` for the records too: this is the read pattern from before the
// row reader, where each record replaces the window.
import { describe, expect, test } from "vitest";
import { WindowReaderAt } from "../parse/reader";
import init, { ReadArchive } from "../wasm/zipscope_read.js";
import { JOB_CHECK_ROWS, RowReaderAt } from "./row-reader";
import { crc32, encoder } from "./wasm-harness";

await init();

const WINDOW_BYTES = 64 * 1024;
const ROWS = 2000;
const ROW_BYTES = 1024;
/** `RECORD_READ_BYTES` in crates/read/src/local.rs. */
const RECORD_READ_BYTES = 46 + 256;
const MAX_STEP = 1024 * 1024;

/** A body with bytes that are different for each row. */
function body(row: number, length = ROW_BYTES): Uint8Array {
  let state = row + 1;
  return Uint8Array.from({ length }, () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state >>> 24;
  });
}

interface Local {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
  offset: number;
}

/** An archive of stored rows. `order` gives the rows of the central directory,
 *  which can repeat a row. `offset` can change the offset of a record. */
function archive(
  order: readonly number[],
  count = ROWS,
  offset: (local: Local, position: number) => number = (local) => local.offset,
  name: (row: number) => string = (row) => `folder/row-${String(row).padStart(6, "0")}.bin`,
): { bytes: Uint8Array; directory: number; dataBytes: number } {
  const locals: Local[] = [];
  let at = 0;
  for (let row = 0; row < count; row++) {
    const data = body(row);
    const bytes = encoder.encode(name(row));
    locals.push({ name: bytes, data, crc: crc32(data), offset: at });
    at += 30 + bytes.length + data.length;
  }
  const dataBytes = at;
  const records = order.reduce((sum, row) => sum + 46 + locals[row]!.name.length, 0);
  const bytes = new Uint8Array(at + records + 22);
  const view = new DataView(bytes.buffer);
  for (const local of locals) {
    view.setUint32(local.offset, 0x04034b50, true);
    view.setUint16(local.offset + 4, 20, true);
    view.setUint32(local.offset + 14, local.crc, true);
    view.setUint32(local.offset + 18, local.data.length, true);
    view.setUint32(local.offset + 22, local.data.length, true);
    view.setUint16(local.offset + 26, local.name.length, true);
    bytes.set(local.name, local.offset + 30);
    bytes.set(local.data, local.offset + 30 + local.name.length);
  }
  order.forEach((row, position) => {
    const local = locals[row]!;
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint32(at + 16, local.crc, true);
    view.setUint32(at + 20, local.data.length, true);
    view.setUint32(at + 24, local.data.length, true);
    view.setUint16(at + 28, local.name.length, true);
    view.setUint32(at + 42, offset(local, position), true);
    bytes.set(local.name, at + 46);
    at += 46 + local.name.length;
  });
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, Math.min(order.length, 0xffff), true);
  view.setUint16(at + 10, Math.min(order.length, 0xffff), true);
  view.setUint32(at + 12, records, true);
  view.setUint32(at + 16, dataBytes, true);
  return { bytes, directory: dataBytes, dataBytes };
}

/** A file in memory whose reads the test counts, and that can stop. */
class CountedFile {
  reads: number[] = [];
  failure: Error | undefined;
  constructor(readonly bytes: Uint8Array) {}
  get size() {
    return this.bytes.length;
  }
  slice(start: number, end: number): Blob {
    return { bytes: this.bytes.subarray(start, end) } as unknown as Blob;
  }
  readonly sync = {
    readAsArrayBuffer: (blob: Blob): ArrayBuffer => {
      if (this.failure !== undefined) throw this.failure;
      const { bytes } = blob as unknown as { bytes: Uint8Array };
      this.reads.push(bytes.length);
      return bytes.slice().buffer;
    },
  };
}

type Mode = "job" | "single" | "baseline";

interface Opened {
  opened: ReadArchive;
  /** Call it before each output row. */
  startRow: () => void;
  reader: WindowReaderAt;
}

function open(file: CountedFile, mode: Mode, windowBytes = WINDOW_BYTES): Opened {
  const blob = file as unknown as Blob;
  if (mode === "baseline") {
    const reader = new WindowReaderAt(blob, file.sync, windowBytes);
    const opened = ReadArchive.open(reader as never, reader as never, file.size);
    while (opened.scanState() === 0 && opened.scan(16_384) > 0);
    return { opened, startRow: () => {}, reader };
  }
  const reader = new RowReaderAt(blob, file.sync, windowBytes);
  const opened = ReadArchive.open(reader as never, reader.records as never, file.size);
  while (opened.scanState() === 0 && opened.scan(16_384) > 0);
  if (mode === "single") return { opened, startRow: () => {}, reader };
  opened.setJobRecords(reader.startJob() as never);
  return { opened, startRow: () => reader.startJobRow(), reader };
}

interface Row {
  error?: string;
  mismatches: number;
  crc: number;
  length: number;
  state: number;
}

/** Decodes one row to its end, as a step of an extraction does. */
function decode(opened: ReadArchive, row: number): Row {
  const entry = opened.openEntry(row, MAX_STEP * 32);
  const info = entry.info();
  const result: Row = { mismatches: info.mismatches, crc: 0, length: 0, state: 0 };
  if (info.error !== undefined) result.error = info.error;
  info.free();
  const parts: Uint8Array[] = [];
  while (entry.state() === 0) parts.push(entry.read(MAX_STEP, MAX_STEP * 32));
  result.state = entry.state();
  const error = entry.error();
  if (error !== undefined) result.error = error;
  const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }
  result.crc = crc32(data);
  result.length = data.length;
  entry.free();
  return result;
}

/** Decodes the rows in `order` and returns the results and the reads. With
 *  `opens` 2, each row opens two times, as for a zip. */
function run(bytes: Uint8Array, mode: Mode, rows: readonly number[], opens = 1) {
  const file = new CountedFile(bytes);
  const { opened, startRow, reader } = open(file, mode);
  file.reads = [];
  const results = rows.map((row) => {
    startRow();
    let result = decode(opened, row);
    for (let again = 1; again < opens; again++) result = decode(opened, row);
    return result;
  });
  const reads = file.reads;
  const total = reads.reduce((sum, length) => sum + length, 0);
  const retained = reader.retainedBytes;
  opened.free();
  return { results, reads, total, retained };
}

const range = (count: number) => Array.from({ length: count }, (_, row) => row);

/** A fixed random order of `count` rows. */
function shuffled(count: number): number[] {
  const order = range(count);
  let seed = 0x2545f491;
  for (let last = count - 1; last > 0; last--) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const other = seed % (last + 1);
    [order[last], order[other]] = [order[other]!, order[last]!];
  }
  return order;
}

const checks = (rows: number) => Math.ceil(rows / JOB_CHECK_ROWS);

/** The reads of a check: all reads of a job that ask for the bytes of one record. */
const isCheck = (length: number) => length === RECORD_READ_BYTES;

describe("a row reads only what it needs", () => {
  test("a job with rows in order: a few windows and one check for 256 rows", () => {
    const { bytes, directory, dataBytes } = archive(range(ROWS));
    // The central directory does not fit in one window.
    const records = bytes.length - directory;
    expect(records).toBeGreaterThan(WINDOW_BYTES);
    const { reads, results } = run(bytes, "job", range(ROWS));
    expect(results.every((row) => row.state === 1)).toBe(true);
    expect(reads.filter(isCheck)).toHaveLength(checks(ROWS));
    const fills = reads.filter((length) => !isCheck(length));
    expect(fills.length).toBeLessThanOrEqual(
      Math.ceil(dataBytes / WINDOW_BYTES) + Math.ceil(records / WINDOW_BYTES) + 2,
    );
    // The baseline makes about two fills for each row.
    const baseline = run(bytes, "baseline", range(ROWS));
    expect(baseline.reads.length).toBeGreaterThan(1.9 * ROWS);
    expect(baseline.total).toBeGreaterThan(ROWS * WINDOW_BYTES);
  });

  test("two opens of a row are one row for the check", () => {
    const { bytes } = archive(range(ROWS));
    const once = run(bytes, "job", range(ROWS), 1);
    const twice = run(bytes, "job", range(ROWS), 2);
    expect(twice.results).toEqual(once.results);
    expect(twice.reads.filter(isCheck)).toHaveLength(checks(ROWS));
  });

  test("a single entry reads its record from the file each time", () => {
    const { bytes } = archive(range(100));
    const { reads } = run(bytes, "single", [3, 3, 4, 5]);
    expect(reads.filter(isCheck)).toHaveLength(4);
  });
});

const longName = (row: number) => `${"n".repeat(300)}-${row}`;

/** Rows of hostile order: the reads must not be more than the baseline. */
const SHAPES: Record<string, () => { bytes: Uint8Array; rows: number[] }> = {
  "the central directory in random order": () => ({
    bytes: archive(shuffled(ROWS)).bytes,
    rows: range(ROWS),
  }),
  "rows that seek back and forth": () => {
    const order = range(ROWS).map((row) => (row % 2 === 0 ? row / 2 : ROWS - 1 - (row - 1) / 2));
    return { bytes: archive(order).bytes, rows: range(ROWS) };
  },
  "records that repeat one local header": () => ({
    bytes: archive(range(ROWS).map(() => 7)).bytes,
    rows: range(ROWS),
  }),
  "rows that repeat, as a preview does": () => ({
    bytes: archive(range(ROWS)).bytes,
    rows: range(ROWS).map((row) => [0, ROWS - 1, ROWS >> 1][row % 3]!),
  }),
  "offsets into the data of other rows, with no signature": () => ({
    bytes: archive(range(ROWS), ROWS, (local, position) => local.offset + 40 + (position % 500))
      .bytes,
    rows: range(ROWS),
  }),
  "offsets into the central directory": () => {
    const { directory } = archive(range(ROWS));
    return {
      bytes: archive(range(ROWS), ROWS, (_, position) => directory + position * 13).bytes,
      rows: range(ROWS),
    };
  },
  "names longer than one read of a record": () => ({
    bytes: archive(range(500), 500, undefined, (row) => `${"n".repeat(300)}-${row}`).bytes,
    rows: range(500),
  }),
  "rows far apart in the central directory, so each row fills both windows": () => {
    // With long names, 200 records are more than a window, and 200 rows of data
    // are more than a window.
    const { bytes } = archive(range(ROWS), ROWS, undefined, longName);
    return { bytes, rows: range(ROWS).filter((row) => row % 200 === 0) };
  },
  "rows in random order and far apart in the central directory": () => {
    const { bytes } = archive(shuffled(ROWS), ROWS, undefined, longName);
    return { bytes, rows: range(ROWS).filter((row) => row % 200 === 0) };
  },
  "a central directory that starts in the first window and ends past it": () => {
    const count = 58;
    const { bytes, directory } = archive(range(count), count);
    expect(directory).toBeLessThan(WINDOW_BYTES);
    expect(bytes.length).toBeGreaterThan(WINDOW_BYTES);
    return { bytes, rows: range(count) };
  },
};

describe("a hostile archive does not read more", () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    for (const opens of [1, 2]) {
      test(`${name}, with ${opens} opens of each row`, () => {
        const { bytes, rows } = shape();
        const job = run(bytes, "job", rows, opens);
        const baseline = run(bytes, "baseline", rows, opens);
        expect(job.results).toEqual(baseline.results);
        // Apart from the checks, a job reads no more than the baseline.
        const extra = checks(rows.length);
        expect(job.reads.length - extra).toBeLessThanOrEqual(baseline.reads.length);
        expect(job.total - extra * RECORD_READ_BYTES).toBeLessThanOrEqual(baseline.total);
        expect(job.retained).toBeLessThanOrEqual(WINDOW_BYTES);
      });
    }
  }
});

describe("a file that changes under the reader", () => {
  const notReadable = () => new DOMException("The file changed", "NotReadableError");

  /** The rows of a job, with a change to the file after row `changeAfter`. */
  function job(changeAfter: number, rows = ROWS) {
    const { bytes } = archive(range(rows), rows);
    const file = new CountedFile(bytes);
    // This window holds all the bytes of the archive, so only a check finds
    // the change.
    const { opened, startRow } = open(file, "job", 4 * 1024 * 1024);
    const results = range(rows).map((row) => {
      startRow();
      const result = decode(opened, row);
      if (row === changeAfter) file.failure = notReadable();
      return result;
    });
    opened.free();
    return results;
  }

  test("a single entry is refused at the next row, although the window holds its bytes", () => {
    const { bytes } = archive(range(ROWS));
    for (const mode of ["single", "baseline"] as const) {
      const file = new CountedFile(bytes);
      const { opened } = open(file, mode);
      expect(decode(opened, 0).state).toBe(1);
      file.failure = notReadable();
      const next = decode(opened, 1);
      expect(next.state).toBe(2);
      expect(next.length).toBe(0);
      expect(next.error).toBe(
        "The central-directory record cannot be read: The file could not be read",
      );
      opened.free();
    }
  });

  test("a job is refused at the next check, and each row before it is true", () => {
    const rows = 3 * JOB_CHECK_ROWS;
    for (const changeAfter of [0, 1, 254, 255, 256, 300, 511, 512]) {
      const results = job(changeAfter, rows);
      const refused = Math.floor(changeAfter / JOB_CHECK_ROWS + 1) * JOB_CHECK_ROWS;
      results.forEach((row, index) => {
        if (index < refused) {
          expect(row.state).toBe(1);
          expect(row.crc).toBe(crc32(body(index)));
        } else {
          expect(row.state).toBe(2);
          expect(row.length).toBe(0);
          expect(row.error).toBe(
            "The central-directory record cannot be read: The file could not be read",
          );
        }
      });
      // At most 255 rows start after the change.
      expect(refused - 1 - changeAfter).toBeLessThanOrEqual(JOB_CHECK_ROWS - 1);
    }
  });

  test("a read that fails and then recovers refuses the rest of the job", () => {
    const { bytes } = archive(range(ROWS));
    const file = new CountedFile(bytes);
    const { opened, startRow } = open(file, "job");
    startRow();
    expect(decode(opened, 0).state).toBe(1);
    file.failure = notReadable();
    // A row past the data window needs a fill, which fails.
    startRow();
    expect(decode(opened, ROWS - 1).state).toBe(2);
    file.failure = undefined;
    const before = file.reads.length;
    startRow();
    expect(decode(opened, 1).state).toBe(2);
    expect(file.reads).toHaveLength(before);
    opened.free();
  });

  test("a row in progress fails at a read that the window does not hold", () => {
    const large = new Uint8Array(3 * WINDOW_BYTES);
    const name = encoder.encode("large.bin");
    const crc = crc32(large);
    const bytes = new Uint8Array(30 + name.length + large.length + 46 + name.length + 22);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, large.length, true);
    view.setUint32(22, large.length, true);
    view.setUint16(26, name.length, true);
    bytes.set(name, 30);
    let at = 30 + name.length + large.length;
    const directory = at;
    view.setUint32(at, 0x02014b50, true);
    view.setUint32(at + 16, crc, true);
    view.setUint32(at + 20, large.length, true);
    view.setUint32(at + 24, large.length, true);
    view.setUint16(at + 28, name.length, true);
    bytes.set(name, at + 46);
    at += 46 + name.length;
    view.setUint32(at, 0x06054b50, true);
    view.setUint16(at + 8, 1, true);
    view.setUint16(at + 10, 1, true);
    view.setUint32(at + 12, 46 + name.length, true);
    view.setUint32(at + 16, directory, true);
    const file = new CountedFile(bytes);
    const { opened, startRow } = open(file, "job");
    startRow();
    const entry = opened.openEntry(0, MAX_STEP);
    expect(entry.read(1024, MAX_STEP).length).toBe(1024);
    file.failure = notReadable();
    const parts: Uint8Array[] = [];
    while (entry.state() === 0) parts.push(entry.read(MAX_STEP, MAX_STEP));
    expect(entry.state()).toBe(2);
    expect(parts.reduce((sum, part) => sum + part.length, 0)).toBeLessThan(large.length);
    entry.free();
    opened.free();
  });
});

describe("no row gets the bytes of another row", () => {
  test("each row has its own data, after a row with a long name and extra data", () => {
    const names = (row: number) => (row % 2 === 0 ? `${"long-".repeat(100)}${row}` : `s${row}`);
    const { bytes } = archive(range(200), 200, undefined, names);
    const file = new CountedFile(bytes);
    const { opened, startRow } = open(file, "job");
    for (const row of range(200)) {
      startRow();
      const entry = opened.openEntry(row, MAX_STEP);
      const info = entry.info();
      // A short name after a long one has no bytes of the long name.
      expect(new TextDecoder().decode(info.localName)).toBe(names(row));
      expect(info.mismatches).toBe(0);
      info.free();
      const data = entry.read(MAX_STEP, MAX_STEP);
      expect(crc32(data)).toBe(crc32(body(row)));
      entry.free();
    }
    opened.free();
  });
});
