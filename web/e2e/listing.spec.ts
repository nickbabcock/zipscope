// Opens a generated archive in the app, checks that it lands at the end of
// the root chain, and checks every name in the tree and the table.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { archives, collectTree, expectedTree, openArchive, waitForOutcome } from "./listing";

test("lists every name of a generated archive in its folder", async ({ page }) => {
  const file = path.join(archives, "2000.zip");
  const expected = readFileSync(`${file}.names.txt`, "utf8").split("\n").slice(0, -1);
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  expect(result.rows).toBe(expected.length);
  const listed = await collectTree(page);
  // The generated names are project-1.2.0/src/module-…/component-…/file.
  expect(listed.landing).toBe("project-1.2.0/src");
  expect(listed.folders).toEqual(expectedTree(expected));
});
