// The Node half of the differential test: the listing of each corpus file
// must be the rawzip listing in `expected.json` (see
// crates/testkit/tests/differential.rs). The corpus has the rawzip assets,
// a mixed archive and a sparse zip64 archive with entries past 4 GiB
// (`mise run gen:corpus` writes it).
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { corpus, expectedTree } from "../e2e/test-data";
import { FOLDER_TAG } from "../src/contracts";
import { phaseText } from "../src/shell/phase";
import { test } from "./fixtures";
import type { Archive } from "./fixtures";

/** Each folder path ("" for the root) with the sorted names of the entries
 *  that its listing shows, as `expectedTree` gives them. Only folders with
 *  entries are in the result. */
async function folderListings({ reader, parse }: Archive): Promise<Record<string, string[]>> {
  const tree: Record<string, string[]> = {};
  for (let folder = 0; folder < reader.visibleFolders(); folder++) {
    await parse.list(folder);
    const entries = [...reader.views()!.permutation]
      .filter((value) => (value & FOLDER_TAG) === 0)
      .map((row) => reader.name(row));
    const path: string[] = [];
    for (let at = folder; at !== 0; at = reader.folderParent(at))
      path.unshift(reader.folderName(at));
    if (entries.length > 0) tree[path.join("/")] = entries.sort();
  }
  return tree;
}

interface Expected {
  file: string;
  outcome: "complete" | "failed" | "not-zip";
  message: string | null;
  names: string[];
}

const { files } = JSON.parse(readFileSync(path.join(corpus, "expected.json"), "utf8")) as {
  files: Expected[];
};

for (const expected of files) {
  test(`lists ${expected.file}`, async ({ open }) => {
    const archive = await open(path.join(corpus, expected.file));
    const { outcome } = archive;
    const status = outcome.kind === "complete" ? "complete" : phaseText(outcome);
    expect(archive.rows, status).toBe(expected.names.length);
    if (expected.outcome === "complete") {
      expect(outcome.kind, status).toBe("complete");
    } else {
      expect(outcome.kind, status).toBe("failed");
      expect(status).toMatch(expected.names.length === 0 ? /Cannot open/ : /Stopped after/);
    }
    if (expected.names.length > 0) {
      expect(await folderListings(archive)).toEqual(expectedTree(expected.names));
    }
  });
}
