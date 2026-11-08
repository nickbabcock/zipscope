import * as stylex from "@stylexjs/stylex";
import { onSettled } from "solid-js";
import { exactBytes, settlingSize } from "../format";
import type { Frame, FrameLoop, Prepared } from "../grid/frame";
import { mountRowPool } from "../grid/mount";
import { chainTruncate, fontOf, TextWidths } from "../grid/truncate";
import { cutLabel, nameTitle } from "../label";
import type { Measure } from "../grid/truncate";
import { RowPool } from "../grid/row-pool";
import type { PoolRow } from "../grid/row-pool";
import { COARSE_POINTER } from "../grid/scroll";
import { TreeOrder } from "../contracts";
import { MirrorReader } from "../store/reader";
import type { ViewSet } from "../store/reader";
import { barWidth, hasBar, landingFirstRow, treeIndexOf, treeRow, walkChain } from "../view/model";
import { STOPPED_ID } from "../health/findings";
import { color } from "../theme/tokens.stylex";
import type { TreeAnchor, TreeAnchors, TreeRow } from "../view/model";
import { addChevron, cls, createBar, setBar, shared, turnChevron } from "../view/styles";

export interface TreeViewProps {
  reader: MirrorReader;
  loop: FrameLoop;
  /** The name of the archive, for the root row. */
  archiveName: string;
  /** Selects a folder: the table lists it. `pointer` is true for a click
   *  and false for the arrow keys. */
  onSelect: (folder: number, pointer: boolean) => void;
  /** Expands or collapses the row that ends at a folder. */
  onToggle: (folder: number, open: boolean) => void;
  /** True after the hard stop, when the worker refuses each folder
   *  request. The rows have no toggle and do not open. */
  stopped: boolean;
}

/** Indent of one level, in pixels. */
const INDENT = 16;
/** The width of the toggle column and the left padding at level 0, in
 *  pixels. A coarse pointer gets a toggle of 32 px, so that a finger can
 *  hit it. The padding is 8 px less, so the chevron stays at the center
 *  of its contour line. See `styles.rowCoarse`. */
const TOGGLE = COARSE_POINTER ? 32 : 16;
const PADDING = COARSE_POINTER ? 0 : 8;

const styles = stylex.create({
  viewport: {
    contain: "strict",
    flexGrow: 1,
    minHeight: 0,
    outline: "none",
    overflowY: "auto",
    position: "relative",
  },
  layer: {
    insetInline: 0,
    position: "absolute",
    top: 0,
  },
  row: {
    alignItems: "center",
    boxSizing: "border-box",
    columnGap: 6,
    cursor: "default",
    display: "grid",
    fontVariantNumeric: "tabular-nums",
    gridTemplateColumns: "16px minmax(0, 1fr) auto",
    // ROW_HEIGHT. StyleX needs literal values.
    height: 24,
    insetInline: 0,
    lineHeight: "24px",
    paddingRight: 12,
    position: "absolute",
    top: 0,
    whiteSpace: "nowrap",
    willChange: "transform",
  },
  /** The row for a coarse pointer: COARSE_ROW_HEIGHT, and a toggle column
   *  of 32 px. */
  rowCoarse: {
    gridTemplateColumns: "32px minmax(0, 1fr) auto",
    height: 36,
    lineHeight: "36px",
  },
  guides: {
    // One 1px contour line for each level, at the center of the toggle
    // of that level: x = 15 + 16 × level.
    backgroundImage: `repeating-linear-gradient(to right, transparent 0 15px, color-mix(in srgb, ${color.contour} 35%, transparent) 15px 16px)`,
    bottom: 0,
    left: 0,
    pointerEvents: "none",
    position: "absolute",
    top: 0,
  },
  toggle: {
    alignItems: "center",
    color: color.inkMuted,
    display: "flex",
    height: 16,
    justifyContent: "center",
    width: 16,
  },
  /** For a coarse pointer, the toggle fills its column and the row
   *  height, and all of it is the hit area. */
  toggleCoarse: {
    alignSelf: "stretch",
    height: "auto",
    width: "auto",
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "pre",
  },
  /** The root is above the rows, not louder than the selection. */
  root: {
    fontWeight: 500,
  },
  /** The current folder, in both pane states, so it is easy to find. */
  current: {
    fontWeight: 600,
  },
  size: {
    alignItems: "center",
    columnGap: 8,
    display: "inline-grid",
    gridTemplateColumns: "28px 72px",
  },
  /** Only the size text: as wide as it needs, so the name gets the rest. */
  sizeOnly: {
    gridTemplateColumns: "minmax(60px, max-content)",
  },
  /** The size is secondary to the name, except on the selected row. */
  sizeText: {
    color: color.inkMuted,
    textAlign: "right",
  },
  sizeTextSelected: {
    color: color.ink,
  },
});

