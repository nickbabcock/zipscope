import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, onSettled, untrack } from "solid-js";
import { Marks, NONE, ROLLUP_RECORD_BYTES, State, TimeKind, TreeInfo } from "../contracts";
import type { SortColumn } from "../contracts";
import {
  exactBytes,
  copiedRatio,
  formatCount,
  integers,
  formatMethod,
  formatModified,
  formatRatio,
  settling,
  settlingSize,
} from "../format";
import { controls } from "../shell/controls";
import { MirrorReader } from "../store/reader";
import type { ViewSet } from "../store/reader";
import { barWidth, entryLabel, folderId, hasBar, isFolder, walkChain } from "../view/model";
import { isBestMatch, SORT_STATUS_ID } from "../view/sort";
import type { ListedSort } from "../view/sort";
import { color, textSize } from "../theme/tokens.stylex";
import { addChevron, cls, createBar, setBar, shared, turnChevron } from "../view/styles";
import { spreadsheetText } from "./tsv";
import type { GridActions } from "./actions";
import { sameColumns } from "../shell/columns";
import {
  BAR,
  BAR_SLOT,
  BAR_SLOT_NARROW,
  COLUMNS,
  gridTemplate,
  NAME_CAP,
  NARROW_TABLE,
  SIZE_TEXT,
} from "./columns";
import type { ColumnKey, HiddenColumns } from "./columns";
import type { Frame, FrameLoop, Prepared } from "./frame";
import { mountRowPool } from "./mount";
import { ROW_HEIGHT, RowPool } from "./row-pool";
import type { PoolRow } from "./row-pool";
import { COARSE_POINTER } from "./scroll";
import { ANCHORS } from "./anchors";
import { RowMenu } from "./RowMenu";
import type { MenuTarget, Rect, RowMenuApi } from "./RowMenu";
import { chainTruncate, fontOf, pathTruncate, TextWidths } from "./truncate";
import { directed, isPlainName, nameText, nameTitle } from "../label";
import {
  blockIndex,
  inBlock,
  BLOCK_GAP,
  blockPath,
  itemAt,
  LARGEST_LABEL,
  LARGEST_LABEL_ID,
  moveTarget,
  segments,
  sharedSegments,
  tableRows,
} from "./largest";
import type { TableRows } from "./largest";
import { DOS_NOTE, DOS_NOTE_ID, TimeKinds } from "./times";
import { tableText } from "./strings";
import { STOPPED_ID } from "../health/findings";
import { Icon, iconMarkup } from "../shell/icons";

export interface TableViewProps {
  reader: MirrorReader;
  /** True when the health report has rows with data that overlap. Then each row
   *  with `marks` bit 3 has the error mark. Else that mark is a warning. */
  overlapError: boolean;
  loop: FrameLoop;
  sort: ListedSort;
  /** True after the hard stop, when the worker refuses each sort. The
   *  sort buttons are off, but stay in the focus order. */
  sortStopped: boolean;
  /** True after the hard stop, when the worker refuses each folder
   *  request. Folder rows have no toggle and do not open. */
  foldersStopped: boolean;
  onSort: (column: SortColumn) => void;
  /** True when Enter in the search field waits for the results in this set. */
  firstRowReady: (views: ViewSet) => boolean;
  /** The table acted on Enter in the search field. */
  onFirstRowDone: () => void;
  /** Changes when the search or sort changes. */
  listingKey: string;
  /** The folder that the location lists, or undefined for a search. */
  locationFolder: number | undefined;
  /** The columns that the shell hides. */
  hidden: HiddenColumns;
  /** Navigation: Enter on a folder, Backspace and "show in tree". */
  actions: GridActions;
  /** Opens or closes a folder row in place. With `deep`, all folders
   *  below it change too. */
  onExpand: (folder: number, open: boolean, deep: boolean) => void;
  /** Gives the actions that the shell starts on the table. */
  api: (api: TableApi) => void;
  /** Enter, a double-click or the menu chose an entry: the preview
   *  opens and shows it. `row` is its store row. */
  onOpenEntry: (name: string, row: number) => void;
  /** The selection moved: the full name and the row of an entry, or
   *  undefined. A click only selects. */
  onSelect: (name: string | undefined, row: number | undefined) => void;
  /** True when a control of the front door opened this archive. The table
   *  takes the focus on its first frame with rows, with no selected row. */
  revealFocus?: boolean;
  /** The full name of a file to select when it shows in the largest files
   *  below the listing. */
  revealFile?: string;
  /** Space: shows or hides the preview. */
  onTogglePreview: (name: string | undefined, row: number | undefined) => void;
  /** Escape: closes the preview. */
  onClosePreview: () => void;
  /** Returns the folder that lists a row, or the folder of an explicit
   *  row with FOLDER_TAG (`ParseWorkerApi.entryFolder`). */
  entryFolder: (row: number) => Promise<number>;
  /** The menu chose Extract for an entry or a folder. */
  onExtract: (target: MenuTarget) => void;
  /** True when the listed folder has no entries, after the parse. */
  onEmpty?: (empty: boolean) => void;
  /** Opens the file picker: the next action of an empty archive. */
  onPick?: () => void;
}

const ignore = () => {};

/** Header height, indent of one level and the toggle slot, in pixels. A
 *  coarse pointer gets a toggle slot of 32 px, so that a finger can hit
 *  it. See `styles.toggleCoarse`. */
const HEADER = 28;
const INDENT = 16;
const TOGGLE = COARSE_POINTER ? 32 : 16;
const NAME_GAP = 8;
/** The gap between the name column and the Size column. A row with no bar
 *  gives this gap and the bar slot to its name. */
const COLUMN_GAP = 16;
/** A row that holds this share of the listed folder has a bold size. */
const STRONG_SHARE = 0.25;
/** The longest listing that is scanned for empty columns. */
const COLLAPSE_SCAN = 4096;
const NO_COLUMNS: HiddenColumns = new Set();
/** The kind bits of the `encryption` column. */
const ENCRYPTION_KIND = 0x7f;
/** The width of the health mark of an entry. */
const MARK_SIZE = 12;

/** The names of the marks, for the accessible name of the health mark. */
const MARK_NAMES: [number, string][] = [
  [Marks.OVERLAP, "place overlaps another entry"],
  [Marks.BOMB_RATIO, "bomb-like ratio"],
  [Marks.DUPLICATE_NAME, "same name as another entry"],
  [Marks.DEPTH_CAP, "path deeper than 256 folders"],
  [Marks.FOLDER_CAP, "in the deepest folder at the folder limit"],
  [Marks.CONTROL_NAME, "name with hidden or control characters"],
  [Marks.WRAPPED_OFFSET, "cannot be read here, because the archive has no Zip64"],
];
/** The name of `marks` bit 3 when the report has rows with data that overlap. */
const OVERLAP_DATA_NAME = "bytes overlap another entry";
const MARK_LOCK = iconMarkup("lock", MARK_SIZE);
const MARK_CRIT = iconMarkup("failed", MARK_SIZE);
const MARK_WARN = iconMarkup("alert", MARK_SIZE);

/** Shows the health mark of an entry: `circle-x` (crit) for a zip bomb,
 *  `triangle-alert` (warn) for the other findings, or nothing. An overlap is a
 *  zip bomb only when `overlapError` is true (see `findings.ts`). */
function setMark(mark: HTMLElement, marks: number, overlapError: boolean): void {
  if (marks === 0) {
    if (!mark.hidden) {
      mark.hidden = true;
      mark.removeAttribute("aria-label");
      mark.removeAttribute("title");
      mark.removeAttribute("data-severity");
    }
    return;
  }
  const crit = (marks & (overlapError ? Marks.OVERLAP | Marks.BOMB_RATIO : Marks.BOMB_RATIO)) !== 0;
  const text = `Health: ${MARK_NAMES.filter(([bit]) => (marks & bit) !== 0)
    .map(([bit, name]) => (bit === Marks.OVERLAP && overlapError ? OVERLAP_DATA_NAME : name))
    .join(", ")}`;
  if (mark.getAttribute("aria-label") !== text) {
    mark.innerHTML = crit ? MARK_CRIT : MARK_WARN;
    mark.className = crit ? MARK_CRIT_CLASS : MARK_WARN_CLASS;
    mark.dataset.severity = crit ? "error" : "warning";
    mark.setAttribute("aria-label", text);
    mark.title = text;
  }
  mark.hidden = false;
}

