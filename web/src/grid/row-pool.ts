// A recycled pool of fixed-height rows (`ROW_HEIGHT`). The pool holds about twice the
// visible rows, so the DOM node count depends on the viewport height only,
// never on the row count. Rows are placed with `transform`, and the cells
// of a row change only when the row element gets a new row.
//
// Above `SCROLL_CAP` px of rows, scrolling is scaled (see scroll.ts). The
// pool then keeps the first row itself, moves it by rows for wheel events,
// and places the rows relative to the scroll position.
import {
  firstToReveal,
  ROW_HEIGHT,
  rowAtScroll,
  scrollForRow,
  scrollGeometry,
  wheelRows,
} from "./scroll";
import type { ScrollGeometry } from "./scroll";

export { ROW_HEIGHT };

/** The slot shows a row, but it must be filled again. */
const UNKNOWN = -2;

/** The window of one render, from `plan`. */
export interface Plan {
  start: number;
  rows: number[];
}

/** One row of a pool: its element, and the parts that a fill writes. */
export interface PoolRow {
  element: HTMLElement;
}

export class RowPool<R extends PoolRow> {
  private readonly elements: R[] = [];
  /** The row that each element shows, or -1. */
  private shown: number[] = [];
  private rowCount = -1;
  /** The first row, with a fraction, while scrolling is scaled. */
  private first = 0;
  /** The scroll position that the pool set or read last, while scrolling
   *  is scaled. Another position comes from the scroll bar. */
  private expected = -1;
  /** The values of the last plan. */
  private planned = { first: 0, top: 0, scaled: false };
  /** The placement of the shown rows while scrolling is scaled. */
  private placed = "";
  /** Extra space above a row and the rows after it, while scrolling is
   *  native: the gap above the largest-files block. */
  private gap = { at: -1, px: 0 };

  constructor(
    private readonly viewport: HTMLElement,
    private readonly spacer: HTMLElement,
    private readonly layer: HTMLElement,
    /** Makes one row: its element and its parts. */
    private readonly create: () => R,
    /** Pixels in the viewport above the spacer, for example a header. */
    private readonly offset = 0,
  ) {}

  /** Sets the pool size from the viewport height. */
  resize(): void {
    const visible = Math.ceil(this.viewport.clientHeight / ROW_HEIGHT) + 1;
    const size = visible * 2;
    while (this.elements.length < size) {
      const row = this.create();
      row.element.hidden = true;
      this.layer.append(row.element);
      this.elements.push(row);
    }
    while (this.elements.length > size) {
      this.elements.pop()?.element.remove();
    }
    this.shown = this.elements.map(() => -1);
    for (const row of this.elements) {
      row.element.hidden = true;
    }
    this.placed = "";
  }

  /** Fills every shown row again on the next render, for example when the
   *  views changed. */
  invalidate(): void {
    // Not -1, which means hidden: a shown row past the new row count must
    // still be hidden.
    this.shown.fill(UNKNOWN);
  }

  /** Returns the pool row that shows a row, if the row is shown. */
  rowAt(row: number): R | undefined {
    const slot = row % this.elements.length;
    return this.shown[slot] === row ? this.elements[slot] : undefined;
  }

  /** Returns the pool rows that show a row. */
  shownRows(): R[] {
    return this.elements.filter((_, slot) => (this.shown[slot] ?? -1) >= 0);
  }

  /** Returns the number of row elements. */
  size(): number {
    return this.elements.length;
  }

  /** Returns the rows that fit in the viewport, with a fraction. */
  visibleRows(): number {
    return Math.max(1, (this.viewport.clientHeight - this.offset) / ROW_HEIGHT);
  }

  private geometry(rowCount: number): ScrollGeometry {
    return scrollGeometry(rowCount, this.viewport.clientHeight, this.offset, ROW_HEIGHT);
  }

  /**
   * Returns the first row in the viewport, with a fraction, for `rowCount`
   * rows. Natively, it uses the scroll position that the viewport gets
   * when the spacer has the height for `rowCount`: when the rows get
   * fewer, the browser makes the scroll position smaller.
   */
  firstRow(rowCount: number): number {
    const geometry = this.geometry(rowCount);
    const top = this.viewport.scrollTop;
    if (!geometry.scaled) {
      return rowAtScroll(geometry, top);
    }
    if (Math.abs(top - this.expected) > 1) {
      // The scroll bar moved.
      this.first = rowAtScroll(geometry, top);
      this.expected = top;
    }
    this.first = Math.min(Math.max(0, this.first), geometry.maxFirst);
    return this.first;
  }

  /** Scrolls so that all of `row` shows, with the least movement. With
   *  scaled scrolling, it uses the inverse map. */
  reveal(row: number, rowCount: number): void {
    const first = firstToReveal(this.firstRow(rowCount), row, this.visibleRows());
    this.scrollTo(this.geometry(rowCount), first);
  }

