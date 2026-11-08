import { describe, expect, test } from "vitest";
import {
  COARSE_ROW_HEIGHT,
  FINE_ROW_HEIGHT,
  firstToReveal,
  ROW_HEIGHT,
  rowAtScroll,
  rowHeight,
  SCROLL_CAP,
  scrollForRow,
  scrollGeometry,
  wheelRows,
} from "./scroll";

test("a coarse pointer gets taller rows, and a fine pointer keeps 24 px", () => {
  expect(rowHeight(false)).toBe(24);
  expect(rowHeight(true)).toBe(36);
  // The unit tests run in Node, with no pointer: the dense rows.
  expect(ROW_HEIGHT).toBe(FINE_ROW_HEIGHT);
});

describe("scroll geometry", () => {
  test("below the cap, scrolling is native", () => {
    const geometry = scrollGeometry(1000, 500, 28, ROW_HEIGHT);
    expect(geometry.scaled).toBe(false);
    expect(geometry.spacer).toBe(1000 * ROW_HEIGHT);
    expect(geometry.maxScroll).toBe(28 + 24_000 - 500);
    expect(rowAtScroll(geometry, 240)).toBe(10);
    expect(scrollForRow(geometry, 10)).toBe(240);
  });

  test("above the cap, the spacer has a fixed height", () => {
    const most = Math.floor(SCROLL_CAP / ROW_HEIGHT);
    expect(scrollGeometry(most, 500, 0, ROW_HEIGHT).scaled).toBe(false);
    const geometry = scrollGeometry(most + 1, 500, 0, ROW_HEIGHT);
    expect(geometry.scaled).toBe(true);
    expect(geometry.spacer).toBe(SCROLL_CAP);
  });

  test("the map is proportional", () => {
    const rows = 40_000_000;
    const geometry = scrollGeometry(rows, 528, 28, ROW_HEIGHT);
    const visible = 500 / ROW_HEIGHT;
    expect(geometry.maxFirst).toBeCloseTo(rows - visible, 6);
    expect(rowAtScroll(geometry, 0)).toBe(0);
    expect(rowAtScroll(geometry, geometry.maxScroll)).toBeCloseTo(rows - visible, 6);
    expect(rowAtScroll(geometry, geometry.maxScroll / 2)).toBeCloseTo((rows - visible) / 2, 6);
    // A scroll position past the end shows the last rows.
    expect(rowAtScroll(geometry, geometry.maxScroll * 2)).toBeCloseTo(rows - visible, 6);
  });

  test("the inverse map returns the same row", () => {
    for (const [rows, height] of [10, 400_000, 40_000_000, 4_000_000_000].flatMap((rows) => [
      [rows, FINE_ROW_HEIGHT],
      [rows, COARSE_ROW_HEIGHT],
    ])) {
      const geometry = scrollGeometry(rows!, 700, 28, height!);
      for (const fraction of [0, 0.001, 0.25, 0.5, 0.999, 1]) {
        const first = geometry.maxFirst * fraction;
        const top = scrollForRow(geometry, first);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top).toBeLessThanOrEqual(geometry.maxScroll);
        expect(rowAtScroll(geometry, top)).toBeCloseTo(first, 3);
      }
    }
  });

  test("the inverse map clamps rows outside the listing", () => {
    const geometry = scrollGeometry(40_000_000, 700, 28, ROW_HEIGHT);
    expect(scrollForRow(geometry, -5)).toBe(0);
    expect(scrollForRow(geometry, 50_000_000)).toBe(geometry.maxScroll);
  });

  test("coarse rows map the scroll position with their own height", () => {
    const geometry = scrollGeometry(1000, 500, 28, COARSE_ROW_HEIGHT);
    expect(geometry.scaled).toBe(false);
    expect(geometry.spacer).toBe(36_000);
    expect(geometry.maxScroll).toBe(28 + 36_000 - 500);
    expect(geometry.maxFirst).toBeCloseTo(1000 - 472 / 36, 6);
    expect(rowAtScroll(geometry, 360)).toBe(10);
    expect(scrollForRow(geometry, 10)).toBe(360);
    // The cap comes at fewer rows.
    const most = Math.floor(SCROLL_CAP / COARSE_ROW_HEIGHT);
    expect(scrollGeometry(most, 500, 0, COARSE_ROW_HEIGHT).scaled).toBe(false);
    expect(scrollGeometry(most + 1, 500, 0, COARSE_ROW_HEIGHT).scaled).toBe(true);
  });

  test("a short listing does not scroll", () => {
    const geometry = scrollGeometry(3, 700, 28, ROW_HEIGHT);
    expect(geometry.maxScroll).toBe(0);
    expect(geometry.maxFirst).toBe(0);
    expect(rowAtScroll(geometry, 100)).toBe(0);
    expect(scrollForRow(geometry, 2)).toBe(0);
  });
});

test("reveal moves the least", () => {
  expect(firstToReveal(10, 12, 20)).toBe(10);
  expect(firstToReveal(10, 5, 20)).toBe(5);
  expect(firstToReveal(10, 30, 20)).toBe(11);
  expect(firstToReveal(10.5, 30, 20.5)).toBe(10.5);
});

test("wheel deltas move by rows", () => {
  expect(wheelRows({ deltaY: 48, deltaMode: 0 }, 20, FINE_ROW_HEIGHT)).toBe(2);
  expect(wheelRows({ deltaY: 72, deltaMode: 0 }, 20, COARSE_ROW_HEIGHT)).toBe(2);
  expect(wheelRows({ deltaY: -3, deltaMode: 1 }, 20, COARSE_ROW_HEIGHT)).toBe(-3);
  expect(wheelRows({ deltaY: 1, deltaMode: 2 }, 20.5, COARSE_ROW_HEIGHT)).toBe(20);
});
