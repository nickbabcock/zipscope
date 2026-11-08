import { describe, expect, test } from "vitest";
import { FOLDER_TAG, NONE, TreeInfo } from "../contracts";
import type { ViewSet } from "../store/reader";
import { crumbsOf } from "./Breadcrumb";

// Folders: 0 root, 1 "p", 2 "src", 3 "main" (chain p/src/main), 4 "x"
// below main, 5 "docs" below the root.
const NAMES = ["", "p", "src", "main", "x", "docs"];
const PARENTS = [NONE, 0, 1, 2, 3, 0];
const folders = {
  folderName: (folder: number) => NAMES[folder]!,
  folderParent: (folder: number) => PARENTS[folder]!,
};

/** Tree rows as [folder, level, chain]. */
function views(rows: [number, number, number][]): ViewSet {
  const tree = new Uint32Array(rows.length * 4);
  rows.forEach(([folder, level, chain], row) => {
    tree[row * 4] = (folder | FOLDER_TAG) >>> 0;
    tree[row * 4 + 1] = level | (chain << TreeInfo.CHAIN_SHIFT);
  });
  return {
    generation: 1,
    set: 0,
    folder: 0,
    permutation: new Uint32Array(),
    info: new Uint32Array(),
    tree,
    treeRows: rows.length,
    treeOrder: 0,
    rollups: new Float64Array(),
    largest: 0,
    sort: 0,
    largestFiles: new Uint32Array(),
  };
}

describe("crumbsOf", () => {
  const set = views([
    [0, 0, 0],
    [3, 1, 2],
    [4, 2, 0],
    [5, 1, 0],
  ]);

  test("gives one segment for each tree row, with compact chains", () => {
    expect(crumbsOf(folders, set, 6, 4, "a.zip")).toEqual([
      { folder: 0, label: "a.zip", root: true },
      { folder: 3, label: "p/src/main", root: false },
      { folder: 4, label: "x", root: false },
    ]);
    expect(crumbsOf(folders, set, 6, 5, "a.zip")?.map((crumb) => crumb.label)).toEqual([
      "a.zip",
      "docs",
    ]);
  });

  test("waits for folders that cannot show yet", () => {
    expect(crumbsOf(folders, set, 4, 4, "a.zip")).toBeUndefined();
  });

  test("gives no segments for a folder without a row", () => {
    expect(crumbsOf(folders, set, 6, 2, "a.zip")).toEqual([]);
  });
});