// The styles come before the module constants that use them.
const styles = stylex.create({
  viewport: {
    contain: "strict",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    outline: "none",
    overflowY: "auto",
    position: "relative",
  },
  grid: {
    alignItems: "center",
    boxSizing: "border-box",
    columnGap: 16,
    display: "grid",
    // The shell sets the shown columns. See `gridTemplate`.
    gridTemplateColumns: "var(--table-columns, minmax(0, 400px) 136px 88px 56px 132px 120px)",
    paddingInline: 12,
  },
  header: {
    backgroundColor: color.raised,
    borderBottomColor: color.rule,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    color: color.inkMuted,
    fontSize: textSize.label,
    // The layer starts below the header, at `top: 28`.
    height: 28,
    letterSpacing: "0.04em",
    position: "sticky",
    textTransform: "uppercase",
    top: 0,
    zIndex: 1,
  },
  layer: {
    insetInline: 0,
    position: "absolute",
    top: 28,
  },
  row: {
    borderBottomColor: `color-mix(in oklab, ${color.rule} 55%, transparent)`,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    cursor: "default",
    fontVariantNumeric: "tabular-nums",
    // ROW_HEIGHT. StyleX needs literal values.
    height: 24,
    insetInline: 0,
    // 24px less the 1px rule at the bottom.
    lineHeight: "23px",
    position: "absolute",
    top: 0,
    willChange: "transform",
  },
  /** The row for a coarse pointer: COARSE_ROW_HEIGHT, and the line height
   *  is 1 px less for the rule at the bottom. */
  rowCoarse: {
    height: 36,
    lineHeight: "35px",
  },
  cell: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  name: {
    alignItems: "center",
    display: "flex",
    gap: 8,
  },
  toggle: {
    alignItems: "center",
    color: color.inkMuted,
    display: "flex",
    flexShrink: 0,
    height: 16,
    justifyContent: "center",
    width: 16,
  },
  /** For a coarse pointer, the toggle is the full row height (less the
   *  rule) and 32 px wide, and all of it is the hit area. */
  toggleCoarse: {
    alignSelf: "stretch",
    height: "auto",
    width: 32,
  },
  toggleEmpty: {
    visibility: "hidden",
  },
  toggleNone: {
    display: "none",
  },
  label: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    // Keep the spaces in names as they are.
    whiteSpace: "pre",
  },
  /** The health mark after the name. */
  mark: {
    display: "inline-flex",
    flexShrink: 0,
  },
  markCrit: {
    color: color.crit,
  },
  markWarn: {
    color: color.warn,
  },
  /** The label row of the largest files, over all columns. */
  headingName: {
    gridColumn: "1 / -1",
  },
  /** A section label: this block is the answer, not one more header. */
  headingLabel: {
    fontSize: textSize.small,
    fontWeight: 600,
  },
  numeric: {
    justifySelf: "end",
    textAlign: "right",
  },
  size: {
    alignItems: "center",
    columnGap: 4,
    display: "grid",
    // The table sets the parts of the size. See `applyColumns`.
    gridTemplateColumns: "var(--size-cells, 48px 72px)",
    justifySelf: "end",
  },
  /** 8 px of space after the right-aligned Ratio. */
  method: {
    paddingInlineStart: 8,
  },
  /** The folders of a path are ink muted, and the base name is in ink. */
  folderPart: {
    color: color.inkMuted,
  },
  lock: {
    color: color.inkMuted,
    display: "inline-flex",
    flexShrink: 0,
  },
  sizeText: {
    textAlign: "right",
  },
  /** The rows that answer "where did the space go". */
  sizeStrong: {
    fontWeight: 600,
  },
  /** The header of the sorted column. */
  sortedHeader: {
    color: color.ink,
    fontWeight: 600,
  },
  muted: {
    color: color.inkMuted,
  },
  /** The card of the DOS note below the Modified header. */
  noteCard: {
    backgroundColor: color.overlay,
    borderColor: color.overlayRule,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: color.shadow,
    color: color.ink,
    fontSize: textSize.small,
    inset: "auto",
    margin: 0,
    maxWidth: 280,
    paddingBlock: 6,
    paddingInline: 10,
    position: "fixed",
    // The card keeps its width, so that it flips when the room on the
    // right is too small, and does not wrap into that room.
    width: "max-content",
  },
  /** The Modified sort button is the anchor of the note card. */
  noteAnchor: {
    anchorName: "--dos-note",
  },
  /** Below the button, with no gap, so the pointer can go onto the card.
   *  When there is no room on the right, its right edge aligns with the
   *  right edge of the button. When a sideways scroll of the table hides
   *  the button, the card hides too (from Chrome 125, Firefox 147 and
   *  Safari 26.2). */
  noteAnchored: {
    positionAnchor: "--dos-note",
    positionArea: "block-end span-inline-end",
    positionTryFallbacks: "flip-inline",
    positionVisibility: "anchors-visible",
  },
  noTimeZone: {
    textDecorationLine: "underline",
    textDecorationStyle: "dotted",
    textUnderlineOffset: 3,
  },
  sortArrow: {
    display: { default: "inline", ":empty": "none" },
  },
  sortButton: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderWidth: 0,
    color: "inherit",
    // After the hard stop, `aria-disabled` gives the not-allowed cursor.
    cursor: { default: "pointer", ":is([aria-disabled=true])": "not-allowed" },
    display: "inline-flex",
    font: "inherit",
    gap: 4,
    letterSpacing: "inherit",
    padding: 0,
    textTransform: "inherit",
    // The whole header cell sorts.
    width: "100%",
  },
  /** A header with no sort, as after the hard stop. */
  plainHeader: {
    display: "block",
    fontSize: "inherit",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  sortEnd: {
    justifyContent: "flex-end",
  },
  /** A line of the empty table, on the name column of the rows. The empty
   *  table has no header. */
  empty: {
    alignItems: "flex-start",
    display: "flex",
    flexDirection: "column",
    insetInline: 0,
    paddingBlock: 16,
    paddingInline: 12,
    position: "absolute",
    rowGap: 12,
    top: 0,
  },
  /** The message is the lead of this view. */
  emptyText: {
    fontSize: textSize.lead,
    fontWeight: 600,
    margin: 0,
  },
  /** The search message stays below the header. */
  emptySearch: {
    paddingBlock: 8,
    top: 28,
  },
});

type ColumnKind = (typeof COLUMNS)[number]["kind"];

const cellClass = (kind: ColumnKind, noTimeZone = false) =>
  cls(
    stylex.props(
      styles.cell,
      kind === "name" ? styles.name : styles[kind],
      noTimeZone && styles.noTimeZone,
    ),
  );

const ROW_CLASS = cls(stylex.props(styles.grid, styles.row, COARSE_POINTER && styles.rowCoarse));
const NAME_CLASS = cellClass("name");
const METHOD_CLASS = cls(stylex.props(styles.cell, styles.muted, styles.method));
const FOLDER_PART_CLASS = cls(stylex.props(styles.folderPart));
const LOCK_CLASS = cls(stylex.props(styles.lock));
const MARK_CRIT_CLASS = cls(stylex.props(styles.mark, styles.markCrit));
const MARK_WARN_CLASS = cls(stylex.props(styles.mark, styles.markWarn));
/** Compressed and Ratio are ink muted, so Size, the main datum, leads.
 *  Method and Modified are muted too. */
const SECONDARY_NUMBER_CLASS = cls(stylex.props(styles.cell, styles.numeric, styles.muted));
const HEADING_NAME_CLASS = cls(stylex.props(styles.cell, styles.name, styles.headingName));
const LABEL_CLASS = cls(stylex.props(styles.label));
const HEADING_LABEL_CLASS = cls(stylex.props(styles.label, styles.headingLabel));
const SELECTED_CLASS = cls(
  stylex.props(styles.grid, styles.row, COARSE_POINTER && styles.rowCoarse, shared.selected),
);
const toggleClass = (state?: stylex.StyleXStyles) =>
  cls(stylex.props(styles.toggle, COARSE_POINTER && styles.toggleCoarse, state));
const TOGGLE_CLASS = toggleClass();
const TOGGLE_EMPTY_CLASS = toggleClass(styles.toggleEmpty);
const TOGGLE_NONE_CLASS = toggleClass(styles.toggleNone);

let nextId = 0;

/** One table row of the pool and the parts that `fillRow` changes. */
interface TableRow extends PoolRow {
  name: HTMLElement;
  /** The cells other than the name. The label row hides them. */
  others: HTMLElement[];
  toggle: HTMLElement;
  chevron: Element;
  label: HTMLElement;
  /** The folders of a path in the label, in ink muted. */
  folderPart: HTMLElement;
  /** The health mark of an entry: a tone icon with an accessible name. */
  mark: HTMLElement;
  /** The lock of an encrypted entry. */
  lock: HTMLElement;
  bar: HTMLElement;
  sizeText: HTMLElement;
  compressed: HTMLElement;
  ratio: HTMLElement;
  entries: HTMLElement;
  method: HTMLElement;
  modified: HTMLElement;
}

/** Makes one row with a cell for each column. */
function createRow(): TableRow {
  const row = document.createElement("div");
  row.id = `table-row-${nextId++}`;
  row.className = ROW_CLASS;
  row.setAttribute("role", "row");
  row.setAttribute("aria-selected", "false");
  const cells = new Map<ColumnKey, HTMLElement>();
  for (const column of COLUMNS) {
    const cell = document.createElement("span");
    cell.setAttribute("role", "gridcell");
    cell.dataset.cell = column.key;
    cell.className =
      column.key === "name"
        ? NAME_CLASS
        : column.key === "size"
          ? cls(stylex.props(styles.cell, styles.size))
          : column.key === "compressed" || column.key === "ratio" || column.key === "entries"
            ? SECONDARY_NUMBER_CLASS
            : column.key === "method"
              ? METHOD_CLASS
              : cellClass(column.kind);
    cells.set(column.key, cell);
    row.append(cell);
  }
  const cell = (key: ColumnKey) => cells.get(key)!;
  const toggle = document.createElement("span");
  toggle.className = TOGGLE_NONE_CLASS;
  toggle.dataset.part = "toggle";
  const chevron = addChevron(toggle);
  const label = document.createElement("span");
  label.className = LABEL_CLASS;
  label.dataset.part = "label";
  // A fixed direction, so a name that starts with a right-to-left letter
  // does not put its extension at the far left. See `label.ts`.
  label.dir = "ltr";
  // The health mark of an entry with a finding.
  const mark = document.createElement("span");
  mark.setAttribute("role", "img");
  mark.dataset.part = "mark";
  mark.hidden = true;
  const lock = document.createElement("span");
  lock.setAttribute("role", "img");
  lock.setAttribute("aria-label", "Encrypted");
  lock.title = "Encrypted";
  lock.dataset.part = "lock";
  lock.className = LOCK_CLASS;
  lock.innerHTML = MARK_LOCK;
  lock.hidden = true;
  cell("name").append(toggle, label, mark, lock);
  const folderPart = document.createElement("span");
  folderPart.className = FOLDER_PART_CLASS;
  const bar = createBar();
  // The table hides the bar when it has no room. See `applyColumns`.
  bar.style.display = "var(--bar-display, block)";
  const sizeText = document.createElement("span");
  cell("size").append(bar, sizeText);
  return {
    element: row,
    name: cell("name"),
    others: [...cells.values()].filter((other) => other !== cell("name")),
    toggle,
    chevron,
    label,
    folderPart,
    mark,
    lock,
    bar,
    sizeText,
    compressed: cell("compressed"),
    ratio: cell("ratio"),
    entries: cell("entries"),
    method: cell("method"),
    modified: cell("modified"),
  };
}