const ROW_CLASS = cls(stylex.props(styles.row, COARSE_POINTER && styles.rowCoarse));
const SELECTED_CLASS = cls(
  stylex.props(styles.row, COARSE_POINTER && styles.rowCoarse, shared.selected),
);
const TOGGLE_CLASS = cls(stylex.props(styles.toggle, COARSE_POINTER && styles.toggleCoarse));
const NAME_CLASS = cls(stylex.props(styles.name));
const ROOT_CLASS = cls(stylex.props(styles.name, styles.root));
const CURRENT_CLASS = cls(stylex.props(styles.name, styles.current));
const SIZE_TEXT_CLASS = cls(stylex.props(styles.sizeText));
const SELECTED_TEXT_CLASS = cls(stylex.props(styles.sizeText, styles.sizeTextSelected));
const SETTLING_TEXT_CLASS = cls(stylex.props(styles.sizeText, shared.settling));
const SIZE_CLASS = cls(stylex.props(styles.size));
const SIZE_ONLY_CLASS = cls(stylex.props(styles.size, styles.sizeOnly));

let nextId = 0;

/** One tree row of the pool and the parts that `writeRow` changes. */
interface TreeRowParts extends PoolRow {
  guides: HTMLElement;
  toggle: HTMLElement;
  chevron: Element;
  name: HTMLElement;
  bar: HTMLElement;
  text: HTMLElement;
  /** The bar and the size text. */
  size: HTMLElement;
}

/** The room of the row around its name: the left padding at level 0, the
 *  toggle, two gaps and the right padding. */
const ROW_CHROME = PADDING + TOGGLE + 6 + 6 + 12;
/** The size column with its bar. */
const SIZE_WITH_BAR = 28 + 8 + 72;
/** The size column with no bar: a usual size text. */
const SIZE_ALONE = 60;
/** The bold name of the current folder is wider than the measure. */
const BOLD_MARGIN = 1.08;
/** The width of the bar slot. */
const BAR_SLOT = 28;
/** A group with more siblings has no bars. It is not read to decide. */
const GROUP_MAX_SIBLINGS = 64;
/** The rows that are read to find the start of a group. */
const GROUP_MAX_STEPS = 4096;

/** Makes one tree row. */
function createRow(): TreeRowParts {
  const row = document.createElement("div");
  row.id = `tree-row-${nextId++}`;
  row.className = ROW_CLASS;
  row.setAttribute("role", "treeitem");
  const guides = document.createElement("span");
  guides.className = cls(stylex.props(styles.guides));
  guides.setAttribute("aria-hidden", "true");
  const toggle = document.createElement("span");
  toggle.className = TOGGLE_CLASS;
  toggle.dataset.part = "toggle";
  const chevron = addChevron(toggle);
  const name = document.createElement("span");
  name.className = NAME_CLASS;
  name.dataset.part = "label";
  name.dir = "ltr";
  const size = document.createElement("span");
  size.className = SIZE_CLASS;
  const text = document.createElement("span");
  const bar = createBar();
  size.append(bar, text);
  row.append(guides, toggle, name, size);
  return { element: row, guides, toggle, chevron, name, bar, text, size };
}

/** The values of one tree row, read from the views. */
interface RowValues {
  row: TreeRow;
  selected: boolean;
  /** Undefined when the row cannot show yet. */
  name?: string;
  isRoot: boolean;
  size: number;
  /** The size of the parent folder, for the size bar. */
  total?: number;
  /** True when the group of siblings of this row has bars. */
  groupBars?: boolean;
}

/** Reads a tree row. */
function readRow(props: TreeViewProps, frame: Frame, views: ViewSet, index: number): RowValues {
  const row = treeRow(views.tree, index);
  const reader = props.reader;
  const isRoot = row.level === 0;
  const values: RowValues = { row, selected: row.folder === views.folder, isRoot, size: 0 };
  if (row.folder >= frame.folders) {
    return values;
  }
  const chain = walkChain(reader, row.folder, { steps: row.chain });
  const rollup = MirrorReader.rollup(views, chain.head);
  if (rollup === undefined) {
    return values;
  }
  values.name = isRoot ? props.archiveName : chain.names.join("/");
  values.size = rollup[0];
  // The share of the parent folder. The root has no bar.
  if (!isRoot) {
    values.total = MirrorReader.rollup(views, reader.folderParent(chain.head))?.[0];
  }
  return values;
}

