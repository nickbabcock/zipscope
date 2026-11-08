// The map from the scroll position to rows. Browsers cap the height of an
// element (about 17.9M px in Firefox). Above `SCROLL_CAP` px of rows, the
// spacer keeps a fixed height and the scroll position is proportional to
// the first row: scaled scrolling. Below the cap, scrolling is native.

/** The row height of the tree and the table for a fine pointer (a mouse). */
export const FINE_ROW_HEIGHT = 24;
/** The row height of the tree and the table for a coarse pointer (a touch
 *  screen). */
export const COARSE_ROW_HEIGHT = 36;

/** Returns the row height of the tree and the table for the primary
 *  pointer. */
export function rowHeight(coarse: boolean): number {
  return coarse ? COARSE_ROW_HEIGHT : FINE_ROW_HEIGHT;
}

/**
 * True when the primary pointer is coarse when the page loads. A touch
 * laptop with a mouse has a fine primary pointer, so it keeps the dense
 * rows. The row pools need one fixed row height, so the rows of the tree
 * and the table keep this value for the life of the page. When the
 * primary pointer changes in a session, the rows change at the next page
 * load. The "…" of the breadcrumb does the same. Other controls follow
 * `(pointer: coarse)` in CSS at once.
 */
export const COARSE_POINTER =
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** The row height of the tree and the table on this page. */
export const ROW_HEIGHT = rowHeight(COARSE_POINTER);

/** The largest spacer height, in pixels. */
export const SCROLL_CAP = 8_000_000;

export interface ScrollGeometry {
  /** The height of one row, in pixels. */
  rowHeight: number;
  scaled: boolean;
  /** The spacer height. */
  spacer: number;
  /** The largest scroll position. */
  maxScroll: number;
  /** The largest first row, with a fraction: the last row is then at the
   *  bottom of the viewport. */
  maxFirst: number;
}

/**
 * Returns the geometry for `rows` rows of `rowHeight` pixels in a viewport
 * of `clientHeight` pixels, with `offset` pixels above the rows (a sticky
 * header).
 */
export function scrollGeometry(
  rows: number,
  clientHeight: number,
  offset: number,
  rowHeight: number,
): ScrollGeometry {
  const content = rows * rowHeight;
  const scaled = offset + content > SCROLL_CAP;
  const spacer = scaled ? SCROLL_CAP : content;
  const room = Math.max(0, clientHeight - offset);
  return {
    rowHeight,
    scaled,
    spacer,
    maxScroll: Math.max(0, offset + spacer - clientHeight),
    maxFirst: Math.max(0, rows - room / rowHeight),
  };
}

/** Returns the first row, with a fraction, at a scroll position. */
export function rowAtScroll(geometry: ScrollGeometry, scrollTop: number): number {
  const top = Math.min(Math.max(0, scrollTop), geometry.maxScroll);
  if (!geometry.scaled) {
    return top / geometry.rowHeight;
  }
  return geometry.maxScroll === 0 ? 0 : (top / geometry.maxScroll) * geometry.maxFirst;
}

/** Returns the scroll position that puts `first` at the top. It is the
 *  inverse of `rowAtScroll`. */
export function scrollForRow(geometry: ScrollGeometry, first: number): number {
  const row = Math.min(Math.max(0, first), geometry.maxFirst);
  if (!geometry.scaled) {
    return row * geometry.rowHeight;
  }
  return geometry.maxFirst === 0 ? 0 : (row / geometry.maxFirst) * geometry.maxScroll;
}

/**
 * Returns the first row that shows all of `row` with the least movement
 * from `first`. `visible` is the number of rows that fit, with a fraction.
 */
export function firstToReveal(first: number, row: number, visible: number): number {
  if (row < first) {
    return row;
  }
  if (row + 1 > first + visible) {
    return row + 1 - visible;
  }
  return first;
}

/** Returns the rows of `rowHeight` pixels that a wheel event moves. */
export function wheelRows(
  event: Pick<WheelEvent, "deltaY" | "deltaMode">,
  visible: number,
  rowHeight: number,
) {
  switch (event.deltaMode) {
    case 1: // Lines.
      return event.deltaY;
    case 2: // Pages.
      return event.deltaY * Math.max(1, Math.floor(visible));
    default:
      return event.deltaY / rowHeight;
  }
}
