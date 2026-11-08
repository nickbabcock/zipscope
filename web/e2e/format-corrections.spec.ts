// What a person sees for two format rules: an entry count that wrapped at
// 65,536 and a local header in the range of another entry. Rust tests have the
// boundaries of the rules, and `node/format-corrections.test.ts` checks the
// findings and the facts of each shape with the real workers and wasm. These
// tests check the status bar during the parse, the health marks of the rows
// and the plain sentence of the byte map in the real app.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { holdFinished } from "./hold";
import { openArchive, root, waitForOutcome } from "./listing";
import { countZip, placedZip } from "./placed-zip";

async function open(page: Page, bytes: Buffer): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const file = test.info().outputPath("format.zip");
  writeFileSync(file, bytes);
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
}

async function findingIds(page: Page): Promise<(string | null)[]> {
  await page.locator("#health-toggle").click();
  const panel = page.locator("#health-panel");
  await expect(panel).toBeVisible();
  return panel
    .locator("[data-finding]")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-finding")));
}

/** The health mark of the row with this name. */
function mark(page: Page, name: string) {
  return page
    .locator(`#list-viewport [data-row]:has([data-part="label"]:text-is("${name}"))`)
    .locator('[data-part="mark"]');
}

/** Selects the root of the tree, so that the Archive panel shows. */
async function archivePanel(page: Page): Promise<void> {
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
  await expect(page.locator('#archive-format [data-fact="entries"] dd')).toBeVisible();
}

test("the status bar gives no estimate below the rows while the parse ends", async ({ page }) => {
  await page.addInitScript(holdFinished);
  const file = test.info().outputPath("format.zip");
  writeFileSync(file, countZip(65_539, 3));
  await page.goto("/");
  await openArchive(page, file);
  await expect(page.locator("#row-count")).toHaveText("65,539");
  await expect(page.locator("#entries-listed")).toHaveAttribute("title", "65,539 entries listed");
});

test("data that runs past the next local header of a row with data is an error", async ({
  page,
}) => {
  // The header of a.bin and its 40 bytes end at 70, past the header of b.bin at
  // 40. The size alone only touches b.bin.
  await open(
    page,
    placedZip(
      [
        { name: "a.bin", at: 0, size: 40 },
        { name: "b.bin", at: 40, size: 10 },
      ],
      200,
    ),
  );
  await expect(page.locator("#health-strip")).toHaveAttribute("data-severity", "error");
  expect(await findingIds(page)).toContain("overlaps");
  const finding = page.locator('#health-panel [data-finding="overlaps"]');
  await expect(finding).toContainText("2 entries have bytes that overlap other entries.");
  await expect(finding).toContainText("An overlapping-file zip bomb has this shape.");
  await expect(finding).toContainText("For example: a.bin");
  await expect(mark(page, "a.bin")).toHaveAttribute("aria-label", /bytes overlap another entry/);
  await expect(mark(page, "a.bin")).toHaveAttribute("data-severity", "error");
});

test("the real output of a writer with an alias of an empty file is a warning", async ({
  page,
}) => {
  // The Rust `zip` crate 9.4.0 made this file with `shallow_copy_file`.
  await open(
    page,
    readFileSync(path.join(root, "fuzz/corpus/ingest/regression-zip-crate-alias-empty.zip")),
  );
  await expect(page.locator("#health-strip")).toHaveAttribute("data-severity", "warning");
  expect(await findingIds(page)).toEqual(["overlap-no-data"]);
  const panel = page.locator("#health-panel");
  await expect(panel.locator('[data-finding="overlap-no-data"]')).toContainText(
    "2 entries are at places that overlap other entries. Each overlap has an entry with no data.",
  );
  await expect(panel).not.toContainText("zip bomb");
  await expect(mark(page, "empty.txt")).toHaveAttribute(
    "aria-label",
    /place overlaps another entry/,
  );
  await expect(mark(page, "alias.txt")).toHaveAttribute("data-severity", "warning");
  await expect(mark(page, "real.txt")).toBeHidden();
});

test("the plain sentence of the map does not deny an overlap in the health list", async ({
  page,
}) => {
  // Two empty rows point to the same place past the end of the file, so the map
  // counts no bytes for them.
  const file = placedZip([{ name: "real.txt", at: 0 }], 30);
  const records = file.subarray(30, file.length - 22);
  const alias = (name: string): Buffer => {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(1_000_000, 42);
    return Buffer.concat([record, Buffer.from(name)]);
  };
  const directory = Buffer.concat([records, alias("one"), alias("two")]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(3, 8);
  end.writeUInt16LE(3, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(30, 16);
  await open(page, Buffer.concat([file.subarray(0, 30), directory, end]));
  expect(await findingIds(page)).toEqual(["overlap-no-data"]);
  await page.locator("#health-toggle").click();
  await archivePanel(page);
  await expect(page.locator("#archive-map")).toContainText("entries point into or past");
  const plain = page.locator("#byte-map-plain");
  await expect(plain).toContainText("There is no prelude, gap or epilogue.");
  await expect(plain).not.toContainText("overlaps");
});
