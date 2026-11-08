// The table columns and which of them show. The shell decides the hidden
// set from the layout and the column picker. The table only applies it.

import { SortColumn } from "../contracts";

/** The least width that a name keeps, in pixels. */
export const NAME_MIN = 200;

/** The most width of the name column of a folder listing. The columns
 *  start right after it and the free width stays after the last column, so
 *  the eye does not cross a blank row to reach Size, and Size stays at one
 *  place from folder to folder, also when an empty column collapses. Search
 *  results have long paths and no such place, so they have no cap. */
export const NAME_CAP = 400;

/** The width of the size text, the size bar and the gap between them, in
 *  pixels. The text is right-aligned, so a usual size is about 12 px from the
 *  bar. The bar is one of the first things that leave a table with no room. */
export const SIZE_TEXT = 72;
export const BAR_SLOT = 48;
/** The bar slot of a narrow table (below `NARROW_TABLE`). */
export const BAR_SLOT_NARROW = 32;
export const NARROW_TABLE = 700;
export const SIZE_GAP = 4;
const SIZE_BAR = BAR_SLOT + SIZE_GAP;

/** The table columns, in display order. `px` is the least width. */
export const COLUMNS = [
  {
    sort: SortColumn.NAME,
    key: "name",
    label: "Name",
    kind: "name",
    width: `minmax(0, var(--name-cap, ${NAME_CAP}px))`,
    px: NAME_MIN,
  },
  {
    sort: SortColumn.SIZE,
    key: "size",
    label: "Size",
    kind: "numeric",
    width: `${SIZE_TEXT + SIZE_BAR}px`,
    px: SIZE_TEXT + SIZE_BAR,
  },
  {
    sort: SortColumn.COMPRESSED,
    key: "compressed",
    label: "Compressed",
    kind: "numeric",
    width: "88px",
    px: 88,
  },
  { sort: SortColumn.RATIO, key: "ratio", label: "Ratio", kind: "numeric", width: "56px", px: 56 },
  // No sort: the count of a folder, in the place that Method leaves free in a
  // listing of folders. It shows only in a view with folder rows.
  { sort: undefined, key: "entries", label: "Entries", kind: "numeric", width: "56px", px: 56 },
  {
    sort: SortColumn.METHOD,
    key: "method",
    label: "Method",
    kind: "muted",
    // "ZipCrypto · Stored" and 8 px of space after the right-aligned Ratio.
    width: "132px",
    px: 132,
  },
  {
    sort: SortColumn.MODIFIED,
    key: "modified",
    label: "Modified",
    kind: "muted",
    width: "120px",
    px: 120,
  },
] as const;

/** The gap between columns and the padding at each side, in pixels. The
 *  table grid styles use the same values. */
const COLUMN_GAP = 16;
const TABLE_PADDING = 12;

export type ColumnKey = (typeof COLUMNS)[number]["key"];

/** The size bar leaves the table as a column does, but the picker does not
 *  list it. */
export const BAR = "bar";

/** A set of hidden columns. The name column always shows. */
export type HiddenColumns = ReadonlySet<ColumnKey | typeof BAR>;

/** The columns that the column picker can show and hide. */
export const OPTIONAL_COLUMNS: readonly ColumnKey[] = COLUMNS.filter(
  (column) => column.key !== "name" && column.key !== "entries",
).map((column) => column.key);

/** Hidden by default while the preview is open, to give names room. */
export const HIDDEN_WITH_PREVIEW: HiddenColumns = new Set<ColumnKey>(["compressed", "method"]);

/** In the narrow layout, the table shows only the name and the size. */
export const HIDDEN_WHEN_NARROW: HiddenColumns = new Set<ColumnKey>([
  "entries",
  ...OPTIONAL_COLUMNS.filter((key) => key !== "size"),
]);

/** Returns the `grid-template-columns` value for the shown columns. */
export function gridTemplate(hidden: HiddenColumns, slot = BAR_SLOT): string {
  return COLUMNS.filter((column) => !hidden.has(column.key))
    .map((column) =>
      column.key !== "size"
        ? column.width
        : hidden.has(BAR)
          ? `${SIZE_TEXT}px`
          : `${SIZE_TEXT + SIZE_GAP + slot}px`,
    )
    .join(" ");
}

/** Returns a copy of `hidden` with `key` shown or hidden. */
export function toggleColumn(hidden: HiddenColumns, key: ColumnKey, show: boolean): HiddenColumns {
  const next = new Set(hidden);
  if (show || key === "name") {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

/** Returns the least width of the table with these columns hidden: the
 *  fixed columns, the gaps, the padding and `NAME_MIN` for the name. */
export function tableMinWidth(hidden: HiddenColumns): number {
  const shown = COLUMNS.filter((column) => !hidden.has(column.key));
  const columns = shown.reduce(
    (sum, column) => sum + column.px - (column.key === "size" && hidden.has(BAR) ? SIZE_BAR : 0),
    0,
  );
  return columns + COLUMN_GAP * (shown.length - 1) + TABLE_PADDING * 2;
}

/** The parts that leave first when the table has no room for them: the
 *  bar, and then the minor columns. The name keeps its room, so the base
 *  name of a file stays whole. */
export const DROP_ORDER: readonly (ColumnKey | typeof BAR)[] = [
  "entries",
  BAR,
  "modified",
  "ratio",
  "method",
  "compressed",
  "size",
];

/** The least width of a table that shows only the name and the size text.
 *  The preview gives way to this width. */
export const TABLE_FLOOR = tableMinWidth(
  new Set([BAR, "entries", "compressed", "ratio", "method", "modified"]),
);

/**
 * Returns `hidden` with more columns hidden, in `DROP_ORDER`, until the
 * table fits in `room` pixels or only the name is left. Thus a name keeps
 * `NAME_MIN` pixels and the table does not scroll sideways.
 */
export function fitColumns(hidden: HiddenColumns, room: number): HiddenColumns {
  const next = new Set(hidden);
  for (const key of DROP_ORDER) {
    if (tableMinWidth(next) <= room) {
      break;
    }
    next.add(key);
  }
  return next.size === hidden.size ? hidden : next;
}
