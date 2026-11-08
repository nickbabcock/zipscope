// The walk to the end record (crates/layout/src/end.rs): a stray end signature
// in a comment, a comment that the end of the file cuts, a fake record, and the
// failure at the limit. The rule has its own tests in Rust, and
// `node/end-record.test.ts` checks the findings, the facts and the status of
// each shape with the real workers and wasm. These tests check the note of a
// cut comment and the places on the screen at two widths.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { panelZip } from "./archive-zip";
import {
  ENTRIES,
  firstPlaces,
  withAppendedArchive,
  withDeclaredAfter,
  zip,
} from "./end-record-zip";
import { LISTING_ROWS, openArchive, waitForOutcome } from "./listing";

async function open(page: Page, bytes: Buffer) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const file = test.info().outputPath("end-record.zip");
  writeFileSync(file, bytes);
  await page.goto("/");
  await openArchive(page, file);
  return waitForOutcome(page);
}

async function findingIds(page: Page): Promise<(string | null)[]> {
  await page.locator("#health-toggle").click();
  return page
    .locator("#health-panel [data-finding]")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-finding")));
}

test("a cut comment opens, and the panel shows the bytes that are there", async ({ page }) => {
  const result = await open(page, zip({ comment: Buffer.from("cut comment"), commentLength: 500 }));
  expect(result.outcome, result.status).toBe("complete");
  expect(result.rows).toBe(2);
  expect(await findingIds(page)).toEqual(["comment-cut"]);
  await expect(page.locator('#health-panel [data-finding="comment-cut"]')).toContainText(
    "11 B of 500 B are there",
  );
  await page.locator("#health-toggle").click();
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
  await expect(page.locator("#archive-comment-text")).toHaveText("cut comment");
  await expect(page.locator("#archive-comment-cut")).toHaveText(
    "The file ends inside this comment. It shows 11 B of 500 B.",
  );
});

for (const width of [390, 1440]) {
  test(`a declared offset after the directory shows both places at ${width}`, async ({ page }) => {
    const result = await open(page, withDeclaredAfter(1));
    await page.setViewportSize({ width, height: 900 });
    expect(result.outcome, result.status).toBe("complete");
    expect(result.rows).toBe(2);
    await expect(page.locator("#health-strip")).toHaveAttribute("data-severity", "warning");
    expect(await findingIds(page)).toEqual(["declared-after-directory"]);
    const { directory } = panelZip({ entries: ENTRIES });
    const hex = (value: number) => `0x${value.toString(16).padStart(8, "0")}`;
    await expect(
      page.locator('#health-panel [data-finding="declared-after-directory"]'),
    ).toContainText(
      `The end record declares the central directory at ${hex(directory + 1)}, but the central directory is at ${hex(directory)}, 1 byte before that place.`,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test(`an end record that no entry covers shows its places at ${width}`, async ({ page }) => {
    const result = await open(page, withAppendedArchive());
    await page.setViewportSize({ width, height: 900 });
    expect(result.outcome, result.status).toBe("complete");
    expect(result.rows).toBe(1);
    await expect(page.locator(LISTING_ROWS).first()).toContainText("fake.txt");
    await expect(page.locator("#health-strip")).toHaveAttribute("data-severity", "notice");
    expect(await findingIds(page)).toEqual(["earlier-end-records", "prelude"]);
    const { record, directory } = firstPlaces();
    await expect(page.locator('#health-panel [data-finding="earlier-end-records"]')).toContainText(
      `Before the end record of this listing, this file has another end record at ${record}, with a central directory at ${directory}. By the sizes in the central directory, no entry covers that end record.`,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
