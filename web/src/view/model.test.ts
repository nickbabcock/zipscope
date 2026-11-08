import { describe, expect, test } from "vitest";
import { FOLDER_TAG, NONE, TreeInfo } from "../contracts";
import { formatCount, settling } from "../format";
import {
  barWidth,
  hasBar,
  entryLabel,
  folderId,
  isFolder,
  landingFirstRow,
  treeIndexOf,
  treeRow,
  walkChain,
} from "./model";

describe("landingFirstRow", () => {
  /** Tree records of folders 10, 11, 12 and so on, in this order. */
  const words = (folders: number[]) => {
    const out = new Uint32Array(folders.length * 4);
    folders.forEach((folder, index) => {
      out[index * 4] = (folder | FOLDER_TAG) >>> 0;
    });
    return out;
  };
  const tree = words([10, 13, 11, 14, 12, 15]);

  test("the selected row keeps its place", () => {
    expect(
      landingFirstRow(tree, 6, {
        selected: { folder: 12, rowsFromTop: 2.5 },
        top: { folder: 10, rowsFromTop: 0 },
      }),
    ).toBe(1.5);
  });

  test("the row of a move comes before the selected row", () => {
    expect(
      landingFirstRow(tree, 6, {
        moving: { folder: 15, rowsFromTop: 3 },
        selected: { folder: 12, rowsFromTop: 2 },
        top: { folder: 10, rowsFromTop: 0 },
      }),
    ).toBe(2);
  });

  test("with no selected row in view, the top row stays at the top", () => {
    expect(landingFirstRow(tree, 6, { top: { folder: 14, rowsFromTop: -0.25 } })).toBe(3.25);
  });

  test("a row that is not in the new tree gives way to the next one", () => {
    expect(
      landingFirstRow(tree, 6, {
        moving: { folder: 99, rowsFromTop: 1 },
        selected: { folder: 98, rowsFromTop: 1 },
        top: { folder: 13, rowsFromTop: 0 },
      }),
    ).toBe(1);
    expect(landingFirstRow(tree, 6, { top: { folder: 99, rowsFromTop: 0 } })).toBeUndefined();
  });
});

describe("entryLabel", () => {
  test("shows the last segment", () => {
    expect(entryLabel("a/b/c.txt")).toBe("c.txt");
    expect(entryLabel("a\\b\\c.txt")).toBe("c.txt");
    expect(entryLabel("top")).toBe("top");
    expect(entryLabel("a//b//")).toBe("b/");
  });

  test("shows a name without segments as it is", () => {
    expect(entryLabel("")).toBe("");
    expect(entryLabel("/")).toBe("/");
    expect(entryLabel("\\\\")).toBe("\\\\");
  });
});

describe("tagged indexes", () => {
  test("bit 31 marks a folder id", () => {
    const tagged = (FOLDER_TAG | 7) >>> 0;
    expect(isFolder(tagged)).toBe(true);
    expect(folderId(tagged)).toBe(7);
    expect(isFolder(7)).toBe(false);
    expect(isFolder(0x7fffffff)).toBe(false);
  });
});

describe("treeRow", () => {
  test("decodes a record", () => {
    const info =
      (3 | (2 << TreeInfo.CHAIN_SHIFT) | TreeInfo.HAS_CHILDREN | TreeInfo.EXPANDED) >>> 0;
    const words = new Uint32Array([FOLDER_TAG, 0, 1, 1, (FOLDER_TAG | 9) >>> 0, info, 4, 5]);
    expect(treeRow(words, 1)).toEqual({
      folder: 9,
      level: 3,
      chain: 2,
      hasChildren: true,
      expanded: true,
      position: 4,
      size: 5,
    });
    expect(treeRow(words, 0)).toMatchObject({ folder: 0, level: 0, expanded: false });
  });

  test("a row without children is not expanded", () => {
    const words = new Uint32Array([1, TreeInfo.EXPANDED, 1, 1]);
    expect(treeRow(words, 0).expanded).toBe(false);
  });
});

describe("treeIndexOf", () => {
  test("finds the row of a folder from word 0 only", () => {
    const words = new Uint32Array([
      FOLDER_TAG,
      0,
      1,
      1,
      (FOLDER_TAG | 4) >>> 0,
      1,
      1,
      2,
      (FOLDER_TAG | 9) >>> 0,
      TreeInfo.HAS_CHILDREN,
      2,
      2,
    ]);
    expect(treeIndexOf(words, 3, 9)).toBe(2);
    expect(treeIndexOf(words, 3, 0)).toBe(0);
    // Only the first `rows` records count.
    expect(treeIndexOf(words, 2, 9)).toBe(-1);
    expect(treeIndexOf(words, 3, 5)).toBe(-1);
  });
});

describe("walkChain", () => {
  // 0 root, 1 a, 2 b, 3 c: a/b/c.
  const names = ["", "a", "b", "c"];
  const parents = [NONE, 0, 1, 2];
  const folders = {
    folderName: (folder: number) => names[folder]!,
    folderParent: (folder: number) => parents[folder]!,
  };

  test("walks a fixed number of steps", () => {
    expect(walkChain(folders, 3, { steps: 1 })).toEqual({ head: 2, names: ["b", "c"] });
    expect(walkChain(folders, 3, { steps: 0 })).toEqual({ head: 3, names: ["c"] });
  });

  test("walks to a stop folder or the root", () => {
    expect(walkChain(folders, 3, { stop: 1 })).toEqual({ head: 2, names: ["b", "c"] });
    expect(walkChain(folders, 3, { stop: 0 })).toEqual({ head: 1, names: ["a", "b", "c"] });
  });

  test("a cycle from a torn read ends", () => {
    const cycle = {
      folderName: () => "x",
      folderParent: (folder: number) => (folder === 1 ? 2 : 1),
    };
    expect(walkChain(cycle, 1, { stop: 0, limit: 5 }).names).toHaveLength(5);
  });
});

describe("size bars and settling values", () => {
  test("bar widths", () => {
    expect(barWidth(0, 10)).toBe(0);
    expect(barWidth(5, 0)).toBe(0);
    expect(barWidth(5, 10)).toBe(50);
    expect(barWidth(20, 10)).toBe(100);
    expect(barWidth(Number.NaN, 10)).toBe(0);
  });

  test("a share draws a bar only when the bar has 3 px", () => {
    expect(hasBar(10, 100, 48)).toBe(true);
    expect(hasBar(6, 100, 48)).toBe(false);
    expect(hasBar(10, 100, 28)).toBe(false);
    expect(hasBar(5, 0, 48)).toBe(false);
    expect(hasBar(Number.NaN, 100, 48)).toBe(false);
  });

  test("settling values show ≥", () => {
    expect(settling("1.0 KiB", true)).toBe("≥ 1.0 KiB");
    expect(settling("1.0 KiB", false)).toBe("1.0 KiB");
    expect(formatCount(1)).toBe("1 entry");
    expect(formatCount(1204)).toBe("1,204 entries");
  });
});
