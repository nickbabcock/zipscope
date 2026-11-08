// The reads and the writes of the lead of a zstd copy, with the real write
// wasm: the records and the local headers go through two windows, with the
// read rule of extraction (`RowReaderAt`). A change to the file is found at
// the next check or the next fill, and the copy then fails. The file of the
// picker gets its writes in parts of 1 MiB.
import { afterEach, describe, expect, test, vi } from "vitest";
import { State } from "../contracts";
import { CHUNK_BYTES } from "../read/port";
import { RowReaderAt } from "../read/row-reader";
import { JOB_CHECK_ROWS } from "../read/row-reader";
import { encoder, header, zip } from "../read/wasm-harness";
import type { Entry } from "../read/wasm-harness";
import { memoryHandle, readHook, records, runRemux } from "./harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  readHook.before = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Small rows of 1 KiB, then a row of 5 MiB. The local headers of the small
 *  rows and the central directory are not in one window of 4 MiB, so one
 *  window for both is filled again for each row. */
const SMALL_ROWS = 1200;
const ROWS = SMALL_ROWS + 1;

const ENTRIES: Entry[] = [
  ...Array.from({ length: SMALL_ROWS }, (_, row) => ({
    name: `small/${String(row).padStart(4, "0")}.txt`,
    body: encoder.encode(`row ${row} `.repeat(120).slice(0, 1024)),
  })),
  { name: "large.bin", body: new Uint8Array(5 * 1024 * 1024) },
];

const { bytes } = zip(ENTRIES);

async function copy() {
  const out = memoryHandle();
  const { report } = await runRemux(
    mocks.expose,
    bytes,
    header(State.COMPLETE, ROWS),
    ROWS,
    { kind: "file", handle: out.handle },
    2,
    2 ** 31,
  );
  return { report, out };
}

test("the lead and the encoders fill each window about one time for each 4 MiB", async () => {
  let reads = 0;
  readHook.before = () => {
    reads++;
  };
  const endJob = vi.spyOn(RowReaderAt.prototype, "endJob");
  const { report, out } = await copy();
  expect(report.outcome, report.error).toBe("complete");
  expect(report.written).toBe(ROWS);
  expect(records(out.bytes()).map((record) => record.name)).toEqual(
    ENTRIES.map((entry) => entry.name),
  );
  // With one window in the lead, each row made two fills: more than 2,400
  // reads. Now the lead makes one check for 256 rows and a few fills, and
  // each of the two encoders a few fills.
  expect(reads).toBeLessThanOrEqual(Math.ceil(ROWS / JOB_CHECK_ROWS) + 12);
  expect(endJob).toHaveBeenCalledTimes(1);
}, 120_000);

test("the file of the picker gets the small rows in parts of 1 MiB, not one write for each row", async () => {
  const { report, out } = await copy();
  expect(report.outcome, report.error).toBe("complete");
  const size = out.bytes().length;
  expect(size).toBeGreaterThan(SMALL_ROWS * 1024 * 0.1);
  // One write for each part of 1 MiB and one at the end: before, it was one
  // write for each row.
  expect(out.state.parts.length).toBeLessThanOrEqual(Math.ceil(size / CHUNK_BYTES) + 1);
  for (const part of out.state.parts.slice(0, -1)) {
    expect(part.length).toBeGreaterThanOrEqual(CHUNK_BYTES);
  }
}, 120_000);

describe("a change to the file during the copy", () => {
  test.each([
    // The check of the first row finds the change.
    { before: 0, started: 1 },
    // The check of row 256 finds the change.
    { before: 256, started: 257 },
    // The true limit: row 256 passed its check, and then 255 rows start.
    { before: 257, started: 513 },
    { before: 300, started: 513 },
  ])(
    "a change before row $before starts is found when $started rows started",
    async ({ before, started }) => {
      let rows = 0;
      let changed = false;
      let found: number | undefined;
      const start = RowReaderAt.prototype.startJobRow;
      vi.spyOn(RowReaderAt.prototype, "startJobRow").mockImplementation(function (
        this: RowReaderAt,
      ) {
        if (rows === before) changed = true;
        rows++;
        start.call(this);
      });
      readHook.before = () => {
        if (!changed) return;
        found ??= rows;
        throw new DOMException("The file changed", "NotReadableError");
      };
      const endJob = vi.spyOn(RowReaderAt.prototype, "endJob");
      const { report, out } = await copy();
      expect(found).toBe(started);
      expect(started - 1 - before).toBeLessThanOrEqual(JOB_CHECK_ROWS - 1);
      // The copy fails, and the file of the picker keeps its old content.
      expect(report.outcome).toBe("failed");
      expect(report.error).toContain("could not be read");
      expect(out.state.aborted).toBe(true);
      expect(out.state.closed).toBe(false);
      expect(endJob).toHaveBeenCalledTimes(1);
    },
    120_000,
  );
});