const MODIFIED_CLASS = cellClass("muted");
const MODIFIED_DOS_CLASS = cellClass("muted", true);
const SIZE_TEXT_CLASS = cls(stylex.props(styles.sizeText));
const SIZE_STRONG_CLASS = cls(stylex.props(styles.sizeText, styles.sizeStrong));
const SETTLING_TEXT_CLASS = cls(stylex.props(styles.sizeText, shared.settling));

/** The values that all table rows have. */
interface RowBase {
  /** The tagged index of the row. */
  item: number;
  /** The label as it shows, maybe shortened in the middle. */
  label: string;
  title: string;
  /** True when the name has no mark and no right-to-left text, so the
   *  label needs no more work. See `isPlainName`. */
  plain: boolean;
  size: number;
  compressed: number;
  /** The level below the listed folder, from 0. */
  level: number;
  /** True for a row of the largest files below the listing. */
  block?: boolean;
  /** True when the row draws no bar and gives the slot to its name. */
  noBar?: boolean;
}

/** The values of one table row: a folder row with rolled-up values, or
 *  an entry. */
type RowValues =
  | (RowBase & {
      kind: "folder";
      folder: number;
      /** The entry count of the folder, for the Entries column. */
      count: string;
      countTitle: string;
      /** True when the sizes are rolled up and can still grow. */
      settling: boolean;
      /** The explicit row of the folder for the modified cell, or NONE. */
      row: number;
      hasChildren: boolean;
      expanded: boolean;
    })
  | (RowBase & {
      kind: "entry";
      /** The store row of the entry. */
      row: number;
      /** The health marks of the entry, with no RAW_NAME_KEPT bit. */
      marks: number;
      /** The characters of the label that are its folders. */
      folderPart?: number;
      encrypted: boolean;
    });

/** The label row above the largest files. */
interface HeadingValues {
  kind: "heading";
  label: string;
}

/** Reads one item of the listing. Returns undefined when it cannot show
 *  yet: its page, name chunk or folder record has not arrived. */
function readItem(
  reader: MirrorReader,
  frame: Frame,
  views: ViewSet,
  index: number,
): RowValues | undefined {
  const item = views.permutation[index];
  if (item === undefined) {
    return undefined;
  }
  const info = views.info[index] ?? 0;
  const level = info & TreeInfo.LEVEL_MASK;
  const hasChildren = (info & TreeInfo.HAS_CHILDREN) !== 0;
  const expanded = hasChildren && (info & TreeInfo.EXPANDED) !== 0;
  // Search results come from the whole archive: show the full path.
  const flat = views.folder === NONE;
  if (isFolder(item)) {
    const tail = folderId(item);
    if (tail >= frame.folders) {
      return undefined;
    }
    const chain = walkChain(reader, tail, {
      steps: (info >>> TreeInfo.CHAIN_SHIFT) & TreeInfo.CHAIN_MASK,
      stop: views.folder,
    });
    const rollup = MirrorReader.rollup(views, chain.head);
    if (rollup === undefined) {
      return undefined;
    }
    const explicit = reader.folderRow(tail);
    const label = `${chain.names.join("/")}/`;
    const plain = isPlainName(label);
    return {
      kind: "folder",
      item,
      label: plain ? label : nameText(label),
      title: plain ? label : nameTitle(label),
      plain,
      count: settling(integers.format(rollup[2]), frame.settling),
      countTitle: settling(formatCount(rollup[2]), frame.settling),
      size: rollup[0],
      compressed: rollup[1],
      settling: frame.settling,
      row: explicit !== NONE && explicit < frame.visible ? explicit : NONE,
      folder: tail,
      level,
      hasChildren,
      expanded,
    };
  }
  if (item >= frame.visible) {
    return undefined;
  }
  const name = reader.name(item);
  const plain = isPlainName(name);
  const shown = plain ? name : nameText(name);
  return {
    kind: "entry",
    item,
    label: flat ? shown : entryLabel(shown),
    title: plain ? name : nameTitle(name),
    plain,
    size: reader.value(item, "uncompressedSize"),
    compressed: reader.value(item, "compressedSize"),
    row: item,
    level,
    marks: reader.value(item, "marks") & ~Marks.RAW_NAME_KEPT,
    encrypted: (reader.value(item, "encryption") & ENCRYPTION_KIND) !== 0,
  };
}

/** Returns the number of path segments of a folder, or undefined when a
 *  folder record on its path has not arrived. A folder name that the depth
 *  cap folded has more than one segment. */
function folderDepth(reader: MirrorReader, frame: Frame, folder: number): number | undefined {
  if (folder === 0) {
    return 0;
  }
  if (folder >= frame.folders) {
    return undefined;
  }
  return walkChain(reader, folder, {}).names.reduce((sum, name) => sum + segments(name).length, 0);
}

/** Reads one row of the table: a row of the listing, the label row or a
 *  largest file. `depth` is the path depth of the listed folder. */
function readRow(
  reader: MirrorReader,
  frame: Frame,
  views: ViewSet,
  rows: TableRows,
  index: number,
  depth: number | undefined,
): RowValues | HeadingValues | undefined {
  if (index < rows.listing) {
    return readItem(reader, frame, views, index);
  }
  if (index === rows.label) {
    return { kind: "heading", label: LARGEST_LABEL };
  }
  const item = itemAt(views, rows, index);
  if (item === undefined || item >= frame.visible || depth === undefined) {
    return undefined;
  }
  const name = reader.name(item);
  const plain = isPlainName(name);
  return {
    kind: "entry",
    item,
    // The path below the listed folder, so the folder of the file shows.
    label: blockPath(plain ? name : nameText(name), depth),
    title: plain ? name : nameTitle(name),
    plain,
    size: reader.value(item, "uncompressedSize"),
    compressed: reader.value(item, "compressedSize"),
    row: item,
    level: 0,
    block: true,
    marks: reader.value(item, "marks") & ~Marks.RAW_NAME_KEPT,
    encrypted: (reader.value(item, "encryption") & ENCRYPTION_KIND) !== 0,
  };
}

/** Shows or hides the parts of the label row. */
function setHeading(row: TableRow, heading: boolean): void {
  const was = row.element.dataset.kind === "heading";
  if (was === heading) {
    return;
  }
  row.name.className = heading ? HEADING_NAME_CLASS : NAME_CLASS;
  row.label.className = heading ? HEADING_LABEL_CLASS : LABEL_CLASS;
  // The label row heads the rows below it and never selects. A pool
  // element can show a selected row before: reset its
  // selection state here, and `applySelection` writes it again for a
  // normal row.
  row.name.setAttribute("role", heading ? "rowheader" : "gridcell");
  if (!heading) {
    row.name.removeAttribute("aria-label");
  }
  row.element.className = ROW_CLASS;
  if (heading) {
    row.element.removeAttribute("aria-selected");
  } else {
    row.element.setAttribute("aria-selected", "false");
  }
  // Not `hidden`: the column picker owns it.
  for (const cell of row.others) {
    cell.style.display = heading ? "none" : "";
  }
}

/** Fills the cells of a row element. `toggles` is false for search
 *  results, which have no folder rows. `markDos` is true when the archive
 *  mixes DOS times and times with a time zone: then each DOS time gets
 *  the mark. */
