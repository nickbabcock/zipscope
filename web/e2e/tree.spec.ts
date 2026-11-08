// The folder tree and the table of the listed folder: landing, compact
// chains, expand and collapse, the keyboard, size bars and settled values.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openArchive, waitForOutcome, LISTING_ROWS } from "./listing";
import { storedZip } from "./stored-zip";

async function open(page: Page, entries: [string, number][]) {
  const file = test.info().outputPath("tree.zip");
  writeFileSync(file, storedZip(entries));
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
}

const treeRows = (page: Page) => page.locator("#tree-viewport [role=treeitem]:not([hidden])");
const tableRows = (page: Page) => page.locator(LISTING_ROWS);
const labels = (rows: ReturnType<Page["locator"]>) =>
  rows.locator('[data-part="label"]').allTextContents();

test("lands at the root when it has more than one child, with rolled-up sizes", async ({
  page,
}) => {
  await open(page, [
    ["big/a.bin", 3000],
    ["big/b.bin", 1000],
    ["small/deep/c.txt", 500],
    ["root.txt", 100],
  ]);
  await expect(treeRows(page)).toHaveCount(3);
  expect(await labels(treeRows(page))).toEqual(["tree.zip", "big", "small/deep"]);
  expect(await labels(tableRows(page))).toEqual(["big/", "small/deep/", "root.txt"]);
  const root = treeRows(page).nth(0);
  await expect(root).toHaveAttribute("aria-selected", "true");
  await expect(root).toHaveAttribute("aria-level", "1");
  await expect(root).toContainText("4.5 KiB");
  // Settled values have no ≥.
  await expect(page.locator("#tree-viewport")).not.toContainText("≥");
  await expect(page.locator("#list-viewport")).not.toContainText("≥");
  // Tree bars are the share of the parent. Table bars are the share of the listed folder too.
  const big = treeRows(page).nth(1);
  await expect(big).toHaveAttribute("aria-posinset", "1");
  await expect(big).toHaveAttribute("aria-setsize", "2");
  await expect(big.locator("[aria-hidden=true][title]")).toHaveAttribute(
    "title",
    "87% of the parent folder",
  );
  const widths = await tableRows(page).evaluateAll((rows) =>
    rows.map(
      (row) => (row.querySelector('[data-cell="size"] span span') as HTMLElement).style.width,
    ),
  );
  // A share too small for 3 px draws no bar, and
  // the count of a folder has a column.
  expect(widths).toEqual(["86.9565%", "10.8696%", "0%"]);
  await expect(tableRows(page).nth(0).locator('[data-cell="entries"]')).toHaveText("2");
});

test("selects, expands and collapses with the mouse and the keyboard", async ({ page }) => {
  await open(page, [
    ["a/one/x", 1],
    ["a/two/y", 1],
    ["b/z", 1],
  ]);
  expect(await labels(treeRows(page))).toEqual(["tree.zip", "a", "b"]);
  const tree = page.locator("#tree-viewport");
  await expect(tree).toHaveAttribute("role", "tree");

  // The toggle expands without a selection change.
  await treeRows(page).nth(1).locator('[data-part="toggle"]').click();
  await expect(treeRows(page)).toHaveCount(5);
  await expect(treeRows(page).nth(1)).toHaveAttribute("aria-expanded", "true");
  await expect(treeRows(page).nth(0)).toHaveAttribute("aria-selected", "true");

  // Arrow keys move the selection, and the table follows it.
  await tree.focus();
  await page.keyboard.press("ArrowDown");
  await expect(treeRows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => labels(tableRows(page))).toEqual(["one/", "two/"]);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => labels(tableRows(page))).toEqual(["x"]);
  const active = await tree.getAttribute("aria-activedescendant");
  await expect(page.locator(`#${active}`)).toHaveAttribute("aria-level", "3");

  // Left goes to the parent row, then collapses it.
  await page.keyboard.press("ArrowLeft");
  await expect(treeRows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(treeRows(page).nth(1)).toHaveAttribute("aria-expanded", "false");
  // No row of the collapsed folder stays on the screen.
  await expect(treeRows(page)).toHaveCount(3);
  expect(await labels(treeRows(page))).toEqual(["tree.zip", "a", "b"]);
  await page.keyboard.press("ArrowRight");
  await expect(treeRows(page)).toHaveCount(5);

  // A click on a row selects it.
  await treeRows(page).nth(4).locator('[data-part="label"]').click();
  await expect.poll(() => labels(tableRows(page))).toEqual(["z"]);
});

