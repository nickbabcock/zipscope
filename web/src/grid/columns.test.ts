import { describe, expect, test } from "vitest";
import {
  fitColumns,
  gridTemplate,
  HIDDEN_WHEN_NARROW,
  HIDDEN_WITH_PREVIEW,
  OPTIONAL_COLUMNS,
  TABLE_FLOOR,
  tableMinWidth,
  toggleColumn,
} from "./columns";

describe("table columns", () => {
  test("all columns show by default", () => {
    expect(gridTemplate(new Set())).toBe(
      "minmax(0, var(--name-cap, 400px)) 124px 88px 56px 56px 132px 120px",
    );
  });

  test("Compressed and Method hide while the preview is open", () => {
    expect([...HIDDEN_WITH_PREVIEW].sort()).toEqual(["compressed", "method"]);
    expect(gridTemplate(HIDDEN_WITH_PREVIEW)).toBe(
      "minmax(0, var(--name-cap, 400px)) 124px 56px 56px 120px",
    );
  });

  test("the narrow layout keeps the name and the size", () => {
    expect(gridTemplate(HIDDEN_WHEN_NARROW)).toBe("minmax(0, var(--name-cap, 400px)) 124px");
    expect(gridTemplate(HIDDEN_WHEN_NARROW, 32)).toBe("minmax(0, var(--name-cap, 400px)) 108px");
  });

  test("the picker shows and hides columns, but not the name", () => {
    expect(OPTIONAL_COLUMNS).not.toContain("name");
    const shown = toggleColumn(HIDDEN_WITH_PREVIEW, "method", true);
    expect([...shown]).toEqual(["compressed"]);
    expect([...toggleColumn(shown, "ratio", false)].sort()).toEqual(["compressed", "ratio"]);
    expect(toggleColumn(new Set(), "name", false).size).toBe(0);
    // The input does not change.
    expect(HIDDEN_WITH_PREVIEW.size).toBe(2);
  });

  test("the least table width keeps room for names", () => {
    // 200 + 124 + 88 + 56 + 56 + 132 + 120, 6 gaps of 16, 2 × 12 padding.
    expect(tableMinWidth(new Set())).toBe(896);
    expect(tableMinWidth(HIDDEN_WITH_PREVIEW)).toBe(644);
    expect(tableMinWidth(HIDDEN_WHEN_NARROW)).toBe(364);
    expect(TABLE_FLOOR).toBe(312);
  });

  test("columns that do not fit hide in a fixed order", () => {
    const none = new Set<never>();
    expect(fitColumns(none, 896)).toBe(none);
    // First Entries and the bar, then Modified, and the base name keeps its
    // room.
    expect([...fitColumns(none, 840)]).toEqual(["entries"]);
    expect([...fitColumns(none, 780)].sort()).toEqual(["bar", "entries"]);
    expect([...fitColumns(none, 700)].sort()).toEqual(["bar", "entries", "modified"]);
    expect([...fitColumns(none, 630)].sort()).toEqual(["bar", "entries", "modified", "ratio"]);
    expect([...fitColumns(HIDDEN_WHEN_NARROW, 300)].sort()).toEqual([
      "bar",
      "compressed",
      "entries",
      "method",
      "modified",
      "ratio",
      "size",
    ]);
  });

  test("the size column without its bar has only the text", () => {
    expect(
      gridTemplate(new Set(["bar", "entries", "compressed", "ratio", "method", "modified"])),
    ).toBe("minmax(0, var(--name-cap, 400px)) 72px");
  });
});