/** Writes the values of a tree row to its element. */
function writeRow(
  parts: TreeRowParts,
  values: RowValues,
  settles: boolean,
  stopped: boolean,
  width: number,
  measure: Measure,
): void {
  const { element, guides, toggle, chevron, name, bar, text, size } = parts;
  const row = values.row;
  // The name is the main datum. A group of siblings that has no room for one
  // bar has no bars, and a row too small for a bar has none. The size stays.
  const room = width - ROW_CHROME - row.level * INDENT;
  const barless = values.groupBars !== true || !hasBar(values.size, values.total ?? 0, BAR_SLOT);
  bar.hidden = barless;
  size.className = barless ? SIZE_ONLY_CLASS : SIZE_CLASS;
  element.style.paddingLeft = `${PADDING + row.level * INDENT}px`;
  guides.style.width = `${row.level * INDENT}px`;
  element.dataset.folder = String(row.folder);
  element.dataset.expanded = String(row.expanded);
  element.setAttribute("aria-level", String(row.level + 1));
  element.setAttribute("aria-posinset", String(row.position));
  element.setAttribute("aria-setsize", String(row.size));
  if (row.hasChildren) {
    element.setAttribute("aria-expanded", String(row.expanded));
  } else {
    element.removeAttribute("aria-expanded");
  }
  element.setAttribute("aria-selected", String(values.selected));
  element.className = values.selected ? SELECTED_CLASS : ROW_CLASS;
  turnChevron(chevron, row.expanded);
  toggle.style.visibility = row.hasChildren && !stopped ? "" : "hidden";
  if (stopped) {
    element.setAttribute("aria-disabled", "true");
    element.setAttribute("aria-describedby", STOPPED_ID);
  } else {
    element.removeAttribute("aria-disabled");
    element.removeAttribute("aria-describedby");
  }
  if (values.name === undefined) {
    name.textContent = "";
    text.textContent = "";
    setBar(bar, 0);
    return;
  }
  // The current folder is bold, so its widths have a margin.
  name.textContent = cutLabel(values.name, (shown) =>
    chainTruncate(
      shown,
      Math.max(0, room - (barless ? SIZE_ALONE : SIZE_WITH_BAR)),
      values.selected ? (text) => measure(text) * BOLD_MARGIN : measure,
    ),
  );
  name.title = nameTitle(values.name);
  name.className = values.selected ? CURRENT_CLASS : values.isRoot ? ROOT_CLASS : NAME_CLASS;
  text.textContent = settlingSize(values.size, settles);
  text.title = exactBytes(values.size);
  text.className = settles
    ? SETTLING_TEXT_CLASS
    : values.selected
      ? SELECTED_TEXT_CLASS
      : SIZE_TEXT_CLASS;
  const total = values.total;
  setBar(bar, total === undefined ? 0 : barWidth(values.size, total));
  bar.title =
    total === undefined || !(total > 0)
      ? ""
      : `${Math.round((values.size / total) * 100)}% of the parent folder`;
}

/**
 * The folder tree: the same recycled rows as the table, with contour
 * guides, in the WAI-ARIA tree pattern. Focus stays on the tree, and
 * `aria-activedescendant` names the selected row. The selection follows
 * the arrow keys.
 */