function fillRow(
  reader: MirrorReader,
  row: TableRow,
  values: RowValues | HeadingValues | undefined,
  scale: number,
  slot: number,
  toggles: boolean,
  stopped: boolean,
  markDos: boolean,
  overlapError: boolean,
): void {
  const { element, name, toggle, label, bar, sizeText, entries } = row;
  element.removeAttribute("aria-disabled");
  element.removeAttribute("title");
  const { compressed, ratio, method, modified } = row;
  setHeading(row, values?.kind === "heading");
  if (values === undefined || values.kind === "heading") {
    element.dataset.kind = values?.kind ?? "pending";
    delete element.dataset.folder;
    delete element.dataset.marks;
    delete element.dataset.item;
    delete element.dataset.block;
    element.removeAttribute("aria-describedby");
    element.removeAttribute("aria-expanded");
    toggle.className = TOGGLE_NONE_CLASS;
    row.lock.hidden = true;
    name.style.marginInlineEnd = "";
    setMark(row.mark, 0, overlapError);
    row.folderPart.textContent = "";
    for (const cell of [label, entries, sizeText, compressed, ratio, method, modified]) {
      cell.textContent = "";
      cell.title = "";
    }
    if (values !== undefined) {
      label.textContent = values.label;
      name.style.paddingInlineStart = "";
      // The label shows in upper case, which goes into the name of the
      // row header. Give it the label as written. Write
      // it only when it changes: a write of the same value is also a
      // mutation, and the accessibility tree can update for it.
      if (name.getAttribute("aria-label") !== values.label) {
        name.setAttribute("aria-label", values.label);
      }
    }
    setBar(bar, 0);
    return;
  }
  element.dataset.kind = values.kind;
  element.dataset.item = String(values.item);
  if (values.block === true) {
    element.dataset.block = "true";
    // The keys skip the label row, so each row of the block names its
    // group to a screen reader.
    element.setAttribute("aria-describedby", LARGEST_LABEL_ID);
  } else {
    delete element.dataset.block;
    element.removeAttribute("aria-describedby");
  }
  element.dataset.level = String(values.level);
  // Health marks of the entry (the `marks` column), for the health panel
  // and for later styles.
  const marks = values.kind === "entry" ? reader.value(values.row, "marks") : 0;
  if (marks === 0) {
    delete element.dataset.marks;
  } else {
    element.dataset.marks = String(marks);
  }
  setMark(row.mark, values.kind === "entry" ? values.marks : 0, overlapError);
  const folder = values.kind === "folder" ? values : undefined;
  if (folder === undefined) {
    delete element.dataset.folder;
  } else {
    element.dataset.folder = String(folder.folder);
  }
  const hasChildren = folder?.hasChildren === true;
  const expanded = hasChildren && folder?.expanded === true;
  if (hasChildren) {
    element.setAttribute("aria-expanded", String(expanded));
  } else {
    element.removeAttribute("aria-expanded");
  }
  name.style.paddingInlineStart = values.level === 0 ? "" : `${values.level * INDENT}px`;
  if (stopped && folder !== undefined) {
    element.setAttribute("aria-disabled", "true");
    element.setAttribute("aria-describedby", STOPPED_ID);
  }
  toggle.className = !toggles
    ? TOGGLE_NONE_CLASS
    : !hasChildren || stopped
      ? TOGGLE_EMPTY_CLASS
      : TOGGLE_CLASS;
  turnChevron(row.chevron, expanded);
  // A long name takes long to lay out. Write it only when it changed.
  const folderChars = values.kind === "entry" ? (values.folderPart ?? 0) : 0;
  if (label.textContent !== values.label || row.folderPart.textContent?.length !== folderChars) {
    if (folderChars === 0) {
      row.folderPart.textContent = "";
      label.textContent = values.label;
    } else {
      row.folderPart.textContent = values.label.slice(0, folderChars);
      label.replaceChildren(row.folderPart, values.label.slice(folderChars));
    }
  }
  if (label.title !== values.title) {
    label.title = values.title;
  }
  entries.textContent = folder?.count ?? "";
  entries.title = folder?.countTitle ?? "";
  const settles = folder?.settling === true;
  sizeText.textContent = settlingSize(values.size, settles);
  sizeText.title = exactBytes(values.size);
  const share = scale > 0 ? values.size / scale : 0;
  sizeText.className = settles
    ? SETTLING_TEXT_CLASS
    : share >= STRONG_SHARE
      ? SIZE_STRONG_CLASS
      : SIZE_TEXT_CLASS;
  setBar(bar, values.noBar === true ? 0 : barWidth(values.size, scale));
  // A row with no bar gives the slot and the gap to its name.
  name.style.marginInlineEnd = values.noBar === true && slot > 0 ? `-${slot + COLUMN_GAP}px` : "";
  compressed.textContent = settlingSize(values.compressed, settles);
  compressed.title = exactBytes(values.compressed);
  ratio.textContent = formatRatio(values.compressed, values.size);
  if (values.kind === "folder" || values.row === NONE) {
    // A folder has no method: a dash on each folder row is only noise.
    method.textContent = "";
    method.title = "";
    row.lock.hidden = true;
  } else {
    const methodText = formatMethod(
      reader.value(values.row, "method"),
      reader.value(values.row, "encryption"),
      reader.value(values.row, "aesMethod"),
    );
    method.textContent = methodText.text;
    method.title = methodText.title;
    row.lock.hidden = (reader.value(values.row, "encryption") & ENCRYPTION_KIND) === 0;
  }
  if (values.row === NONE) {
    modified.textContent = "";
    modified.title = "";
    modified.className = MODIFIED_CLASS;
  } else {
    const time = formatModified(
      reader.value(values.row, "modified"),
      reader.value(values.row, "timeKind"),
    );
    modified.textContent = time.text;
    modified.title = time.title;
    modified.className = time.noTimeZone && markDos ? MODIFIED_DOS_CLASS : MODIFIED_CLASS;
  }
}

/** Returns the full path of a folder: its names from below the root. */
function folderPath(reader: MirrorReader, folder: number): string {
  return `${walkChain(reader, folder, {}).names.join("/")}/`;
}

/** Returns the row as tab-separated values: path, size and compressed
 *  size in bytes, ratio, method and modified time. Tabs and line breaks
 *  in a name become spaces. The numbers have one fixed form in all
 *  locales: no group marks, and a dot before the decimal. */
function rowValues(reader: MirrorReader, views: ViewSet, item: number, path: string): string {
  const clean = (text: string) => text.replace(/[\t\r\n]/g, " ");
  let size = 0;
  let compressed = 0;
  let methodText = "";
  let row = NONE;
  if (isFolder(item)) {
    const folder = folderId(item);
    const rollup = MirrorReader.rollup(views, folder);
    // The rollup of a chain row is the rollup of its first folder, which
    // equals the rollup of its last folder: the chain has no other rows.
    size = rollup?.[0] ?? 0;
    compressed = rollup?.[1] ?? 0;
    row = reader.folderRow(folder);
  } else {
    row = item;
    size = reader.value(row, "uncompressedSize");
    compressed = reader.value(row, "compressedSize");
    methodText = formatMethod(
      reader.value(row, "method"),
      reader.value(row, "encryption"),
      reader.value(row, "aesMethod"),
    ).text;
  }
  const modified =
    row === NONE
      ? ""
      : formatModified(reader.value(row, "modified"), reader.value(row, "timeKind")).text;
  // A missing value is an empty cell, not a dash.
  const cell = (text: string) => (text === "—" ? "" : text);
  return [
    spreadsheetText(clean(path)),
    String(size),
    String(compressed),
    cell(copiedRatio(compressed, size)),
    methodText,
    cell(modified),
  ].join("\t");
}

/** The actions that the shell starts on the table. */
export interface TableApi {
  /** Selects a row when its folder lists, and moves the focus to the table.
   *  `move` gets the folder that lists the row, or NONE, and goes there. The
   *  reply of the worker comes later: when `stays` then gives false, this
   *  does nothing. */
  showRow(row: number, move: (folder: number) => void, stays?: () => boolean): void;
}

/**
 * A virtualized table of the listed folder: its child folders (compact
 * chains on one row) with rolled-up values, then its entries. Folder rows
 * open in place. It renders from shared memory on each frame. Focus stays
 * on the grid, and `aria-activedescendant` names the selected row.
 */
