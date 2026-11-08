// The hint of the zstd copy: which rows are stored or barely compressed.
import { Marks, RegionKind, RegionLabel } from "../contracts";
import type { ByteMap, LayoutCounts } from "../contracts";
import { expect, test } from "vitest";
import kindRs from "../../../crates/write/src/kind.rs?raw";
import {
  BARELY_COMPRESSED,
  COMPRESSED_EXTENSIONS,
  COUNT_BUDGET_MS,
  COUNT_ROWS,
  compressedName,
  countRows,
  hintKind,
  outsideBytes,
} from "./hint";
import type { CountReader, HintRow } from "./hint";

test("the list of compressed formats is the list of the encoder", () => {
  const block = /const EXTENSIONS: &\[&str\] = &\[([\s\S]*?)\];/.exec(kindRs)?.[1];
  expect(block).toBeDefined();
  const encoder = [...block!.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  expect([...COMPRESSED_EXTENSIONS]).toEqual(encoder);
});

test("a compressed format is known by its extension, in any case", () => {
  for (const name of ["a.jpg", "dir/photo.JPEG", "x\\y\\clip.mp4", "lib/inner.jar", "doc.DOCX"]) {
    expect(compressedName(name), name).toBe(true);
  }
  for (const name of ["a.txt", "jpg", "dir.jpg/readme", "a.", "", "archive.zip.txt"]) {
    expect(compressedName(name), name).toBe(false);
  }
});

const row = (values: Partial<HintRow>): HintRow => ({
  method: 0,
  encrypted: false,
  uncompressed: 1000,
  compressed: 1000,
  ...values,
});

test("stored and barely compressed rows count, others do not", () => {
  const name = () => "a.txt";
  expect(hintKind(row({}), name)).toBe("loose");
  expect(hintKind(row({ method: 8, compressed: BARELY_COMPRESSED * 1000 }), name)).toBe("loose");
  expect(hintKind(row({ method: 8, compressed: 899 }), name)).toBeUndefined();
  // Zstandard stays as it is; the copy leaves out encrypted rows and
  // methods that it cannot decode.
  expect(hintKind(row({ method: 93 }), name)).toBeUndefined();
  expect(hintKind(row({ method: 20 }), name)).toBeUndefined();
  expect(hintKind(row({ method: 12 }), name)).toBeUndefined();
  expect(hintKind(row({ encrypted: true }), name)).toBeUndefined();
  // A folder or an empty file has no data.
  expect(hintKind(row({ uncompressed: 0, compressed: 0 }), name)).toBeUndefined();
});

test("a stored compressed format counts apart, and a name decodes only when needed", () => {
  expect(hintKind(row({}), () => "img/photo.png")).toBe("formats");
  let names = 0;
  const name = () => {
    names++;
    return "a.txt";
  };
  hintKind(row({ method: 8, compressed: 100 }), name);
  hintKind(row({ method: 93 }), name);
  expect(names).toBe(0);
});

/** A reader of `rows` stored rows of 10 bytes, named `f.txt`. Each name
 *  decode costs `nameMs` on the fake clock. */
function slowReader(nameMs: number, clock: { ms: number }): CountReader {
  return {
    value: (_row, column) => (column === "method" || column === "flags" ? 0 : 10),
    name: () => {
      clock.ms += nameMs;
      return "f.txt";
    },
  };
}

test("a turn of the count ends on the time budget, before COUNT_ROWS rows", async () => {
  const clock = { ms: 0 };
  const turns: number[] = [];
  let last = 0;
  let row = 0;
  const reader = slowReader(0.01, clock);
  const counting: CountReader = {
    value: (index, column) => {
      row = index;
      return reader.value(index, column);
    },
    name: reader.name,
  };
  const rows = 200_000;
  const counts = await countRows(counting, rows, () => true, {
    now: () => clock.ms,
    pause: async () => {
      turns.push(row + 1 - last);
      last = row + 1;
    },
  });
  expect(counts).toEqual({
    bytes: rows * 10,
    leftOut: 0,
    wrapped: 0,
    hint: { loose: rows * 10, formats: 0 },
  });
  // 0.01 ms for each row: a turn of 12 ms has about 1,200 rows, not 65,536.
  expect(turns.length).toBeGreaterThan(100);
  expect(Math.max(...turns)).toBeLessThan(COUNT_ROWS);
  expect(Math.max(...turns) * 0.01).toBeLessThan(COUNT_BUDGET_MS + 3);
});

test("a fast count still ends a turn after COUNT_ROWS rows, and stops when not live", async () => {
  const clock = { ms: 0 };
  let pauses = 0;
  let live = true;
  const counts = await countRows(slowReader(0, clock), COUNT_ROWS * 3, () => live, {
    now: () => clock.ms,
    pause: async () => {
      pauses++;
      if (pauses === 2) live = false;
    },
  });
  expect(counts).toBeUndefined();
  expect(pauses).toBe(2);
});

test("a row with an offset that wrapped adds no hint and counts on its own", async () => {
  const reader: CountReader = {
    value: (row, column) => {
      if (column === "marks") return row === 0 ? Marks.WRAPPED_OFFSET : 0;
      return column === "method" || column === "flags" ? 0 : 10;
    },
    name: () => "f.txt",
  };
  const counts = await countRows(reader, 3, () => true);
  expect(counts).toEqual({ bytes: 30, leftOut: 0, wrapped: 1, hint: { loose: 20, formats: 0 } });
});

test("a folder row with an offset that wrapped does not count, because the copy keeps it", async () => {
  const rows = [
    { name: "folder/", size: 0, crc32: 0 },
    { name: "empty.txt", size: 0, crc32: 0 },
    // The rule of `Kind::Folder`: a name that ends with a slash alone is not a folder.
    { name: "data/", size: 5, crc32: 1 },
    { name: "crc/", size: 0, crc32: 1 },
  ];
  const reader: CountReader = {
    value: (row, column) => {
      if (column === "marks") return Marks.WRAPPED_OFFSET;
      if (column === "uncompressedSize" || column === "compressedSize") return rows[row]!.size;
      if (column === "crc32") return rows[row]!.crc32;
      return 0;
    },
    name: (row) => rows[row]!.name,
  };
  const counts = await countRows(reader, rows.length, () => true);
  expect(counts?.wrapped).toBe(3);
});

test("a folder row that is encrypted or has another method does not count, because the copy keeps it", async () => {
  const rows = [
    { name: "enc/", size: 0, crc32: 0, flags: 1, method: 0 },
    { name: "other/", size: 0, crc32: 0, flags: 0, method: 12 },
    // The rule of `Kind::Folder`: a name that ends with a slash alone is not a folder.
    { name: "enc.txt", size: 0, crc32: 0, flags: 1, method: 0 },
    { name: "data/", size: 5, crc32: 1, flags: 1, method: 0 },
    { name: "crc/", size: 0, crc32: 1, flags: 0, method: 12 },
  ];
  const reader: CountReader = {
    value: (row, column) => {
      const item = rows[row]!;
      if (column === "uncompressedSize" || column === "compressedSize") return item.size;
      if (column === "marks") return 0;
      return item[column];
    },
    name: (row) => rows[row]!.name,
  };
  const counts = await countRows(reader, rows.length, () => true);
  expect(counts?.leftOut).toBe(3);
});

const mapOf = (
  counts: Partial<LayoutCounts>,
  ...regions: [RegionKind, number, number][]
): ByteMap => ({
  ok: true,
  counts: {
    rows: 1,
    badHeaders: 0,
    pastDirectory: 0,
    intoDirectory: 0,
    overlapping: 0,
    missingDescriptors: 0,
    gaps: 0,
    gapBytes: 0,
    otherDiskRows: 0,
    zip64Rows: 0,
    ...counts,
  },
  regions: regions.map(([kind, start, end]) => ({
    kind,
    start,
    end,
    label: RegionLabel.NONE,
    foldedGaps: 0,
    foldedBytes: 0,
  })),
});

test("the bytes outside the entries are the prelude, all gaps and the epilogue", () => {
  const regions: [RegionKind, number, number][] = [
    [RegionKind.PRELUDE, 0, 100],
    [RegionKind.ENTRIES, 100, 200],
    [RegionKind.GAP, 200, 220],
    [RegionKind.ENTRIES, 220, 300],
    [RegionKind.DIRECTORY, 300, 350],
    [RegionKind.END_RECORD, 350, 372],
    [RegionKind.EPILOGUE, 372, 1000],
  ];
  // The sum of the gaps also has the gaps that the map does not list one by one.
  expect(outsideBytes(mapOf({ gaps: 3, gapBytes: 25 }, ...regions))).toBe(100 + 25 + 628);
  expect(outsideBytes(mapOf({}, [RegionKind.ENTRIES, 0, 300]))).toBe(0);
});

test("the map gives no such value when a row has no place in it, or when it failed", () => {
  const prelude: [RegionKind, number, number] = [RegionKind.PRELUDE, 0, 100];
  expect(outsideBytes(mapOf({ badHeaders: 1 }, prelude))).toBeUndefined();
  expect(outsideBytes(mapOf({ pastDirectory: 1 }, prelude))).toBeUndefined();
  expect(outsideBytes({ ok: false, error: "memory" })).toBeUndefined();
});