  /** Scrolls so that `row` is the first row, or as near as the listing
   *  allows. */
  scrollToRow(row: number, rowCount: number): void {
    this.scrollTo(this.geometry(rowCount), row);
  }

  private scrollTo(geometry: ScrollGeometry, first: number): void {
    const top = scrollForRow(geometry, first);
    if (geometry.scaled) {
      this.first = Math.min(Math.max(0, first), geometry.maxFirst);
      this.expected = top;
    }
    this.viewport.scrollTop = top;
  }

  /** Moves by rows for a wheel or trackpad event while scrolling is
   *  scaled. Natively, the browser scrolls. Returns true when it used the
   *  event. */
  wheel(event: WheelEvent, rowCount: number): boolean {
    const geometry = this.geometry(rowCount);
    if (!geometry.scaled || event.ctrlKey || event.deltaY === 0) {
      return false;
    }
    const first = this.firstRow(rowCount) + wheelRows(event, this.visibleRows(), ROW_HEIGHT);
    this.scrollTo(geometry, first);
    return true;
  }

  /**
   * Returns the window that the next `render` uses, and the rows in it that
   * their element does not show yet. With `all`, it returns all rows of the
   * window. Read the values of these rows, then give the same window to
   * `render`.
   */
  plan(rowCount: number, all: boolean): Plan {
    const size = this.elements.length;
    const geometry = this.geometry(rowCount);
    const first = this.firstRow(rowCount);
    this.planned = {
      first,
      top: geometry.scaled ? scrollForRow(geometry, first) : 0,
      scaled: geometry.scaled,
    };
    const start = Math.max(0, Math.floor(first) - Math.floor(size / 4));
    const rows: number[] = [];
    for (let row = start; row < Math.min(rowCount, start + size); row++) {
      if (all || this.shown[row % size] !== row) {
        rows.push(row);
      }
    }
    return { start, rows };
  }

  /** Returns the `translateY` of a row, from the last plan. */
  private position(row: number): number {
    const { first, top, scaled } = this.planned;
    if (scaled) return top + (row - first) * ROW_HEIGHT;
    return row * ROW_HEIGHT + (this.gap.at >= 0 && row >= this.gap.at ? this.gap.px : 0);
  }

  /** Puts `px` of space above row `at` and the rows after it (-1: no
   *  space). The rows move on the next render. */
  setGap(at: number, px: number): void {
    if (at === this.gap.at && px === this.gap.px) return;
    this.gap = { at, px };
    this.placed = "";
    this.rowCount = -1;
  }

  /** Sets the height of the spacer for `rowCount` rows, so that a scroll can go
   *  to each of them before the next render. */
  fit(rowCount: number): void {
    if (rowCount === this.rowCount) return;
    const geometry = this.geometry(rowCount);
    const extra = !geometry.scaled && this.gap.at >= 0 ? this.gap.px : 0;
    this.spacer.style.height = `${geometry.spacer + extra}px`;
    this.rowCount = rowCount;
  }

  /**
   * Shows the rows of the window that starts at `start` (from `plan`).
   * `fill` returns false when it has no values for a row. Then the row
   * stays hidden and is filled on the next render. Returns false when a
   * row was not filled.
   */
  render(rowCount: number, start: number, fill: (row: R, index: number) => boolean): boolean {
    this.fit(rowCount);
    const { scaled, top, first } = this.planned;
    if (scaled && Math.abs(this.viewport.scrollTop - top) > 1) {
      // The rows changed: keep the first row and move the scroll bar.
      this.viewport.scrollTop = top;
      this.expected = top;
    }
    // While scrolling is scaled, every shown row moves with the scroll
    // position.
    const placed = scaled ? `${top}:${first}` : "native";
    const move = placed !== this.placed;
    this.placed = placed;
    const size = this.elements.length;
    let filled = true;
    for (let row = start; row < start + size; row++) {
      const slot = row % size;
      const pooled = this.elements[slot];
      if (pooled === undefined) {
        continue;
      }
      const element = pooled.element;
      if (row >= rowCount) {
        if (this.shown[slot] !== -1) {
          element.hidden = true;
          this.shown[slot] = -1;
        }
        continue;
      }
      if (this.shown[slot] === row) {
        if (move) {
          element.style.transform = `translateY(${this.position(row)}px)`;
        }
        continue;
      }
      if (!fill(pooled, row)) {
        element.hidden = true;
        this.shown[slot] = UNKNOWN;
        filled = false;
        continue;
      }
      element.style.transform = `translateY(${this.position(row)}px)`;
      element.dataset.row = String(row);
      element.hidden = false;
      this.shown[slot] = row;
    }
    return filled;
  }
}
