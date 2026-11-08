// The sort order of the table and the order in which a column header
// moves through it.
import { BEST_MATCH_ORDER, SORT_DESCENDING, SortColumn } from "../contracts";

/** The sort order of the table. `SortColumn.ARCHIVE` is no sort. */
export interface TableSort {
  column: SortColumn;
  descending: boolean;
}

export const ARCHIVE_ORDER: TableSort = { column: SortColumn.ARCHIVE, descending: false };

/** The id of the text that tells the order of the listing in words. */
export const SORT_STATUS_ID = "sort-status";

/** The order of a search when the user chose no sort. No column has it, so no
 *  header shows it, and the user cannot request it. */
export const BEST_MATCH = { column: BEST_MATCH_ORDER, descending: false } as const;

/** The order of a listing: a sort, or the best-match order. */
export type ListedSort = TableSort | typeof BEST_MATCH;

/** True for the best-match order. */
export function isBestMatch(sort: ListedSort): sort is typeof BEST_MATCH {
  return sort.column === BEST_MATCH_ORDER;
}

/** Returns the order that `LISTING_SORT_n` holds. */
export function listingSort(value: number): ListedSort {
  if (value === 0) return ARCHIVE_ORDER;
  if (value === BEST_MATCH_ORDER) return BEST_MATCH;
  return { column: (value & 0xff) as SortColumn, descending: (value & SORT_DESCENDING) !== 0 };
}

/** True when two orders are the same. */
export function sameSort(a: ListedSort, b: ListedSort): boolean {
  return a.column === b.column && a.descending === b.descending;
}

/** Returns the sort that a history entry keeps, or undefined when it keeps
 *  none or not a valid sort: then the user chose no sort, and the default
 *  applies. An entry records archive order only when the user chose it, so it
 *  stays archive order. This is also true of an entry of an older version of
 *  the app, which recorded a sort only after a sort request. */
export function keptSort(value: unknown): TableSort | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { column, descending } = value as Partial<TableSort>;
  const columns: readonly unknown[] = Object.values(SortColumn);
  if (!columns.includes(column)) return undefined;
  if (typeof descending !== "boolean") return undefined;
  return column === SortColumn.ARCHIVE
    ? ARCHIVE_ORDER
    : { column: column as SortColumn, descending };
}

/** Columns that sort from the largest value first. Names and methods sort
 *  A to Z, and ratio from the best compression. */
const DESCENDING_FIRST: readonly SortColumn[] = [
  SortColumn.SIZE,
  SortColumn.COMPRESSED,
  SortColumn.MODIFIED,
];

/** Returns the next sort when the user activates a column header: its
 *  first direction, then the other direction, then archive order. No header
 *  has the best-match order, so each header starts at its first direction. */
export function nextSort(current: ListedSort, column: SortColumn): TableSort {
  const first = DESCENDING_FIRST.includes(column);
  if (current.column !== column) {
    return { column, descending: first };
  }
  if (current.descending === first) {
    return { column, descending: !first };
  }
  return ARCHIVE_ORDER;
}
