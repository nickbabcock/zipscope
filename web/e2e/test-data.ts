// The places of the generated test data, and the folders that the app must
// show for a list of names. It has no Playwright import, so the vitest tests
// can use it too.
import path from "node:path";

/** The repository root. */
export const root = path.resolve(import.meta.dirname, "../..");
/** Generated archives (`mise run gen:archive`). */
export const archives = path.join(root, "target/archives");
/** The test corpus (`mise run gen:corpus`). */
export const corpus = path.join(root, "target/corpus");

/** The folders of a listing: each folder path (folder names joined with
 *  `/`, "" for the root) with the full names of its entries, sorted. The
 *  order of a listing is not the subject here. */
export type TreeListing = Record<string, string[]>;

/** The most folders in one path. The rest folds into the last folder. */
const MAX_DEPTH = 256;

/**
 * Returns the tree that the app must show for these names, with the rules
 * of crates/core/src/tree.rs: paths split on `/` and `\`, empty segments
 * are ignored, a name that ends with a separator is a folder entry, and a
 * second folder entry for a folder is an entry in that folder. Only
 * folders with entries are in the result.
 */
export function expectedTree(names: string[]): TreeListing {
  const tree: TreeListing = {};
  const explicit = new Set<string>();
  for (const name of names) {
    const segments: [number, number][] = [];
    for (const match of name.matchAll(/[^/\\]+/g)) {
      segments.push([match.index, match.index + match[0].length]);
    }
    const isFolder = segments.length > 0 && /[/\\]$/.test(name);
    let depth = isFolder ? segments.length : Math.max(0, segments.length - 1);
    if (depth > MAX_DEPTH) {
      segments[MAX_DEPTH - 1] = [segments[MAX_DEPTH - 1]![0], segments[depth - 1]![1]];
      depth = MAX_DEPTH;
    }
    const folder = segments
      .slice(0, depth)
      .map(([start, end]) => name.slice(start, end))
      .join("/");
    if (isFolder && !explicit.has(folder)) {
      explicit.add(folder);
      continue;
    }
    (tree[folder] ??= []).push(name);
  }
  for (const entries of Object.values(tree)) entries.sort();
  return tree;
}
