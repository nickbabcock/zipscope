// The design rules that change what a user can reach:
// the "…" menu of the location, the columns with no value, the lock of an
// encrypted entry at 390 px and the next action of an empty listing.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { contentZip } from "./content-zip";
import { openArchive, waitForOutcome, LISTING_ROWS } from "./listing";
import { storedZip } from "./stored-zip";

async function open(page: Page, width: number, file: string, bytes: Buffer) {
  await page.setViewportSize({ width, height: 800 });
  const path = test.info().outputPath(file);
  writeFileSync(path, bytes);
  await page.goto("/");
  await openArchive(page, path);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
}

const row = (page: Page, label: string) =>
  page
    .locator(LISTING_ROWS)
    .filter({ has: page.locator('[data-part="label"]', { hasText: label }) })
    .first();

test("the middle of a long location goes into a menu that navigates", async ({ page }) => {
  await open(
    page,
    390,
    "deep.zip",
    storedZip([
      ["first-folder-with-a-long-name/x.txt", 1],
      ["first-folder-with-a-long-name/second-folder-with-a-long-name/y.txt", 2],
      ["first-folder-with-a-long-name/second-folder-with-a-long-name/third-long-name/z.txt", 3],
      ["other.txt", 4],
    ]),
  );
  await row(page, "first-").click();
  await row(page, "second-").click();
  await row(page, "third-").click();
  const more = page.locator("#location-more");
  await expect(more).toBeVisible();
  const box = await more.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(24);
  expect(box!.height).toBeGreaterThanOrEqual(24);
  // The current folder stays whole.
  await expect(page.locator('#location [aria-current="location"]')).toHaveText("third-long-name");
  await more.click();
  const menu = page.locator("#location-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: "first-folder-with-a-long-name" }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#location [aria-current="location"]')).toHaveText(
    "first-folder-with-a-long-name",
  );
  await expect(row(page, "second-")).toBeVisible();
});

test("a long compact chain keeps its last folder in the tree and the location", async ({
  page,
}) => {
  const chain = "archive-demo-store/module-with-a-long-name-000/component-00";
  await open(
    page,
    390,
    "chain.zip",
    storedZip([
      [`${chain}/x.txt`, 1],
      ["other.txt", 2],
    ]),
  );
  await row(page, "component-00").click();
  const current = page.locator('#location [aria-current="location"]');
  await expect(current).toHaveAttribute("title", chain);
  await expect(current).toHaveText(/^…\/.*component-00$/);
  await page.locator("#drawer-button").click();
  const name = page.locator("#tree-viewport [role=treeitem] [data-part=label]").nth(1);
  await expect(name).toHaveAttribute("title", chain);
  await expect(name).toHaveText(/^…\/.*component-00$/);
  // The row with the long name has no bar, so the name has the room.
  await expect(
    page.locator("#tree-viewport [role=treeitem]").nth(1).locator("[hidden]"),
  ).toHaveCount(1);
});

test("a listing of folders has no Method and no Modified column", async ({ page }) => {
  await open(
    page,
    1440,
    "folders.zip",
    storedZip([
      ["a/x.txt", 1],
      ["b/y.txt", 2],
    ]),
  );
  // A low window has no room for the largest files, which are file rows.
  await page.setViewportSize({ width: 1440, height: 360 });
  // The default sort adds an arrow to Size.
  const headers = async () =>
    (await page.locator("[role=columnheader]:not([hidden])").allTextContents()).map((text) =>
      text.replace(/[↑↓]$/, ""),
    );
  // The count of a folder has a column.
  await expect.poll(headers).toEqual(["Name", "Size", "Compressed", "Ratio", "Entries"]);
  await row(page, "a/").click();
  // No listed row has a time, so Modified goes.
  await expect.poll(headers).toEqual(["Name", "Size", "Compressed", "Ratio", "Method"]);
});

test("an encrypted entry has a named lock at all widths", async ({ page }) => {
  // Bit 0 of the flags is in the central header at offset 8.
  const bytes = contentZip([
    { name: "secret.txt", data: Buffer.from("secret"), method: 0 },
    { name: "plain.txt", data: Buffer.from("plain"), method: 0 },
  ]);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
  bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 1, central + 8);
  await open(page, 390, "locked.zip", bytes);
  await expect(row(page, "secret.txt").locator('[data-part="lock"]')).toHaveAttribute(
    "aria-label",
    "Encrypted",
  );
  await expect(row(page, "secret.txt").locator('[data-part="lock"]')).toBeVisible();
  await expect(row(page, "plain.txt").locator('[data-part="lock"]')).toBeHidden();
  // One rule: it does not change with the width.
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(page.locator('[data-column="method"]')).toBeVisible();
  await expect(row(page, "secret.txt").locator('[data-part="lock"]')).toBeVisible();
});

test("an empty folder has no header and a way up", async ({ page }) => {
  await open(page, 1440, "assets.zip", storedZip([["assets/", 0]]));
  await expect(page.locator("#folder-empty")).toBeVisible();
  await expect(page.locator("[role=columnheader]").first()).toBeHidden();
  await page.locator("#folder-empty-up").click();
  await expect(row(page, "assets/")).toBeVisible();
  await expect(page.locator("[role=columnheader]").first()).toBeVisible();
});

test("a share too small for a true bar draws none, and its name gets the slot", async ({
  page,
}) => {
  const long = `${"long-name-".repeat(5)}end.bin`;
  await open(
    page,
    1440,
    "shares.zip",
    storedZip([
      ["large.bin", 9000],
      [long, 100],
    ]),
  );
  const fill = (label: string) =>
    row(page, label)
      .locator('[data-cell="size"] span span')
      .first()
      .evaluate((node) => (node as HTMLElement).style.width);
  await expect.poll(() => fill("large.bin")).not.toBe("0%");
  await expect.poll(() => fill("long-name-")).toBe("0%");
  // The name goes past the name column, into the slot, and stays whole.
  await expect(row(page, "long-name-").locator('[data-part="label"]')).toHaveText(long);
  // A view where no row stands out has no bars.
  await page.goto("/");
  const equal = test.info().outputPath("equal.zip");
  writeFileSync(
    equal,
    storedZip(Array.from({ length: 30 }, (_, index) => [`f${index}.bin`, 100] as [string, number])),
  );
  await openArchive(page, equal);
  await expect.poll(() => fill("f0.bin")).toBe("0%");
});

test("a group of siblings in the tree has bars as one", async ({ page }) => {
  await open(
    page,
    1440,
    "siblings.zip",
    storedZip([
      ["big/x.bin", 5000],
      [`${"a-very-long-folder-name-".repeat(3)}/y.bin`, 5000],
      ["other/z.bin", 1],
    ]),
  );
  const bars = page.locator("#tree-viewport [role=treeitem]:not([hidden]) [hidden]");
  // Each row of the group has its bar slot empty, also the row with a short name.
  await expect(page.locator("#tree-viewport [role=treeitem]:not([hidden])")).toHaveCount(4);
  await expect(bars).toHaveCount(4);
});

test("after the pointer a new listing has no selected row, and after the keys it has", async ({
  page,
}) => {
  await open(
    page,
    1440,
    "cursor.zip",
    storedZip([
      ["a/x.txt", 1],
      ["b/y.txt", 2],
    ]),
  );
  await row(page, "a/").click();
  await expect(row(page, "x.txt")).toBeVisible();
  await expect(page.locator('#list-viewport [aria-selected="true"]')).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await expect(row(page, "a/")).toBeVisible();
  await expect(page.locator('#list-viewport [aria-selected="true"]')).toHaveCount(1);
});
