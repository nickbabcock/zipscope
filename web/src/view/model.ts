// Pure helpers for the tree and the table: row labels, tree records and
// size bars. The worker rules are in crates/core/src/tree.rs and view.rs.
import { FOLDER_TAG, NONE, TREE_RECORD_WORDS, TreeInfo } from "../contracts";

/** Returns true for a tagged folder index. */
export function isFolder(tagged: number): boolean {
  return (tagged & FOLDER_TAG) !== 0;
}

/** Returns the folder id of a tagged folder index. */
export function folderId(tagged: number): number {
  return (tagged & ~FOLDER_TAG) >>> 0;
}

const SEPARATORS = /[/\\]/;

/**
 * Returns the label of an entry row in its folder: the last segment of the
 * path. `/` and `\` are separators. A folder entry (a name that ends with
 * a separator) gets a `/`. A name with no segments shows as it is.
 */
export function entryLabel(name: string): string {
  const segments = name.split(SEPARATORS).filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  if (last === undefined) {
    return name;
  }
  return SEPARATORS.test(name.at(-1) ?? "") ? `${last}/` : last;
}

/** One decoded flattened tree record. */
export interface TreeRow {
  /** The last folder of the row: the folder that the row opens. */
  folder: number;
  /** The level, from 0 for the root row. */
  level: number;
  /** The folders in the row, minus 1. */
  chain: number;
  hasChildren: boolean;
  expanded: boolean;
  /** The place in the parent row, from 1, and the number of rows there. */
  position: number;
  size: number;
}

/** Decodes tree row `row` from the words of a flattened tree. */
export function treeRow(words: Uint32Array, row: number): TreeRow {
  const at = row * TREE_RECORD_WORDS;
  const info = words[at + 1]!;
  return {
    folder: folderId(words[at]!),
    level: info & TreeInfo.LEVEL_MASK,
    chain: (info >>> TreeInfo.CHAIN_SHIFT) & TreeInfo.CHAIN_MASK,
    hasChildren: (info & TreeInfo.HAS_CHILDREN) !== 0,
    expanded: (info & TreeInfo.EXPANDED) !== 0 && (info & TreeInfo.HAS_CHILDREN) !== 0,
    position: words[at + 2]!,
    size: words[at + 3]!,
  };
}

/**
 * Returns the index of the tree row that ends at `folder`, or -1. It reads
 * only word 0 of each record and does not decode the rows, because the
 * frame loop calls it with up to millions of rows.
 */
export function treeIndexOf(words: Uint32Array, rows: number, folder: number): number {
  for (let index = 0; index < rows; index++) {
    if (folderId(words[index * TREE_RECORD_WORDS]!) === folder) {
      return index;
    }
  }
  return -1;
}

/** A tree row that the landing of the name order keeps in place. */
export interface TreeAnchor {
  folder: number;
  /** The rows from the top of the viewport to the row, with a fraction. */
  rowsFromTop: number;
}

/** The rows that can stay in place when the name order lands. */
export interface TreeAnchors {
  /** The row of a move whose request has not been published yet. */
  moving?: TreeAnchor | undefined;
  /** The selected row, when it shows in the viewport. */
  selected?: TreeAnchor | undefined;
  /** The row at the top of the viewport. */
  top: TreeAnchor;
}

/**
 * Returns the first row, with a fraction, that keeps a row in place when the
 * name order lands: the row of a move, else the selected row, else the top row.
 * The first of them that the new tree has wins. Returns undefined when it has
 * none of them. The scroll limits can still move the row, at the ends of the
 * tree.
 */
export function landingFirstRow(
  words: Uint32Array,
  rows: number,
  anchors: TreeAnchors,
): number | undefined {
  for (const anchor of [anchors.moving, anchors.selected, anchors.top]) {
    if (anchor === undefined) continue;
    const index = treeIndexOf(words, rows, anchor.folder);
    if (index >= 0) return index - anchor.rowsFromTop;
  }
  return undefined;
}

/** The folder table as the chain walk reads it. */
export interface FolderSource {
  folderName(folder: number): string;
  folderParent(folder: number): number;
}

/** A chain row: its first folder and the names of all its folders. */
export interface Chain {
  head: number;
  names: string[];
}

/**
 * Walks up from the last folder of a chain row. It stops after `steps`
 * parents, or at `stop`, or at the root. A torn read cannot make it loop:
 * it takes at most `limit` steps.
 */
export function walkChain(
  folders: FolderSource,
  tail: number,
  options: { steps?: number; stop?: number; limit?: number },
): Chain {
  const names: string[] = [];
  const limit = options.limit ?? 1 << 16;
  let folder = tail;
  let head = tail;
  for (let step = 0; step < limit; step++) {
    names.push(folders.folderName(folder));
    head = folder;
    if (options.steps !== undefined && step >= options.steps) {
      break;
    }
    const parent = folders.folderParent(folder);
    if (parent === NONE || parent === options.stop || parent === 0) {
      break;
    }
    folder = parent;
  }
  names.reverse();
  return { head, names };
}

/**
 * Returns the width of a size bar in percent. A value of 0 has no bar. A
 * value above 0 has at least 2%, so that it shows.
 */
export function barWidth(value: number, total: number): number {
  if (!(value > 0) || !(total > 0)) {
    return 0;
  }
  return Math.min(100, (value / total) * 100);
}

/** The least true width of a bar, in pixels. */
const BAR_MIN_PX = 3;

/** Returns true when a share of `total` draws a bar in a slot of this width. A
 *  smaller share has no bar and its number stays exact: shares from 0.1% to 6%
 *  would all draw the same speck, and a column of specks says nothing. */
export function hasBar(value: number, total: number, slot: number): boolean {
  return total > 0 && (value / total) * slot >= BAR_MIN_PX;
}
