// The row pool with a fake viewport. The fake viewport makes the scroll
// position smaller at once when the spacer gets shorter, as a browser can.
import { describe, expect, test } from "vitest";
import { ROW_HEIGHT, RowPool } from "./row-pool";
import { SCROLL_CAP } from "./scroll";

interface FakeElement {
  hidden: boolean;
  style: Record<string, string>;
  dataset: Record<string, string>;
  label: string;
}

function setup(height: number) {
  const spacer = { style: { height: "0px" } };
  let stored = 0;
  const viewport = {
    clientHeight: height,
    get scrollTop() {
      const max = Math.max(0, Number.parseFloat(spacer.style.height) - height);
      return Math.min(stored, max);
    },
    set scrollTop(value: number) {
      stored = value;
    },
  };
  const elements: FakeElement[] = [];
  const layer = { append: (element: FakeElement) => elements.push(element) };
  const pool = new RowPool(
    viewport as unknown as HTMLElement,
    spacer as unknown as HTMLElement,
    layer as unknown as HTMLElement,
    () => ({
      element: { hidden: false, style: {}, dataset: {}, label: "" } as unknown as HTMLElement,
    }),
  );
  pool.resize();
  /** Reads the planned rows, then renders them, as a frame does. */
  const frame = (rows: number, label: (row: number) => string, all = false) => {
    const plan = pool.plan(rows, all);
    const values = new Map(plan.rows.map((row) => [row, label(row)]));
    // As the views do: new views fill every row again.
    if (all) {
      pool.invalidate();
    }
    return pool.render(rows, plan.start, ({ element }, row) => {
      const value = values.get(row);
      if (value === undefined) {
        return false;
      }
      (element as unknown as FakeElement).label = value;
      return true;
    });
  };
  /** The rows that show in the viewport, with their labels. */
  const shown = () => {
    const top = viewport.scrollTop;
    return elements
      .filter((element) => !element.hidden)
      .map((element) => ({ row: Number(element.dataset.row), label: element.label }))
      .filter(({ row }) => (row + 1) * ROW_HEIGHT > top && row * ROW_HEIGHT < top + height);
  };
  /** The rows that show in the viewport, by their place: the transform
   *  less the scroll position. */
  const placed = () =>
    elements
      .filter((element) => !element.hidden)
      .map((element) => ({
        row: Number(element.dataset.row),
        y:
          Number(/translateY\((.*)px\)/.exec(element.style.transform ?? "")?.[1]) -
          viewport.scrollTop,
      }))
      .filter(({ y }) => y > -ROW_HEIGHT && y < height);
  return { pool, viewport, frame, shown, placed, spacer };
}

describe("RowPool", () => {
  test("above the cap, scrolling is scaled and the last row shows", () => {
    const { pool, viewport, frame, placed, spacer } = setup(600);
    const rows = 1_000_000;
    const label = (row: number) => `row ${row}`;
    expect(frame(rows, label)).toBe(true);
    expect(spacer.style.height).toBe(`${SCROLL_CAP}px`);
    expect(placed()[0]).toEqual({ row: 0, y: 0 });

    // The keyboard goes to the last row with the inverse map.
    pool.reveal(rows - 1, rows);
    expect(frame(rows, label)).toBe(true);
    expect(viewport.scrollTop).toBeCloseTo(SCROLL_CAP - 600, 0);
    const last = placed().find(({ row }) => row === rows - 1);
    expect(last?.y).toBeCloseTo(600 - ROW_HEIGHT, 3);

    // The scroll bar in the middle shows the middle rows.
    viewport.scrollTop = (SCROLL_CAP - 600) / 2;
    frame(rows, label);
    const middle = (rows - 600 / ROW_HEIGHT) / 2;
    expect(pool.firstRow(rows)).toBeCloseTo(middle, 3);
    const top = placed().find(({ y }) => y <= 0 && y > -ROW_HEIGHT);
    expect(top?.row).toBe(Math.floor(middle));

    // A wheel event moves by rows, not by the scaled pixels.
    pool.wheel({ deltaY: 10 * ROW_HEIGHT, deltaMode: 0, ctrlKey: false } as WheelEvent, rows);
    frame(rows, label);
    expect(pool.firstRow(rows)).toBeCloseTo(middle + 10, 3);

    // Scroll to an index puts it at the top.
    pool.scrollToRow(123_456, rows);
    frame(rows, label);
    expect(placed().find(({ row }) => row === 123_456)?.y).toBeCloseTo(0, 3);
  });

  test("a shorter list while scrolled down shows no stale row", () => {
    const { viewport, frame, shown } = setup(600);
    const before = (row: number) => `before ${row}`;
    expect(frame(400, before)).toBe(true);
    viewport.scrollTop = 302 * ROW_HEIGHT;
    expect(frame(400, before)).toBe(true);
    // 97 rows go away. The scroll position gets smaller in the render.
    const after = (row: number) => `after ${row}`;
    expect(frame(303, after, true)).toBe(true);
    const rows = shown();
    expect(rows.length).toBeGreaterThan(20);
    for (const { row, label } of rows) {
      expect(label).toBe(after(row));
      expect(row).toBeLessThan(303);
    }
  });

  test("a row without values stays hidden and is filled on the next render", () => {
    const { pool, frame, shown } = setup(240);
    expect(frame(50, (row) => `a ${row}`)).toBe(true);
    pool.invalidate();
    const plan = pool.plan(50, true);
    expect(pool.render(50, plan.start, () => false)).toBe(false);
    expect(shown()).toEqual([]);
    expect(frame(50, (row) => `b ${row}`)).toBe(true);
    const rows = shown();
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every(({ row, label }) => label === `b ${row}`)).toBe(true);
  });
});
