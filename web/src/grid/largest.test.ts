import { describe, expect, test } from "vitest";
import { FOLDER_TAG, NONE } from "../contracts";
import {
  BLOCK_ROWS,
  blockIndex,
  blockPath,
  inBlock,
  itemAt,
  moveTarget,
  sharedSegments,
  tableRows,
} from "./largest";

/** A folder item of the listing: folder 2. */
const F = (FOLDER_TAG | 2) >>> 0;

/** A view set of folder 3, whose rollup is `total`. `levels` gives the
 *  level of each listing row (0 when not given). */
const views = (
  listing: number[],
  files: number[],
  { folder = 3, total = 100, levels = [] as number[] } = {},
) => {
  const rollups = new Float64Array(3 * 4);
  if (folder !== NONE) rollups[folder * 3] = total;
  return {
    folder,
    permutation: Uint32Array.from(listing),
    info: Uint32Array.from(listing, (_, index) => levels[index] ?? 0),
    largestFiles: Uint32Array.from(files),
    rollups,
  };
};

/** Each store row has its number as its size, so row 50 holds 50 bytes:
 *  50% of a folder of 100 bytes. */
const context = (visibleRows: number, parsed = true, rowHeight = 24) => ({
  visibleRows,
  rowHeight,
  parsed,
  size: (row: number) => row,
});

describe("tableRows", () => {
  test("shows the block only when the listing and all block rows fit", () => {
    const set = views([F, 11, 12], [70, 8]);
    // 3 listing rows, 11 block rows and the 8 px gap above the block need
    // 14 rows and 8 px (the fit rule reserves the gap).
    expect(tableRows(set, context(14))).toEqual({ count: 3, listing: 3, label: -1, files: [] });
    expect(tableRows(set, context(14 + 7 / 24))).toMatchObject({ label: -1 });
    const rows = tableRows(set, context(14 + 8 / 24));
    expect(rows).toMatchObject({ count: 6, listing: 3, label: 3 });
    expect(Array.from(rows.files)).toEqual([70, 8]);
    expect(BLOCK_ROWS).toBe(11);
  });

  test("fits the block with the row height of a coarse pointer", () => {
    const set = views([F, 11, 12], [70, 8]);
    // 14 rows of 36 px and the 8 px gap: 512 px.
    expect(tableRows(set, context(14 + 7 / 36, true, 36))).toMatchObject({ label: -1 });
    expect(tableRows(set, context(14 + 8 / 36, true, 36))).toMatchObject({ label: 3 });
    // A viewport of 400 px holds the block of 24 px rows (344 px), but
    // not the block of 36 px rows.
    expect(tableRows(set, context(400 / 24, true, 24))).toMatchObject({ label: 3 });
    expect(tableRows(set, context(400 / 36, true, 36))).toMatchObject({ label: -1 });
  });

  test("has no block for search results or without files", () => {
    expect(tableRows(views([1], [70], { folder: NONE }), context(100)).label).toBe(-1);
    expect(tableRows(views([F, 1], []), context(100)).label).toBe(-1);
  });

  test("has no block before the parse is complete", () => {
    // The block shows only after the parse, so it does not
    // show during the parse and then go when the listing grows.
    expect(tableRows(views([F, 11], [70]), context(100, false)).label).toBe(-1);
    expect(tableRows(views([F, 11], [70]), context(100, true)).label).toBe(2);
  });

  test("leaves out the direct entries of the folder", () => {
    // A direct entry is a row of the listing already.
    const rows = tableRows(views([F, 60, 11], [60, 30, 11, 9]), context(100));
    expect(rows).toMatchObject({ count: 6, listing: 3, label: 3 });
    expect(Array.from(rows.files)).toEqual([30, 9]);
    // A flat folder: all files are direct entries, so no block.
    expect(tableRows(views([10, 11], [11, 10]), context(100)).label).toBe(-1);
    // A row that inline expansion shows (level 1) is not a direct entry.
    const open = tableRows(views([F, 30, 11], [30, 11], { levels: [0, 1, 0] }), context(100));
    expect(Array.from(open.files)).toEqual([30]);
  });

  test("shows the block only when a file holds 5% of the folder", () => {
    // Else no file is a hog. 5 bytes of 100 is 5%.
    expect(tableRows(views([F], [5, 4]), context(100)).label).toBe(1);
    expect(Array.from(tableRows(views([F], [5, 4]), context(100)).files)).toEqual([5, 4]);
    expect(tableRows(views([F], [5, 4], { total: 101 }), context(100)).label).toBe(-1);
    // The share of a file that is not a direct entry decides.
    expect(tableRows(views([F, 50], [50, 4]), context(100)).label).toBe(-1);
  });
});

test("rows of the table map to the listing, the label and the files", () => {
  const set = views([F, 11], [70, 8, 6]);
  const rows = tableRows(set, context(40));
  expect([0, 1, 2, 3, 4, 5, 6].map((index) => itemAt(set, rows, index))).toEqual([
    F,
    11,
    undefined,
    70,
    8,
    6,
    undefined,
  ]);
  expect([1, 2, 3, 5, 6].map((index) => inBlock(rows, index))).toEqual([
    false,
    false,
    true,
    true,
    false,
  ]);
  expect(blockIndex(rows, 6, 5)).toBe(5);
  expect(blockIndex(rows, 6, 1)).toBe(5);
  expect(blockIndex(rows, 99, 4)).toBe(-1);
});

test("keys move past the label row", () => {
  const set = views([F, 11], [70, 8]);
  const rows = tableRows(set, context(40));
  expect(moveTarget(rows, 2, 1)).toBe(3);
  expect(moveTarget(rows, 2, -1)).toBe(1);
  expect(moveTarget(rows, 99, 1)).toBe(4);
  expect(moveTarget(rows, -5, -1)).toBe(0);
  // A listing of one folder row: the keys go over the label row both ways.
  const alone = tableRows(views([F], [70]), context(40));
  expect(moveTarget(alone, 1, 1)).toBe(2);
  expect(moveTarget(alone, 1, -1)).toBe(0);
});

test("the block leaves out the folders that all its rows share", () => {
  // All rows are below `app/src/`, and each row keeps the folder of its file.
  expect(
    sharedSegments(["app/src/deep/huge.bin", "app/src/deep/big.bin", "app/src/deep/x/y.bin"], 1),
  ).toBe(1);
  // The rows go to different folders below `app/`.
  expect(sharedSegments(["app/src/main.rs", "app/docs/guide.md"], 1)).toBe(0);
  // The folder of the file stays, also when it is the same for all rows.
  expect(sharedSegments(["app/sub/hog.bin", "app/sub/tiny.txt"], 1)).toBe(0);
  expect(sharedSegments(["a/b/c/one.bin"], 0)).toBe(2);
  expect(sharedSegments([], 0)).toBe(0);
});

test("a path of the block has one depth", () => {
  expect(blockPath("app/src/deep/huge.bin", 1)).toBe("…/deep/huge.bin");
  expect(blockPath("app/src/main.rs", 1)).toBe("src/main.rs");
  expect(blockPath("app\\src//big.bin", 2)).toBe("big.bin");
  expect(blockPath("top.bin", 0)).toBe("top.bin");
  expect(blockPath("odd", 3)).toBe("odd");
});
