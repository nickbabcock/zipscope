import { expect, test } from "vitest";
import { BEST_MATCH_ORDER, SORT_DESCENDING, SortColumn } from "../contracts";
import { ARCHIVE_ORDER, BEST_MATCH, isBestMatch, keptSort, listingSort, nextSort } from "./sort";

/** The default sort of the core (`query::DEFAULT_SORT`). */
const DEFAULT_SORT = { column: SortColumn.SIZE, descending: true };

test("a header goes through its first direction, the other one, then archive order", () => {
  let sort = nextSort(ARCHIVE_ORDER, SortColumn.NAME);
  expect(sort).toEqual({ column: SortColumn.NAME, descending: false });
  sort = nextSort(sort, SortColumn.NAME);
  expect(sort).toEqual({ column: SortColumn.NAME, descending: true });
  expect(nextSort(sort, SortColumn.NAME)).toEqual(ARCHIVE_ORDER);
  // Sizes start from the largest. Another column starts again.
  sort = nextSort(sort, SortColumn.SIZE);
  expect(sort).toEqual({ column: SortColumn.SIZE, descending: true });
  expect(nextSort(sort, SortColumn.SIZE)).toEqual({ column: SortColumn.SIZE, descending: false });
  expect(nextSort(sort, SortColumn.RATIO)).toEqual({ column: SortColumn.RATIO, descending: false });
});

test("a kept sort is used only when it is a valid sort, also archive order", () => {
  expect(keptSort({ column: SortColumn.SIZE, descending: true })).toEqual({
    column: SortColumn.SIZE,
    descending: true,
  });
  // Archive order is a choice of the user: it does not become the default.
  expect(keptSort(ARCHIVE_ORDER)).toEqual(ARCHIVE_ORDER);
  expect(keptSort(null)).toBeUndefined();
  expect(keptSort({ column: 99, descending: true })).toBeUndefined();
  expect(keptSort({ column: SortColumn.NAME, descending: "yes" })).toBeUndefined();
});

test("the best-match order is a value of the listing, and no header has it", () => {
  expect(listingSort(BEST_MATCH_ORDER)).toBe(BEST_MATCH);
  expect(isBestMatch(listingSort(BEST_MATCH_ORDER))).toBe(true);
  expect(isBestMatch(listingSort(0))).toBe(false);
  expect(isBestMatch(listingSort(SortColumn.SIZE | SORT_DESCENDING))).toBe(false);
  expect(listingSort(SortColumn.SIZE | SORT_DESCENDING)).toEqual(DEFAULT_SORT);
  // A column is no column of the best-match order.
  expect(Object.values(SortColumn)).not.toContain(BEST_MATCH_ORDER);
  // Each header starts at its first direction, also the column of the default.
  expect(nextSort(BEST_MATCH, SortColumn.SIZE)).toEqual(DEFAULT_SORT);
  expect(nextSort(BEST_MATCH, SortColumn.NAME)).toEqual({
    column: SortColumn.NAME,
    descending: false,
  });
  // A history entry cannot keep it: it has no choice to keep.
  expect(keptSort(BEST_MATCH)).toBeUndefined();
});

test("the default sort goes through the other direction to archive order", () => {
  expect(DEFAULT_SORT).toEqual({ column: SortColumn.SIZE, descending: true });
  const other = nextSort(DEFAULT_SORT, DEFAULT_SORT.column);
  expect(other).toEqual({ column: DEFAULT_SORT.column, descending: false });
  expect(nextSort(other, DEFAULT_SORT.column)).toEqual(ARCHIVE_ORDER);
  expect(nextSort(ARCHIVE_ORDER, DEFAULT_SORT.column)).toEqual(DEFAULT_SORT);
});
