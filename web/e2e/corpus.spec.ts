// The browser half of the differential test: the listing in the app must
// be the rawzip listing in `expected.json` (see
// crates/testkit/tests/differential.rs). `node/corpus.test.ts` checks each
// corpus file with the real workers and wasm in Node. Here the built app
// lists the mixed archive and the sparse zip64 archive with entries past
// 4 GiB, and the tree view shows their folders.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { collectTree, corpus, expectedTree, openArchive, waitForOutcome } from "./listing";

interface Expected {
  file: string;
  outcome: "complete" | "failed" | "not-zip";
  message: string | null;
  names: string[];
}

const { files } = JSON.parse(readFileSync(path.join(corpus, "expected.json"), "utf8")) as {
  files: Expected[];
};
const PAGE_FILES = ["generated/mixed.zip", "generated/zip64-sparse.zip"];

for (const expected of files.filter((file) => PAGE_FILES.includes(file.file))) {
  test(`lists ${expected.file}`, async ({ page }) => {
    await page.goto("/");
    await openArchive(page, path.join(corpus, expected.file));
    const result = await waitForOutcome(page);
    expect(result.rows, result.status).toBe(expected.names.length);
    if (expected.outcome === "complete") {
      expect(result.outcome, result.status).toBe("complete");
    } else {
      expect(result.outcome, result.status).toBe("failed");
      expect(result.status).toMatch(expected.names.length === 0 ? /Cannot open/ : /Stopped after/);
    }
    if (expected.names.length > 0) {
      expect((await collectTree(page)).folders).toEqual(expectedTree(expected.names));
    }
  });
}