test("compact chains show as one row, and a folder entry keeps its folder", async ({ page }) => {
  await open(page, [
    ["p/", 0],
    ["p/src/main/", 0],
    ["p/src/main/a.rs", 10],
    ["p/src/main/b.rs", 20],
  ]);
  // Lands at the end of the root chain.
  expect(await labels(treeRows(page))).toEqual(["tree.zip", "p/src/main"]);
  await expect(treeRows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  // The largest first.
  expect(await labels(tableRows(page))).toEqual(["b.rs", "a.rs"]);
});

test("collapsing a row above the selected folder selects that row", async ({ page }) => {
  await open(page, [
    ["a/one/x", 1],
    ["a/two/y", 1],
    ["b/z", 1],
  ]);
  const tree = page.locator("#tree-viewport");
  await treeRows(page).nth(1).locator('[data-part="toggle"]').click();
  await treeRows(page).nth(2).locator('[data-part="label"]').click();
  await expect.poll(() => labels(tableRows(page))).toEqual(["x"]);
  // Collapse `a`: the row of `a/one` hides, so `a` is selected.
  await treeRows(page).nth(1).locator('[data-part="toggle"]').click();
  await expect(treeRows(page)).toHaveCount(3);
  await expect(treeRows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => labels(tableRows(page))).toEqual(["one/", "two/"]);
  const active = await tree.getAttribute("aria-activedescendant");
  await expect(page.locator(`#${active}`)).toHaveAttribute("data-folder", /\d+/);
  await expect(page.locator(`#${active} [data-part="label"]`)).toHaveText("a");
  // The keyboard continues from `a`.
  await tree.focus();
  await page.keyboard.press("ArrowDown");
  await expect(treeRows(page).nth(2)).toHaveAttribute("aria-selected", "true");
});

test("the frame loop stops after a file that is not a zip archive", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.requestAnimationFrame.bind(window);
    const counter = globalThis as unknown as { zipscopeFrameCount: number };
    counter.zipscopeFrameCount = 0;
    window.requestAnimationFrame = (callback) => {
      counter.zipscopeFrameCount += 1;
      return original(callback);
    };
  });
  const file = test.info().outputPath("not.zip");
  writeFileSync(file, "this is not a zip archive");
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.status).toMatch(/Cannot open/);
  const frames = () =>
    page.evaluate(
      () => (globalThis as unknown as { zipscopeFrameCount: number }).zipscopeFrameCount,
    );
  await page.waitForTimeout(200);
  const before = await frames();
  await page.waitForTimeout(500);
  expect(await frames()).toBe(before);
});

test("collapsing a row while the tree is scrolled down leaves no stale rows", async ({ page }) => {
  const kids = Array.from({ length: 300 }, (_, i) => `k${String(i).padStart(3, "0")}`);
  await open(page, [
    ...kids.map((kid): [string, number] => [`a/${kid}/x`, 1]),
    // b has more children than the pool has rows, so the collapse moves
    // the scroll position past the whole window.
    ...Array.from({ length: 100 }, (_, i): [string, number] => [`b/m${i}/y`, 1]),
  ]);
  const tree = page.locator("#tree-viewport");
  await treeRows(page).nth(1).locator('[data-part="toggle"]').click();
  await expect(tree).toHaveAttribute("data-rows", "303");
  await tree.evaluate((element) => (element.scrollTop = element.scrollHeight));
  await page.locator('#tree-viewport [data-row="302"] [data-part="toggle"]').click();
  await expect(tree).toHaveAttribute("data-rows", "403");
  // Scroll so that b is the first row. After the collapse, the browser
  // scrolls up by most of a viewport.
  await tree.evaluate((element) => (element.scrollTop = 302 * 24));
  const b = page.locator('#tree-viewport [data-row="302"]');
  await expect(b).toBeVisible();
  // Collapse b: the tree gets shorter and the browser scrolls up.
  await b.locator('[data-part="toggle"]').click();
  await expect(tree).toHaveAttribute("data-rows", "303");
  const expected = (row: number) =>
    row === 0 ? "tree.zip" : row === 1 ? "a" : row === 302 ? "b" : kids[row - 2];
  await expect
    .poll(async () => {
      const shown = await tree.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLElement>("[data-row]")]
          .filter((row) => !row.hidden)
          .filter((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > box.top && rect.top < box.bottom;
          })
          .map((row) => ({
            row: Number(row.dataset.row),
            label: row.querySelector('[data-part="label"]')?.textContent ?? "",
          }));
      });
      return shown.filter(({ row, label }) => row >= 303 || label !== expected(row));
    })
    .toEqual([]);
  // The viewport is full of rows.
  const count = await tree.evaluate(
    (element) =>
      [...element.querySelectorAll<HTMLElement>("[data-row]")].filter((row) => !row.hidden).length,
  );
  expect(count).toBeGreaterThan(20);
});