export function TableView(props: TableViewProps) {
  // A new sort changes the key after the frame that drew it. After the parse no
  // other frame comes, so without this the next click would find a new listing
  // and lose its selection.
  createEffect(
    () => props.listingKey,
    () => {
      props.loop.schedule();
    },
  );
  let viewport!: HTMLDivElement;
  let spacer!: HTMLDivElement;
  let layer!: HTMLDivElement;
  let empty!: HTMLDivElement;
  let archiveEmpty!: HTMLDivElement;
  let folderEmpty!: HTMLDivElement;
  let nameHeader!: HTMLSpanElement;
  let header!: HTMLDivElement;
  let menu: RowMenuApi | undefined;
  /** True when all modified times are DOS times: the column header notes
   *  it once, and the cells have no mark. The frame commit sets it. */
  const [dosOnly, setDosOnly] = createSignal(false);
  /** True while the pointer is on the Modified sort button or its note
   *  card. */
  const [notePointed, setNotePointed] = createSignal(false);
  /** True while the button has the focus. The pointer and the focus are
   *  two states, so the card stays while the button keeps the focus and
   *  the pointer goes away. Escape sets both to false. */
  const [noteFocused, setNoteFocused] = createSignal(false);
  let modifiedButton: HTMLButtonElement | undefined;
  let noteCard!: HTMLDivElement;
  /** Then the card shows the DOS note as visible text. */
  const noteOpen = createMemo(() => (notePointed() || noteFocused()) && dosOnly());
  createEffect(noteOpen, (open) => {
    const shown = noteCard?.matches(":popover-open") === true;
    if (!open || modifiedButton === undefined || noteCard === undefined) {
      if (shown) noteCard.hidePopover();
      return;
    }
    if (!shown) noteCard.showPopover();
    // With anchor positioning, the card follows the button when the
    // table scrolls or the window changes size.
    if (ANCHORS) return;
    // Below the button, with no gap, so the pointer can go onto the card.
    const at = modifiedButton.getBoundingClientRect();
    const width = noteCard.offsetWidth;
    noteCard.style.left = `${Math.max(8, Math.min(at.left, innerWidth - width - 8))}px`;
    noteCard.style.top = `${at.bottom}px`;
  });
  /** True when the pointer goes to the button or the card. */
  const onNote = (to: EventTarget | null) =>
    to instanceof Node && (noteCard.contains(to) || modifiedButton?.contains(to) === true);

  const ariaSort = (column: SortColumn | undefined) => {
    const sort = props.sort;
    if (sort.column !== column) {
      return undefined;
    }
    return sort.descending ? "descending" : "ascending";
  };

  /** The columns with no value in the view: Method for a listing with no
   *  file, and Modified also when no folder has a time. They collapse, so
   *  a list of folders has no empty columns. */
  const [collapsed, setCollapsed] = createSignal<HiddenColumns>(NO_COLUMNS, {
    equals: sameColumns,
  });
  /** The columns that do not show: the choice of the shell, and the empty
   *  columns of the view. */
  const off = createMemo<HiddenColumns>(() => new Set([...props.hidden, ...collapsed()]), {
    equals: sameColumns,
  });
  /** Hides the cells of the hidden columns below `root`. */
  const applyHidden = (root: ParentNode) => {
    const hidden = untrack(off);
    for (const cell of root.querySelectorAll<HTMLElement>("[data-cell]")) {
      cell.hidden = hidden.has(cell.dataset.cell as ColumnKey);
    }
  };
  // The shell gives a memo that changes only when the set of hidden
  // columns changes, so a resize step does not run this effect.
  createEffect(off, (next) => {
    applyTemplate(next);
    applyHidden(viewport);
    // A cell can read the hidden state, and the name room changes.
    invalidateRows();
  });
  // The health report comes after the rows, so the marks that show change.
  createEffect(
    () => props.overlapError,
    () => {
      invalidateRows();
      props.loop.schedule();
    },
  );

  /** The bar slot now: 0 when the table has no bars. */
  let barSlot = BAR_SLOT;
  /** Sets the grid of the table for these hidden columns and its width. */
  const applyTemplate = (hidden: HiddenColumns) => {
    const noBar = hidden.has(BAR);
    const slot = window.innerWidth < NARROW_TABLE ? BAR_SLOT_NARROW : BAR_SLOT;
    barSlot = noBar ? 0 : slot;
    viewport.style.setProperty("--table-columns", gridTemplate(hidden, slot));
    viewport.style.setProperty(
      "--size-cells",
      noBar ? `${SIZE_TEXT}px` : `${slot}px ${SIZE_TEXT}px`,
    );
    viewport.style.setProperty("--bar-display", noBar ? "none" : "block");
  };

  // Set in `onSettled`.
  let invalidateRows: () => void = () => {};
  let showInTree: (target: MenuTarget) => void = () => {};
  let focusGrid: () => void = () => {};

  onSettled(() => {
    const reader = props.reader;
    /** True after the table went. */
    let disposed = false;
    const create = () => {
      const row = createRow();
      applyHidden(row.element);
      return row;
    };
    const pool = new RowPool<TableRow>(viewport, spacer, layer, create, HEADER);
    invalidateRows = () => {
      pool.invalidate();
      props.loop.schedule();
    };
    pool.resize();
    // -1 so that the first frame sets `aria-rowcount`, also for no rows.
    let rowCount = -1;
    let wasEmpty = false;
    let uncapped = false;
    let listed = -1;
    let key = "";
    let listingKey = props.listingKey;
    /** The sort of the last frame. */
    let listedSort = -1;
    /** A row to bring into view after the next render, or -1. */
    let revealRow = -1;
    /** The time kinds of the listed rows. */
    const times = new TimeKinds();

    /** The selected item, its last known index, and true when it is a
     *  row of the largest files (a file can also be a row of the
     *  listing). */
    let selected: { item: number; index: number; block: boolean } | undefined;
    /** The file that waits to show in the largest files. */
    let revealFile = props.revealFile;
    /** The folder of the revealed file, while its row of the largest files can
     *  still go. */
    let revealFolder: string | undefined;
    /** Selects the row of a listed folder, with no move of the focus. */
    const selectFolder = (views: ViewSet, name: string | undefined, rows: number) => {
      for (let index = 0; index < views.permutation.length; index++) {
        const item = views.permutation[index]!;
        if (isFolder(item) && reader.folderName(folderId(item)) === name) {
          selected = { item, index, block: false };
          pool.reveal(index, rows);
          return;
        }
      }
      selected = undefined;
    };
    /** True until the first frame with rows takes the focus. */
    let takeFocus = props.revealFocus === true;
    /** True from Enter in the search field to the next key of the grid. */
    let enterHeld = false;
    /** True while the table moves the focus to itself with no selected row. */
    let focusWithNoRow = false;

    /** True after a frame drew the complete parse with all its rows. It
     *  stays true. */
    let parsed = false;
    const size = (row: number) => reader.value(row, "uncompressedSize");
    /** The rows of the table for a view set and the viewport now.
     *  `complete` is true when the frame shows the complete parse. */
    const rowsOf = (views: ViewSet, complete = parsed): TableRows =>
      tableRows(views, {
        visibleRows: pool.visibleRows(),
        rowHeight: ROW_HEIGHT,
        parsed: complete,
        size,
      });
    /** "Show in tree": the folder to wait for, and the entry row or the
     *  folder whose row to select there. */
    let pending: { folder: number; item: number; target: number } | undefined;

    // Names shorten in the middle to the width of the name column. The
    // widths of the characters are measured one time for each font, and
    // the column width is read only when it changes.
    const widths = new TextWidths();
    let nameWidth = 0;
    let layout = 0;
    const measureLayout = () => {
      applyTemplate(untrack(off));
      const label = layer.querySelector('[data-part="label"]');
      if (label !== null && widths.setFont(fontOf(label))) {
        layout++;
      }
      const width = nameHeader.getBoundingClientRect().width;
      if (width !== nameWidth) {
        nameWidth = width;
        layout++;
      }
    };
    measureLayout();

    /** Returns the columns with no value in a short listing. A long
     *  listing is not scanned, and keeps its columns. */
    const columnsWithNoValue = (
      views: ViewSet,
      table: TableRows | undefined,
    ): HiddenColumns | undefined => {
      const rows = views.permutation;
      if (rows.length === 0) return NO_COLUMNS;
      const next = new Set<ColumnKey>();
      // Folder items come first in each order, so one read tells.
      if (!isFolder(rows[0]!)) next.add("entries");
      if (rows.length > COLLAPSE_SCAN || views.folder === NONE) return next;
      let times = false;
      let files = (table?.files.length ?? 0) > 0;
      const hasTime = (row: number) =>
        row < reader.visibleRows() && reader.value(row, "timeKind") !== TimeKind.NONE;
      for (let index = 0; index < rows.length && !times; index++) {
        const item = rows[index]!;
        if (isFolder(item)) {
          const explicit = reader.folderRow(folderId(item));
          times = explicit !== NONE && hasTime(explicit);
        } else {
          files = true;
          times = hasTime(item);
        }
      }
      if (!times && table !== undefined) {
        for (let at = 0; at < table.files.length && !times; at++) {
          times = hasTime(table.files[at]!);
        }
      }
      for (let index = 0; index < rows.length && !files; index++) {
        files = !isFolder(rows[index]!);
      }
      if (!files) next.add("method");
      if (!times) next.add("modified");
      return next;
    };

    /** Shortens a label to the room in its name cell. */
    const fit = (values: RowValues, toggles: boolean) => {
      // 2px for kerning, which the character widths do not count.
      let room = nameWidth - values.level * INDENT - 2;
      if (values.noBar === true && barSlot > 0) {
        room += barSlot + COLUMN_GAP;
      }
      if (toggles) {
        room -= TOGGLE + NAME_GAP;
      }
      if (values.kind === "entry" && values.marks !== 0) {
        room -= MARK_SIZE + NAME_GAP;
      }
      if (values.kind === "entry" && nameWidth > 0) {
        // The base name stays whole: the folders of a path go first.
        if (values.encrypted) {
          room -= MARK_SIZE + NAME_GAP;
        }
        const cut = pathTruncate(values.label, Math.max(0, room), widths.measure);
        if (values.plain) {
          values.label = cut.text;
          values.folderPart = cut.folder;
        } else {
          const folder = directed(cut.text.slice(0, cut.folder));
          values.label = folder + directed(cut.text.slice(cut.folder));
          values.folderPart = folder.length;
        }
        return;
      }
      // With no Entries column, the title keeps the count.
      if (values.kind === "folder" && untrack(off).has("entries")) {
        values.title = `${values.title}\n${values.countTitle}`;
      }
      if (nameWidth > 0) {
        values.label = chainTruncate(values.label, Math.max(0, room), widths.measure);
      }
      if (!values.plain) {
        values.label = directed(values.label);
      }
    };

    /** Returns the index of the selected item now, or -1. */
    const selectedIndex = (views: ViewSet): number => {
      if (selected === undefined) {
        return -1;
      }
      if (selected.block) {
        const index = blockIndex(rowsOf(views), selected.item, selected.index);
        if (index >= 0) {
          selected.index = index;
        }
        return index;
      }
      if (views.permutation[selected.index] === selected.item) {
        return selected.index;
      }
      const index = views.permutation.indexOf(selected.item);
      if (index >= 0) {
        selected.index = index;
      }
      return index;
    };

    /** Marks the shown row of the selected item. */
    const applySelection = () => {
      if (selected !== undefined) delete viewport.dataset.firstRing;
      const item = selected === undefined ? "" : String(selected.item);
      const block = selected?.block === true;
      let active: HTMLElement | undefined;
      // Hidden rows too, so that no hidden row keeps an old selection.
      for (const element of layer.children as HTMLCollectionOf<HTMLElement>) {
        if (element.dataset.kind === "heading") {
          // The label row never has the selection state.
          element.removeAttribute("aria-selected");
          if (element.className !== ROW_CLASS) {
            element.className = ROW_CLASS;
          }
          continue;
        }
        const isSelected =
          item !== "" &&
          !element.hidden &&
          element.dataset.item === item &&
          (element.dataset.block === "true") === block;
        if (isSelected) {
          active = element;
        }
        // The attribute and the class follow the state on each call, so no
        // path through the pool can leave one of them old.
        if (element.getAttribute("aria-selected") !== String(isSelected)) {
          element.setAttribute("aria-selected", String(isSelected));
        }
        const className = isSelected ? SELECTED_CLASS : ROW_CLASS;
        if (element.className !== className) {
          element.className = className;
        }
      }
      if (active === undefined) {
        viewport.removeAttribute("aria-activedescendant");
      } else {
        viewport.setAttribute("aria-activedescendant", active.id);
      }
    };

    /** Selects the row at `index` and scrolls it into view. A key moves
     *  in the direction of `step` past the label row of the largest
     *  files. */
    const select = (views: ViewSet, index: number, step = 1) => {
      const rows = rowsOf(views);
      if (rows.count === 0) {
        return;
      }
      const row = moveTarget(rows, index, step);
      const item = itemAt(views, rows, row);
      if (item === undefined) {
        return;
      }
      selected = { item, index: row, block: inBlock(rows, row) };
      pool.reveal(row, rows.count);
      const entry = !isFolder(item) && item < reader.visibleRows();
      props.onSelect(entry ? reader.name(item) : undefined, entry ? item : undefined);
      props.loop.schedule();
    };

    /** Selects the item that a shown row element shows. Newer views can
     *  have another item at its index, so the item decides. */
    const selectShown = (views: ViewSet, element: HTMLElement): number => {
      const item = Number(element.dataset.item);
      const hint = Number(element.dataset.row);
      const block = element.dataset.block === "true";
      const index = block
        ? blockIndex(rowsOf(views), item, hint)
        : views.permutation[hint] === item
          ? hint
          : views.permutation.indexOf(item);
      if (index >= 0) {
        select(views, index);
      } else {
        selected = { item, index: hint, block };
        props.loop.schedule();
      }
      return item;
    };

    // Reads the rows that change. The DOM changes only in `commit`, after
    // the frame checked that the view set did not change.
    const render = (frame: Frame): Prepared => {
      const views = frame.views;
      // A memory refusal after the parse changes the state, but the parse
      // stays complete, so the block stays (a refused request
      // keeps the shown state).
      const parseDone =
        parsed || (frame.state === State.COMPLETE && frame.visible >= frame.committed);
      const table = views === undefined ? undefined : rowsOf(views, parseDone);
      const rows = table?.count ?? 0;
      const nextListingKey = props.listingKey;
      const newListing =
        (views !== undefined && views.folder !== listed) || nextListingKey !== listingKey;
      if (newListing) {
        // A new folder, search or sort starts at the top. The scroll
        // position is not content, so it can change before the check.
        pool.scrollToRow(0, rows);
        listingKey = nextListingKey;
      } else if (views !== undefined && views.sort !== listedSort && selected !== undefined) {
        // The default sort landed: the scroll position stays, and a selected
        // row that was in view stays in view.
        const first = pool.firstRow(rows);
        const shown = selected.index >= first && selected.index < first + pool.visibleRows();
        const index = selectedIndex(views);
        if (shown) revealRow = index;
      }
      if (views !== undefined) listedSort = views.sort;
      // The views, the rows, the folders or the name column changed: fill
      // all rows again.
      const stopped = props.foldersStopped;
      times.scan((row) => reader.value(row, "timeKind"), frame.visible);
      const markDos = times.mixed;
      const dosNote = times.dosOnly;
      const next = `${views?.generation}:${frame.visible}:${frame.folders}:${frame.state}:${layout}:${stopped}:${markDos}:${table?.label}`;
      const values = new Map<number, RowValues | HeadingValues | undefined>();
      let complete = views !== undefined;
      const toggles = views !== undefined && views.folder !== NONE;
      // A bar is the share of the listed folder, as in the tree, so 30
      // equal files show 30 short bars. Search results have no folder: there
      // a bar is the share of the largest result.
      const folderTotal =
        views === undefined || views.folder === NONE
          ? undefined
          : views.rollups[(views.folder * ROLLUP_RECORD_BYTES) / 8];
      const scale =
        folderTotal !== undefined && folderTotal > 0 ? folderTotal : (views?.largest ?? 0);
      const plan = pool.plan(rows, next !== key);
      const listedDepth =
        views !== undefined && table !== undefined && table.label >= 0
          ? folderDepth(reader, frame, views.folder)
          : 0;
      // The block leaves out the folders that all its rows share.
      const depth =
        listedDepth !== undefined && table !== undefined && table.label >= 0
          ? listedDepth +
            sharedSegments(
              Array.from(table.files, (row) => (row < frame.visible ? reader.name(row) : "")),
              listedDepth,
            )
          : listedDepth;
      for (const row of plan.rows) {
        const value =
          views === undefined || table === undefined
            ? undefined
            : readRow(reader, frame, views, table, row, depth);
        if (value !== undefined && value.kind !== "heading") {
          value.noBar = !hasBar(value.size, scale, barSlot);
          fit(value, toggles);
        }
        complete &&= value !== undefined;
        values.set(row, value);
      }
      const noMatch = views !== undefined && views.folder === NONE && rows === 0;
      // An archive or a folder with no entries: the table says so, not
      // only its header.
      const listedEmpty = parseDone && views !== undefined && views.folder !== NONE && rows === 0;
      const noEntries = listedEmpty && frame.committed === 0;
      const emptyFolder = listedEmpty && frame.committed > 0;
      // Also after a stop: then no more rows come.
      const parseEnded = parseDone || frame.state === State.FAILED;
      const emptyColumns =
        parseEnded && views !== undefined ? columnsWithNoValue(views, table) : undefined;
      // The location goes to another place, or the worker refused the folder:
      // the row does not select itself at a later visit.
      if (pending !== undefined && pending.folder !== props.locationFolder) {
        pending = undefined;
      }
      // "Show in tree": the folder is listed, so select the row.
      let found = -1;
      const done = views !== undefined && pending !== undefined && views.folder === pending.folder;
      if (done && pending !== undefined && views !== undefined) {
        found = findPending(views, pending.item, pending.target);
      }
      return {
        complete,
        commit: () => {
          parsed = parseDone;
          setDosOnly(dosNote);
          empty.hidden = !noMatch;
          if (noMatch) {
            empty.textContent = frame.settling ? tableText.noMatchYet : tableText.noMatch;
          }
          archiveEmpty.hidden = !noEntries;
          folderEmpty.hidden = !emptyFolder;
          header.hidden = listedEmpty;
          // Search results have long paths, so their names have no cap.
          const flat = views !== undefined && views.folder === NONE;
          if (flat !== uncapped) {
            uncapped = flat;
            viewport.style.setProperty("--name-cap", flat ? "100%" : `${NAME_CAP}px`);
            measureLayout();
            props.loop.schedule();
          }
          if (emptyColumns !== undefined) setCollapsed(emptyColumns);
          if (listedEmpty !== wasEmpty) {
            wasEmpty = listedEmpty;
            props.onEmpty?.(listedEmpty);
          }
          if (rows !== rowCount) {
            viewport.setAttribute("aria-rowcount", String(rows + 1));
            rowCount = rows;
          }
          if (views !== undefined && views.folder !== listed) {
            listed = views.folder;
            viewport.dataset.listingFolder = String(listed);
          }
          if (newListing && pending === undefined) {
            selected = undefined;
            // The preview keeps its file, but the Preview button no longer
            // opens a file of the old listing.
            props.onSelect(undefined, undefined);
          }
          // A new listing while the grid has the keyboard focus, for example
          // after Enter or Backspace: the first row is the cursor. After the
          // pointer no row is selected, so the first row of a listing does not
          // have the strongest fill of the screen for no reason.
          if (
            newListing &&
            pending === undefined &&
            views !== undefined &&
            views.permutation.length > 0 &&
            viewport.matches(":focus-visible")
          ) {
            selected = { item: views.permutation[0]!, index: 0, block: false };
          }
          // The door that had the focus is gone, so the focus is on the body.
          // The visitor did not move it, so the ring shows where it is, also
          // after a pointer click.
          if (takeFocus && rows > 0) {
            takeFocus = false;
            if (document.activeElement === document.body) {
              focusWithNoRow = true;
              viewport.dataset.firstRing = "";
              viewport.focus({ preventScroll: true, focusVisible: true });
              focusWithNoRow = false;
            }
          }
          if (revealFile !== undefined && table !== undefined && table.label >= 0) {
            for (let index = 0; index < table.files.length; index++) {
              const file = table.files[index]!;
              if (file < frame.visible && reader.name(file) === revealFile) {
                selected = { item: file, index: table.label + 1 + index, block: true };
                props.onSelect(revealFile, file);
                revealFolder = revealFile.split("/").at(-2);
                break;
              }
            }
            revealFile = undefined;
          } else if (
            revealFile !== undefined &&
            views !== undefined &&
            parseDone &&
            views.largestFiles.length > 0
          ) {
            // The window has no room for the largest files: the folder of the
            // file is the answer.
            selectFolder(views, revealFile.split("/").at(-2), rows);
            revealFile = undefined;
          } else if (revealFolder !== undefined) {
            // The health strip can come after the largest files and take their
            // room. Then the folder of the file takes the selection.
            // The hidden tool has no height, so it has no block either, and that
            // says nothing about the room.
            if (selected?.block !== true) {
              revealFolder = undefined;
            } else if (
              viewport.clientHeight > 0 &&
              views !== undefined &&
              table !== undefined &&
              table.label < 0
            ) {
              selectFolder(views, revealFolder, rows);
              revealFolder = undefined;
            }
          }
          if (next !== key) {
            key = next;
            pool.invalidate();
          }
          // The space above the largest-files block.
          pool.setGap(table?.label ?? -1, BLOCK_GAP);
          const filled = pool.render(rows, plan.start, (pooled, row) => {
            if (!values.has(row)) {
              return false;
            }
            fillRow(
              reader,
              pooled,
              values.get(row),
              scale,
              barSlot,
              toggles,
              stopped,
              markDos,
              props.overlapError,
            );
            // The header is row 1.
            pooled.element.setAttribute("aria-rowindex", String(row + 2));
            return true;
          });
          applySelection();
          // After the render: the last rows can land with the sort, and the
          // spacer has their height only now.
          if (revealRow >= 0) {
            pool.reveal(revealRow, rows);
            revealRow = -1;
            props.loop.schedule();
          }
          // A row can come after its name, with a later listing of the parse.
          if (done && (found >= 0 || parseEnded || frame.state === State.CANCELLED)) {
            pending = undefined;
            if (found >= 0 && views !== undefined) {
              select(views, found);
            }
          }
          if (views !== undefined && props.firstRowReady(views)) {
            props.onFirstRowDone();
            if (views.permutation.length > 0) {
              select(views, 0);
              enterHeld = true;
              viewport.focus({ preventScroll: true });
            }
          }
          if (!filled) {
            props.loop.schedule();
          }
        },
      };
    };

    /**
     * Returns the index of the "show in tree" row: the entry row `item`,
     * or, for the folder entry of folder `target`, the folder row that
     * contains `target` (a compact chain row gives its last folder).
     */
    const findPending = (views: ViewSet, item: number, target: number): number => {
      if (target === NONE) {
        return views.permutation.indexOf(item);
      }
      // Folder items come first.
      for (let index = 0; index < views.permutation.length; index++) {
        const value = views.permutation[index]!;
        if (!isFolder(value)) {
          break;
        }
        for (let folder = folderId(value), step = 0; step < 1 << 16; step++) {
          if (folder === target) {
            return index;
          }
          if (folder === views.folder || folder === NONE || folder === 0) {
            break;
          }
          folder = reader.folderParent(folder);
        }
      }
      return -1;
    };

    /** Returns the row element under an event target. */
    const rowOf = (target: EventTarget | null) =>
      (target as Element | null)?.closest<HTMLElement>("[data-row]") ?? null;

    /** A row that is not filled yet and the label row do not select. */
    const selectable = (element: HTMLElement) =>
      element.dataset.kind !== "pending" && element.dataset.kind !== "heading";

    /** Returns the menu target for the tagged index `item`. */
    const menuTarget = (views: ViewSet, item: number, block: boolean): MenuTarget | undefined => {
      const folder = isFolder(item);
      if (folder ? folderId(item) >= reader.visibleFolders() : item >= reader.visibleRows()) {
        return undefined;
      }
      const path = folder ? folderPath(reader, folderId(item)) : reader.name(item);
      const tsv = rowValues(reader, views, item, path);
      // A largest file can be in a folder below the listing, so "Show in
      // tree" lists its folder, as for a search result.
      const search = views.folder === NONE || block;
      return folder
        ? { kind: "folder", path, tsv, search }
        : { kind: "entry", row: item, path, tsv, search };
    };

    /** Opens the menu for the tagged index `item`: the row that shows
     *  on the screen, not the row at its index in newer views. */
    const openMenu = (item: number, block: boolean, at?: Rect) => {
      // The rollups come from the views: read them under the seqlock.
      let target: MenuTarget | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        const views = reader.views();
        target = views === undefined ? undefined : menuTarget(views, item, block);
        if (views === undefined || reader.stable(views)) {
          break;
        }
        target = undefined;
      }
      if (target === undefined || menu === undefined) {
        return;
      }
      if (at !== undefined) {
        menu.open(target, at, true);
        return;
      }
      // From the keyboard: below the name of the row. A row that the key
      // scrolled into view shows after the next frame.
      const shown = String(item);
      const openAtRow = () => {
        const element = pool
          .shownRows()
          .find(
            (row) =>
              row.element.dataset.item === shown &&
              (row.element.dataset.block === "true") === block,
          )?.element;
        if (element === undefined) {
          return false;
        }
        const label = element.querySelector('[data-part="label"]') ?? element;
        const rect = label.getBoundingClientRect();
        menu?.open(
          target,
          { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          false,
        );
        return true;
      };
      if (!openAtRow()) {
        requestAnimationFrame(() => {
          if (!openAtRow()) {
            const rect = viewport.getBoundingClientRect();
            menu?.open(target, { x: rect.left, y: rect.top, width: rect.width, height: 0 }, false);
          }
        });
      }
    };

    const showRow: TableApi["showRow"] = (row, move, stays = () => true) => {
      // The worker knows the folder of each row, so no names are decoded.
      // The table can go before the answer comes, for example when another
      // archive opens. Then the answer does nothing. A closed worker
      // rejects, and that needs no message.
      props.entryFolder(row).then((value) => {
        if (disposed || !stays()) {
          return;
        }
        const explicit = value !== NONE && isFolder(value);
        // The explicit row of a folder lists as its folder row, in the
        // parent folder.
        const folder = explicit ? reader.folderParent(folderId(value)) : value;
        if (folder !== NONE) {
          pending = { folder, item: row, target: explicit ? folderId(value) : NONE };
          // The listed folder gets no new views, so ask for the frame here.
          props.loop.schedule();
        }
        move(folder);
        // The row gets the selection from `pending`, not from this focus.
        focusWithNoRow = true;
        viewport.focus({ preventScroll: true });
        focusWithNoRow = false;
      }, ignore);
    };
    props.api({ showRow });
    showInTree = (target) => {
      if (target.kind !== "entry") {
        return;
      }
      showRow(target.row, (folder) => {
        if (folder !== NONE) props.actions.showInTree(folder, target.path, target.row);
      });
    };
    focusGrid = () => viewport.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      // Tab is not handled: in the order of the document, the grid comes
      // first, then the sort buttons of its header, then the next control.
      // Keys on the sort buttons of the header are theirs.
      if (event.target !== viewport || event.ctrlKey || event.metaKey) {
        return;
      }
      // Enter in the search field moved the focus here while the key can
      // still be down. Its repeat must not open the row.
      if (enterHeld && event.key === "Enter" && event.repeat) {
        event.preventDefault();
        return;
      }
      enterHeld = false;
      const views = reader.views();
      if (views === undefined) {
        return;
      }
      // The first row has the ring, so a key that acts on a row acts on it.
      if (
        viewport.dataset.firstRing !== undefined &&
        selected === undefined &&
        !event.altKey &&
        (event.key === "Enter" || event.key === " " || event.key === "ArrowRight")
      ) {
        select(views, 0);
      }
      const rows = rowsOf(views);
      const length = rows.count;
      const current = selectedIndex(views);
      const item = current < 0 ? undefined : itemAt(views, rows, current);
      const block = current >= 0 && inBlock(rows, current);
      // The rows of the largest files have no information word.
      const info = current < 0 || current >= rows.listing ? 0 : (views.info[current] ?? 0);
      const folder = item !== undefined && isFolder(item) ? folderId(item) : undefined;
      const hasChildren = (info & TreeInfo.HAS_CHILDREN) !== 0;
      const expanded = hasChildren && (info & TreeInfo.EXPANDED) !== 0;
      const page = Math.max(1, Math.floor(pool.visibleRows()) - 1);
      if (event.altKey && event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }
      switch (event.key) {
        case "ArrowDown":
          select(views, current < 0 ? 0 : current + 1);
          break;
        case "ArrowUp":
          select(views, current < 0 ? 0 : current - 1, -1);
          break;
        case "PageDown":
          select(views, current < 0 ? 0 : current + page);
          break;
        case "PageUp":
          select(views, current - page, -1);
          break;
        case "Home":
          select(views, 0);
          break;
        case "End":
          select(views, length - 1, -1);
          break;
        case "ArrowRight":
          if (props.foldersStopped) break;
          if (folder !== undefined && hasChildren && !expanded) {
            props.onExpand(folder, true, false);
          } else if (folder !== undefined && expanded) {
            select(views, current + 1);
          }
          break;
        case "ArrowLeft": {
          if (folder !== undefined && expanded && !props.foldersStopped) {
            props.onExpand(folder, false, false);
            break;
          }
          // Move to the parent row: the nearest row above at a lower level.
          const level = info & TreeInfo.LEVEL_MASK;
          for (let index = current - 1; level > 0 && index >= 0; index--) {
            if (((views.info[index] ?? 0) & TreeInfo.LEVEL_MASK) < level) {
              select(views, index);
              break;
            }
          }
          break;
        }
        case "*":
          if (folder !== undefined && !props.foldersStopped) {
            props.onExpand(folder, true, true);
          }
          break;
        case "Enter":
          if (folder !== undefined) {
            if (!props.foldersStopped) props.actions.navigateToFolder(folder);
          } else if (item !== undefined && item < reader.visibleRows()) {
            props.onOpenEntry(reader.name(item), item);
          }
          break;
        case " ":
          // A held key opens and closes once: each toggle writes a history
          // entry, and a browser limits how fast a page can write them.
          if (event.repeat) break;
          if (item === undefined || folder !== undefined || item >= reader.visibleRows()) {
            props.onTogglePreview(undefined, undefined);
          } else {
            props.onTogglePreview(reader.name(item), item);
          }
          break;
        case "Escape":
          props.onClosePreview();
          break;
        case "Backspace":
          if (!props.foldersStopped) props.actions.goUp();
          break;
        case "ContextMenu":
          if (item !== undefined) {
            openMenu(item, block);
          }
          break;
        case "F10":
          if (!event.shiftKey || item === undefined) {
            return;
          }
          openMenu(item, block);
          break;
        default:
          return;
      }
      event.preventDefault();
    };

    /** The items of the last two clicks. A row element is recycled, so
     *  after the first click of a double-click on a folder, the element
     *  can show a file of the new listing. */
    let clicked: (string | undefined)[] = [undefined, undefined];

    const onClick = (event: MouseEvent) => {
      const element = rowOf(event.target);
      const views = reader.views();
      if (element === null || views === undefined || !selectable(element)) {
        return;
      }
      viewport.focus({ preventScroll: true });
      clicked = [clicked[1], element.dataset.item];
      selectShown(views, element);
      const folder = element.dataset.folder;
      if (folder !== undefined) {
        if (props.foldersStopped) return;
        const onToggle = (event.target as Element).closest('[data-part="toggle"]') !== null;
        if (onToggle || event.altKey) {
          if (element.hasAttribute("aria-expanded")) {
            props.onExpand(
              Number(folder),
              element.getAttribute("aria-expanded") !== "true",
              event.altKey,
            );
          }
        } else {
          // A click on the row, not on its toggle, enters the folder.
          props.actions.navigateToFolder(Number(folder));
        }
      }
      // A click on a file only selects it. While the preview is open, it
      // follows the selection.
    };

    // A double-click on a file opens the preview. Its first click
    // selected the row. The two clicks must be on the same file.
    const onDoubleClick = (event: MouseEvent) => {
      const element = rowOf(event.target);
      if (
        element === null ||
        element.dataset.folder !== undefined ||
        !selectable(element) ||
        clicked[0] !== element.dataset.item ||
        clicked[1] !== element.dataset.item
      ) {
        return;
      }
      const label = element.querySelector<HTMLElement>('[data-part="label"]');
      if (label !== null) {
        props.onOpenEntry(label.title, Number(element.dataset.item));
      }
    };

    const onContextMenu = (event: MouseEvent) => {
      const element = rowOf(event.target);
      const views = reader.views();
      if (element === null || views === undefined || !selectable(element)) {
        return;
      }
      event.preventDefault();
      viewport.focus({ preventScroll: true });
      const item = selectShown(views, element);
      const block = element.dataset.block === "true";
      // A context-menu key on some systems gives a mouse event at 0, 0.
      if (event.button !== 2 && event.clientX === 0 && event.clientY === 0) {
        openMenu(item, block);
      } else {
        // At the pointer, but below the row (or above it when there is
        // no room), so that the menu does not cover the name of its row. On
        // a name it starts at the start of the names, so it leaves no stubs
        // of the names below it.
        const row = element.getBoundingClientRect();
        const name = element.querySelector('[data-part="label"]')?.getBoundingClientRect();
        const x =
          name !== undefined && event.clientX >= name.left && event.clientX < name.right
            ? name.left
            : event.clientX;
        openMenu(item, block, { x, y: row.top, width: 0, height: row.height });
      }
    };

    // Tab to the grid with no selection: the first row is the cursor.
    const onFocus = () => {
      const views = reader.views();
      if (
        !focusWithNoRow &&
        selected === undefined &&
        views !== undefined &&
        viewport.matches(":focus-visible")
      ) {
        select(views, 0);
      }
    };

    // The ring of the first row is only for the focus that a control of the door
    // moved here.
    const onBlur = () => delete viewport.dataset.firstRing;

    // A new height can hide the selected row, for example when a preview adds
    // a finding to the health list. A row that was in view stays in view. A
    // hidden table has no height, and that says nothing about the room.
    let rowsInView = pool.visibleRows();
    const keepSelectedInView = () => {
      const views = reader.views();
      if (viewport.clientHeight === 0 || views === undefined) return;
      if (selected !== undefined) {
        const first = pool.firstRow(rowsOf(views).count);
        const index = selectedIndex(views);
        if (index >= first && index < first + rowsInView) revealRow = index;
      }
      rowsInView = pool.visibleRows();
    };

    const unmount = mountRowPool({
      pool,
      viewport,
      loop: props.loop,
      render,
      rowCount: () => rowCount,
      observe: [nameHeader],
      onResize: () => {
        measureLayout();
        keepSelectedInView();
      },
    });
    const schedule = () => props.loop.schedule();
    const onFonts = () => {
      widths.clear();
      layout++;
      schedule();
    };
    document.fonts?.addEventListener("loadingdone", onFonts);
    // A double-click opens a preview: it does not select the text below it.
    const onMouseDown = (event: MouseEvent) => {
      if (event.detail > 1) event.preventDefault();
    };
    layer.addEventListener("mousedown", onMouseDown);
    viewport.addEventListener("focus", onFocus);
    viewport.addEventListener("blur", onBlur);
    viewport.addEventListener("keydown", onKeyDown);
    viewport.addEventListener("contextmenu", onContextMenu);
    layer.addEventListener("click", onClick);
    layer.addEventListener("dblclick", onDoubleClick);

    return () => {
      disposed = true;
      unmount();
      document.fonts?.removeEventListener("loadingdone", onFonts);
      layer.removeEventListener("mousedown", onMouseDown);
      viewport.removeEventListener("focus", onFocus);
      viewport.removeEventListener("blur", onBlur);
      viewport.removeEventListener("keydown", onKeyDown);
      viewport.removeEventListener("contextmenu", onContextMenu);
      layer.removeEventListener("click", onClick);
      layer.removeEventListener("dblclick", onDoubleClick);
    };
  });

  return (
    <>
      <div
        ref={(el) => (viewport = el)}
        id="list-viewport"
        role="grid"
        aria-label="Entries"
        aria-describedby={isBestMatch(props.sort) ? SORT_STATUS_ID : undefined}
        aria-keyshortcuts="Enter Space Escape Backspace * Shift+F10"
        tabindex={0}
        {...stylex.attrs(styles.viewport, shared.focused, stylex.defaultMarker())}
      >
        <div
          ref={(el) => (header = el)}
          role="row"
          aria-rowindex="1"
          {...stylex.attrs(styles.grid, styles.header)}
        >
          {COLUMNS.map((column) => (
            <span
              ref={(el) => {
                if (column.key === "name") nameHeader = el;
              }}
              role="columnheader"
              aria-sort={ariaSort(column.sort)}
              data-column={column.key}
              data-cell={column.key}
              {...stylex.attrs(
                styles.cell,
                column.kind === "name" ? null : styles[column.kind],
                column.key === "method" && styles.method,
              )}
            >
              {column.sort === undefined ? (
                <span {...stylex.attrs(styles.plainHeader, styles.sortEnd)}>{column.label}</span>
              ) : (
                <button
                  ref={(el) => {
                    if (column.key === "modified") modifiedButton = el;
                  }}
                  type="button"
                  aria-disabled={props.sortStopped ? "true" : undefined}
                  // The reason of the hard stop and the DOS note, for a
                  // screen reader. The note card shows the note as text.
                  aria-describedby={
                    [
                      props.sortStopped ? STOPPED_ID : "",
                      column.key === "modified" && dosOnly() ? DOS_NOTE_ID : "",
                    ]
                      .filter((id) => id !== "")
                      .join(" ") || undefined
                  }
                  onPointerEnter={() => {
                    if (column.key === "modified") setNotePointed(true);
                  }}
                  onPointerLeave={(event) => {
                    if (column.key === "modified" && !onNote(event.relatedTarget)) {
                      setNotePointed(false);
                    }
                  }}
                  onFocus={() => {
                    if (column.key === "modified") setNoteFocused(true);
                  }}
                  onBlur={() => {
                    if (column.key === "modified") setNoteFocused(false);
                  }}
                  onKeyDown={(event) => {
                    if (column.key === "modified" && event.key === "Escape") {
                      setNotePointed(false);
                      setNoteFocused(false);
                    }
                  }}
                  onClick={() => {
                    if (!props.sortStopped) props.onSort(column.sort);
                  }}
                  {...stylex.attrs(
                    styles.sortButton,
                    controls.focusRing,
                    ariaSort(column.sort) !== undefined && styles.sortedHeader,
                    column.kind === "numeric" && styles.sortEnd,
                    column.key === "modified" && styles.noteAnchor,
                  )}
                >
                  <span
                    {...stylex.attrs(column.key === "modified" && dosOnly() && styles.noTimeZone)}
                  >
                    {column.label}
                  </span>
                  {/* With no sort, the arrow takes no gap, so a number
                    header ends at the right edge of its values. */}
                  <span aria-hidden="true" {...stylex.attrs(styles.sortArrow)}>
                    {ariaSort(column.sort) === undefined
                      ? ""
                      : ariaSort(column.sort) === "ascending"
                        ? "↑"
                        : "↓"}
                  </span>
                </button>
              )}
            </span>
          ))}
        </div>
        <div ref={(el) => (spacer = el)} role="none" {...stylex.attrs(shared.spacer)} />
        <div ref={(el) => (layer = el)} role="none" {...stylex.attrs(styles.layer)} />
        <div
          ref={(el) => (empty = el)}
          id="search-empty"
          role="none"
          hidden
          {...stylex.attrs(styles.empty, styles.emptySearch, shared.muted)}
        />
        {/* An empty table has a message in ink and a next action, and no
            header over nothing. */}
        <div ref={(el) => (archiveEmpty = el)} role="none" hidden {...stylex.attrs(styles.empty)}>
          <p id="archive-empty" {...stylex.attrs(styles.emptyText)}>
            {tableText.noEntries}
          </p>
          <button
            id="archive-empty-open"
            type="button"
            onClick={() => props.onPick?.()}
            {...stylex.attrs(controls.button, controls.focusRing)}
          >
            <Icon name="open" />
            {tableText.openAnother}
          </button>
        </div>
        <div ref={(el) => (folderEmpty = el)} role="none" hidden {...stylex.attrs(styles.empty)}>
          <p id="folder-empty" {...stylex.attrs(styles.emptyText)}>
            {tableText.emptyFolder}
          </p>
          <button
            id="folder-empty-up"
            type="button"
            onClick={() => props.actions.goUp()}
            {...stylex.attrs(controls.button, controls.focusRing)}
          >
            <Icon name="up" />
            {tableText.goUp}
          </button>
        </div>
      </div>
      {/* The description of the rows of the largest files. The label row
          is a pool row whose element changes, so the rows refer to this
          stable node. */}
      <div
        ref={(el) => (noteCard = el)}
        id={DOS_NOTE_ID}
        role="tooltip"
        popover="manual"
        onPointerLeave={(event) => {
          if (!onNote(event.relatedTarget)) setNotePointed(false);
        }}
        {...stylex.attrs(styles.noteCard, ANCHORS && styles.noteAnchored, controls.fadeIn)}
      >
        {DOS_NOTE}
      </div>
      <span id={LARGEST_LABEL_ID} hidden>
        {LARGEST_LABEL}
      </span>
      <RowMenu
        api={(api) => (menu = api)}
        onPreview={(target) => {
          if (target.kind === "entry") props.onOpenEntry(target.path, target.row);
        }}
        foldersStopped={props.foldersStopped}
        onShowInTree={(target) => showInTree(target)}
        onExtract={(target) => props.onExtract(target)}
        onClose={() => focusGrid()}
      />
    </>
  );
}