export function TreeView(props: TreeViewProps) {
  let viewport!: HTMLDivElement;
  let spacer!: HTMLDivElement;
  let layer!: HTMLDivElement;

  onSettled(() => {
    const reader = props.reader;
    const pool = new RowPool<TreeRowParts>(viewport, spacer, layer, createRow);
    pool.resize();
    const widths = new TextWidths();
    widths.setFont(fontOf(viewport));
    /** The width of the rows. The names and their bars depend on it. */
    let width = viewport.clientWidth;
    let groupsWidth = width;
    let key = "";
    let rowCount = 0;
    /** The row of the listed folder in the last stable set of the views.
     *  A generation is never used again, so a frame with no new views
     *  does not scan the tree. */
    let selection = { generation: -1, folder: -1, index: -1 };
    /** The decision of each group of siblings for these views and this
     *  width, by the first row of the group. */
    let groups = new Map<number, boolean>();
    /** Returns true when the siblings of a row have room for bars: each name
     *  fits next to a bar. Thus a bar does not come and go with the width of a
     *  name at one level. A large group has no bars, so the work of one group
     *  has a limit. */
    const groupBars = (frame: Frame, views: ViewSet, index: number, row: TreeRow): boolean => {
      if (row.level === 0 || row.size > GROUP_MAX_SIBLINGS) return false;
      let start = index;
      for (let steps = 0; start > 0 && treeRow(views.tree, start - 1).level >= row.level; steps++) {
        if (steps === GROUP_MAX_STEPS) return false;
        start--;
      }
      const known = groups.get(start);
      if (known !== undefined) return known;
      const room = width - ROW_CHROME - row.level * INDENT - SIZE_WITH_BAR;
      let bars = true;
      for (
        let at = start, steps = 0;
        at < views.treeRows && steps < GROUP_MAX_STEPS;
        at++, steps++
      ) {
        const sibling = treeRow(views.tree, at);
        if (sibling.level < row.level) break;
        if (sibling.level > row.level) continue;
        if (sibling.folder >= frame.folders) return false;
        const chain = walkChain(reader, sibling.folder, { steps: sibling.chain });
        const name = chain.names.join("/");
        const measured =
          sibling.folder === views.folder
            ? widths.measure(name) * BOLD_MARGIN
            : widths.measure(name);
        if (measured > room) {
          bars = false;
          break;
        }
      }
      groups.set(start, bars);
      return bars;
    };
    /** Returns the index of the row of the listed folder, or -1. */
    const selectedIndex = (views: ViewSet): number =>
      views.generation === selection.generation && views.folder === selection.folder
        ? selection.index
        : treeIndexOf(views.tree, views.treeRows, views.folder);

    /** The order of the last frame. */
    let order: number = TreeOrder.ARCHIVE;
    /** The rows that stay in place when the name order lands, from the last
     *  frame in archive order. */
    let anchors: TreeAnchors | undefined;
    /** The row that a person moved to, until the view set selects it. */
    let moving: TreeAnchor | undefined;
    /** Records a move of the selection to the row at `index`. A frame in the
     *  name order can come before the frame of the move, so the row stays in
     *  place also then. */
    const moved = (folder: number, index: number, rows: number) => {
      if (order === TreeOrder.ARCHIVE) {
        moving = { folder, rowsFromTop: index - pool.firstRow(rows) };
      }
    };
    /** Returns the rows that a frame in archive order keeps for the landing. */
    const readAnchors = (views: ViewSet, selected: number): TreeAnchors | undefined => {
      if (views.treeRows === 0) return undefined;
      const first = pool.firstRow(views.treeRows);
      const top = Math.min(Math.floor(first), views.treeRows - 1);
      const rowsFromTop = selected - first;
      return {
        selected:
          selected >= 0 && rowsFromTop > -1 && rowsFromTop < pool.visibleRows()
            ? { folder: views.folder, rowsFromTop }
            : undefined,
        top: { folder: treeRow(views.tree, top).folder, rowsFromTop: top - first },
      };
    };

    // Reads the rows that change. The DOM changes only in `commit`, after
    // the frame checked that the view set did not change.
    const render = (frame: Frame): Prepared => {
      const views = frame.views;
      const rows = views?.treeRows ?? 0;
      const stopped = props.stopped;
      const next = `${views?.generation}:${frame.folders}:${frame.state}:${stopped}`;
      if (next !== key || width !== groupsWidth) {
        groups = new Map();
        groupsWidth = width;
      }
      const values = new Map<number, RowValues>();
      let complete = views !== undefined;
      // Scroll before the plan, so that the plan has the rows of the new
      // position. A frame that does not commit does this again, with the same
      // rows, and gets the same position.
      if (views !== undefined && views.treeOrder !== order && anchors !== undefined) {
        const first = landingFirstRow(views.tree, rows, { ...anchors, moving });
        if (first !== undefined) {
          // The last rows of the parse can come with the order.
          pool.fit(rows);
          pool.scrollToRow(first, rows);
        }
      }
      const plan = pool.plan(rows, next !== key);
      if (views !== undefined) {
        for (const index of plan.rows) {
          const value = readRow(props, frame, views, index);
          complete &&= value.name !== undefined;
          value.groupBars = groupBars(frame, views, index, value.row);
          values.set(index, value);
        }
      }
      const selected = views === undefined ? -1 : selectedIndex(views);
      const archive = views?.treeOrder === TreeOrder.ARCHIVE;
      const seen = archive ? readAnchors(views, selected) : undefined;
      return {
        complete,
        commit: () => {
          if (views !== undefined) {
            selection = { generation: views.generation, folder: views.folder, index: selected };
            order = views.treeOrder;
            anchors = seen;
            viewport.dataset.order = archive ? "archive" : "name";
            if (!archive || moving?.folder === views.folder) moving = undefined;
          }
          viewport.dataset.rows = String(rows);
          rowCount = rows;
          if (next !== key) {
            key = next;
            pool.invalidate();
          }
          const filled = pool.render(rows, plan.start, (row, index) => {
            const value = values.get(index);
            if (value === undefined) {
              return false;
            }
            writeRow(row, value, frame.settling, stopped, width, widths.measure);
            return true;
          });
          if (!filled) {
            props.loop.schedule();
          }
          const active = selected < 0 ? undefined : pool.rowAt(selected);
          if (active === undefined) {
            viewport.removeAttribute("aria-activedescendant");
          } else {
            viewport.setAttribute("aria-activedescendant", active.element.id);
          }
        },
      };
    };

    const select = (views: ViewSet, index: number) => {
      if (index < 0 || index >= views.treeRows) {
        return;
      }
      if (props.stopped) return;
      pool.reveal(index, views.treeRows);
      const { folder } = treeRow(views.tree, index);
      moved(folder, index, views.treeRows);
      props.onSelect(folder, false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const views = reader.views();
      if (views === undefined || event.altKey || event.ctrlKey || event.metaKey || props.stopped) {
        return;
      }
      const current = selectedIndex(views);
      const row: TreeRow | undefined = current < 0 ? undefined : treeRow(views.tree, current);
      switch (event.key) {
        case "ArrowDown":
          select(views, current + 1);
          break;
        case "ArrowUp":
          select(views, Math.max(0, current - 1));
          break;
        case "Home":
          select(views, 0);
          break;
        case "End":
          select(views, views.treeRows - 1);
          break;
        case "ArrowRight":
          if (row?.hasChildren && !row.expanded) {
            props.onToggle(row.folder, true);
          } else if (row?.expanded) {
            select(views, current + 1);
          }
          break;
        case "ArrowLeft":
          if (row?.expanded) {
            props.onToggle(row.folder, false);
          } else if (row !== undefined) {
            // Move to the parent row: the nearest row above at a lower level.
            for (let index = current - 1; index >= 0; index--) {
              if (treeRow(views.tree, index).level < row.level) {
                select(views, index);
                break;
              }
            }
          }
          break;
        default:
          return;
      }
      event.preventDefault();
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target as Element;
      const element = target.closest<HTMLElement>("[data-folder]");
      if (element === null || props.stopped) {
        return;
      }
      const folder = Number(element.dataset.folder);
      if (target.closest('[data-part="toggle"]') !== null) {
        props.onToggle(folder, element.dataset.expanded !== "true");
      } else {
        // A click on the root opens the Archive panel, so the view set does not
        // select it. The root row is always the first row.
        if (folder !== 0) moved(folder, Number(element.dataset.row), rowCount);
        props.onSelect(folder, true);
      }
    };

    const onDoubleClick = (event: MouseEvent) => {
      const element = (event.target as Element).closest<HTMLElement>("[data-folder]");
      if (element !== null && element.getAttribute("aria-expanded") !== null && !props.stopped) {
        props.onToggle(Number(element.dataset.folder), element.dataset.expanded !== "true");
      }
    };

    const unmount = mountRowPool({
      pool,
      viewport,
      loop: props.loop,
      render,
      rowCount: () => rowCount,
      onResize: () => {
        width = viewport.clientWidth;
        pool.invalidate();
      },
    });
    const onFonts = () => {
      widths.clear();
      groups = new Map();
      pool.invalidate();
      props.loop.schedule();
    };
    document.fonts?.addEventListener("loadingdone", onFonts);
    viewport.addEventListener("keydown", onKeyDown);
    layer.addEventListener("click", onClick);
    layer.addEventListener("dblclick", onDoubleClick);

    return () => {
      unmount();
      document.fonts?.removeEventListener("loadingdone", onFonts);
      viewport.removeEventListener("keydown", onKeyDown);
      layer.removeEventListener("click", onClick);
      layer.removeEventListener("dblclick", onDoubleClick);
    };
  });

  return (
    <div
      ref={(el) => (viewport = el)}
      id="tree-viewport"
      role="tree"
      aria-label="Folders"
      tabindex={0}
      {...stylex.attrs(styles.viewport, shared.focused, stylex.defaultMarker())}
    >
      <div ref={(el) => (spacer = el)} role="none" {...stylex.attrs(shared.spacer)} />
      <div ref={(el) => (layer = el)} role="none" {...stylex.attrs(styles.layer)} />
    </div>
  );
}
