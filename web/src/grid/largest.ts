// The largest files below a short listing. The worker ranks
// the files (crates/core/src/largest.rs) and publishes them with the
// listing. This module decides where the table shows them.
import { LARGEST_FILES, NONE, ROLLUP_RECORD_BYTES, TreeInfo } from "../contracts";
import type { ViewSet } from "../store/reader";

/** The rows of the block: a label row and the files. The fit rule
 *  reserves all of them, also for fewer files, so that the rule does not
 *  change with the number of files. */
export const BLOCK_ROWS = 1 + LARGEST_FILES;

/** The space above the label row, in pixels, so that the block reads as
 *  a second group. The fit rule reserves it.
 *  It does not change with the row height. */
export const BLOCK_GAP = 8;

/** The label of the block. */
export const LARGEST_LABEL = "Largest files under this folder";
/** The id of the node that describes each row of the block. */
export const LARGEST_LABEL_ID = "largest-files-label";

/** A file must hold at least this part of the bytes of the listed folder,
 *  as 1 / SHARE_DIVISOR (5%), for the block to show. */
const SHARE_DIVISOR = 20;

/** The rows of the table: the listing, then the block when it shows. */
export interface TableRows {
  /** All rows, with the label row and the files. */
  count: number;
  /** The rows of the listing. */
  listing: number;
  /** The index of the label row, or -1 when the block does not show. */
  label: number;
  /** The store rows of the files that show. Empty without the block. */
  files: ArrayLike<number>;
}

/** What the block needs other than the view set. */
export interface BlockContext {
  /** The room below the column header, in rows, with a fraction. */
  visibleRows: number;
  /** The height of one row, in pixels. */
  rowHeight: number;
  /** True when the parse is complete and all its rows arrived. */
  parsed: boolean;
  /** Returns the declared uncompressed size of a store row. */
  size: (row: number) => number;
}

const NO_FILES: ArrayLike<number> = [];

/** Returns the ranked files that are not direct entries of the listed
 *  folder: the entry rows of level 0 of the listing. A direct entry is a
 *  row of the listing already, so the block would only repeat it. A row
 *  that inline expansion shows is not a direct entry. */
function belowListing(views: Pick<ViewSet, "permutation" | "info" | "largestFiles">): number[] {
  const files: number[] = [];
  for (const file of views.largestFiles) {
    let direct = false;
    for (let index = 0; index < views.permutation.length; index++) {
      if (
        views.permutation[index] === file &&
        ((views.info[index] ?? 0) & TreeInfo.LEVEL_MASK) === 0
      ) {
        direct = true;
        break;
      }
    }
    if (!direct) {
      files.push(file);
    }
  }
  return files;
}

/**
 * Returns the rows of the table. The block shows only when all of these
 * are true:
 *
 * - The parse is complete. Thus the block does not show during the parse
 *   and then go when the listing grows.
 * - The listing is of a folder (not search results), and the listing,
 *   all rows of the block and the 8 px gap above the block fit in the
 *   viewport, at the row height of the page. Thus the block never makes
 *   the table scroll, and the layout changes with the window size only at
 *   this rule.
 * - A ranked file is not a direct entry of the folder. Such a file is in
 *   a subfolder that holds bytes, so the rule that a folder row of
 *   the listing holds bytes is true too.
 * - The largest of these files holds at least 5% of the bytes of the
 *   folder. Else no file is a hog, and the block only gives many small
 *   files.
 *
 * The block shows only these files, from the largest.
 */
export function tableRows(
  views: Pick<ViewSet, "folder" | "permutation" | "info" | "largestFiles" | "rollups">,
  context: BlockContext,
): TableRows {
  const listing = views.permutation.length;
  const none = { count: listing, listing, label: -1, files: NO_FILES };
  // The listing, all rows of the block and the gap above it fit whole.
  const { rowHeight } = context;
  const fits =
    (listing + BLOCK_ROWS) * rowHeight + BLOCK_GAP <= Math.floor(context.visibleRows * rowHeight);
  // `fits` first: then the listing is short, and the scan reads few rows.
  if (!context.parsed || views.folder === NONE || views.largestFiles.length === 0 || !fits) {
    return none;
  }
  const files = belowListing(views);
  const total = views.rollups[(views.folder * ROLLUP_RECORD_BYTES) / 8];
  if (
    files.length === 0 ||
    total === undefined ||
    context.size(files[0]!) * SHARE_DIVISOR < total
  ) {
    return none;
  }
  return { count: listing + 1 + files.length, listing, label: listing, files };
}

/** Returns the tagged index of a row of the table, or undefined for the
 *  label row and a row past the end. */
export function itemAt(
  views: Pick<ViewSet, "permutation">,
  rows: TableRows,
  index: number,
): number | undefined {
  if (index < rows.listing) {
    return views.permutation[index];
  }
  if (rows.label < 0 || index <= rows.label) {
    return undefined;
  }
  return rows.files[index - rows.label - 1];
}

/** Returns true when a row of the table is a row of the block. */
export function inBlock(rows: TableRows, index: number): boolean {
  return rows.label >= 0 && index > rows.label && index < rows.count;
}

/**
 * Returns the index of `row` in the block, or -1. `hint` is its last known
 * index in the table.
 */
export function blockIndex(rows: TableRows, row: number, hint: number): number {
  if (!inBlock(rows, hint) || rows.files[hint - rows.label - 1] !== row) {
    for (let at = 0; at < rows.files.length; at++) {
      if (rows.files[at] === row) {
        return rows.label + 1 + at;
      }
    }
    return -1;
  }
  return hint;
}

/**
 * Returns the index that a key moves to from `index`: past the label row
 * in the direction of the move, and inside the table.
 */
export function moveTarget(rows: TableRows, index: number, step: number): number {
  let next = Math.min(Math.max(0, index), rows.count - 1);
  if (next === rows.label) {
    next += step < 0 ? -1 : 1;
    if (next < 0 || next >= rows.count) {
      next = rows.label + (step < 0 ? 1 : -1);
    }
  }
  return next;
}

const SEPARATORS = /[/\\]/;

/** Returns the non-empty segments of a path. `/` and `\` are
 *  separators. */
export function segments(path: string): string[] {
  return path.split(SEPARATORS).filter((segment) => segment.length > 0);
}

/**
 * Returns the number of segments after `depth` that all names share and
 * that the block leaves out. Each row keeps at least the folder of its file.
 */
export function sharedSegments(names: readonly string[], depth: number): number {
  const paths = names.map((name) => segments(name).slice(depth));
  const first = paths[0];
  if (first === undefined) return 0;
  // The last two segments of each path are its folder and its name.
  const most = Math.min(...paths.map((path) => path.length - 2));
  let shared = 0;
  while (shared < most && paths.every((path) => path[shared] === first[shared])) shared++;
  return shared;
}

/**
 * Returns the label of a row of the block, with `skip` segments left out: one
 * path depth, the folder of the file and its name, so the base names start
 * at about one place. When more folders are between, "…/" says so. The title
 * of the row has the full path.
 */
export function blockPath(name: string, skip: number): string {
  const parts = segments(name).slice(skip);
  if (parts.length === 0) return name;
  return parts.length <= 2 ? parts.join("/") : `…/${parts.slice(-2).join("/")}`;
}
