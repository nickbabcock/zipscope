// The name order of the tree: it lands after the last row, and only the order of
// the rows changes. The selected row or the top row stays in place.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { LISTING_ROWS, openArchive, useArchiveOrder, waitForOutcome } from "./listing";
import { gate, openGate, pauseBetweenBatches } from "./parse-gate";
import { storedZip } from "./stored-zip";
import { writeFileSync } from "node:fs";

const tree = (page: Page) => page.locator("#tree-viewport");
const rows = (page: Page) => page.locator("#tree-viewport [role=treeitem]:not([hidden])");
/** The labels of the rows in the DOM, in row order. The pool reuses elements, so
 *  the order in the DOM is not the row order. */
const labels = (page: Page) =>
  tree(page).evaluate((element) =>
    [...element.querySelectorAll<HTMLElement>("[role=treeitem]:not([hidden])")]
      .sort((a, b) => Number(a.dataset.row) - Number(b.dataset.row))
      .map((row) => row.querySelector('[data-part="label"]')?.textContent ?? ""),
  );
const rowOf = (page: Page, label: string) =>
  page.locator("#tree-viewport [role=treeitem]:not([hidden])").filter({
    has: page.getByText(label, { exact: true }),
  });
const tableLabels = (page: Page) =>
  page.locator(LISTING_ROWS).locator('[data-part="label"]').allTextContents();
const top = (page: Page, label: string) =>
  rowOf(page, label).evaluate((row) => Math.round(row.getBoundingClientRect().top));
const scrollTop = (page: Page) => tree(page).evaluate((element) => element.scrollTop);

function openFile(page: Page, names: string[], name = "order.zip") {
  const file = test.info().outputPath(name);
  writeFileSync(file, storedZip(names.map((entry) => [entry, 1])));
  return openArchive(page, file);
}

/** The folder of each row: more folders than one batch has, not in name order. */
const FOLDER_NAMES = Array.from(
  { length: 5000 },
  (_, index) => `n${String((index * 7919) % 5000).padStart(4, "0")}`,
);
const FOLDERS = FOLDER_NAMES.map((name) => `${name}/f.txt`);

/** Opens the archive and holds the parse after its first rows. */
async function openHeld(page: Page, names: string[]) {
  await pauseBetweenBatches(page);
  await page.goto("/");
  await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "true");
  await page.locator("#file-input").setInputFiles({
    name: "held.zip",
    mimeType: "application/zip",
    buffer: storedZip(names.map((entry) => [entry, 1])),
  });
  await expect.poll(() => gate(page)).toBe(1);
  await gate(page, true);
  await expect.poll(() => gate(page)).toBe(2);
  await expect(tree(page)).toHaveAttribute("data-order", "archive");
  await expect(rows(page).nth(1)).toBeVisible();
}

test("archive order in the table stays the order that the parser saw", async ({ page }) => {
  await page.goto("/");
  await openFile(page, ["zeta/a", "alpha/a", "mid/a"]);
  await waitForOutcome(page);
  await expect(tree(page)).toHaveAttribute("data-order", "name");
  expect(await labels(page)).toEqual(["order.zip", "alpha", "mid", "zeta"]);
  await useArchiveOrder(page);
  await expect.poll(() => tableLabels(page)).toEqual(["zeta/", "alpha/", "mid/"]);
});

test("during the parse the tree stays in archive order, and new folders go last", async ({
  page,
}) => {
  await openHeld(page, FOLDERS);
  const shown = await labels(page);
  expect(shown.slice(1, 3)).toEqual(FOLDER_NAMES.slice(0, 2));
  await openGate(page);
  await waitForOutcome(page);
  await expect(tree(page)).toHaveAttribute("data-order", "name");
  await expect(rows(page).nth(1).locator('[data-part="label"]')).toHaveText("n0000");
  await expect(rows(page).nth(2).locator('[data-part="label"]')).toHaveText("n0001");
});

test("after a cancel the tree gets the name order, and no more rows come", async ({ page }) => {
  await openHeld(page, FOLDERS);
  const shown = await tree(page).getAttribute("data-rows");
  await page.locator("#cancel-button").click();
  await gate(page, true);
  await openGate(page);
  await expect(page.locator("#status")).toContainText("Cancelled");
  await expect(tree(page)).toHaveAttribute("data-order", "name");
  await expect(tree(page)).toHaveAttribute("data-rows", shown!);
  const names = (await labels(page)).slice(1);
  expect(names).toEqual([...names].sort());
});

const budgetOf = (page: Page, soft: number, hard: number) =>
  page.addInitScript(
    ([softBytes, hardBytes]) => {
      Object.assign(globalThis, {
        __zipscopeTestBudget: { soft: softBytes, hard: hardBytes },
      });
    },
    [soft, hard],
  );

/** Enough rows to pass a small budget. Not in name order. */
const MANY = Array.from(
  { length: 60_000 },
  (_, index) => `d${String(60_000 - index).padStart(6, "0")}/f.txt`,
);

test("Stop at the memory prompt leaves the tree in archive order", async ({ page }) => {
  await budgetOf(page, 8 * 2 ** 20, 2 ** 31);
  await page.goto("/");
  await openFile(page, MANY);
  await page.locator("#budget-stop").click();
  await expect(page.locator("#status")).toContainText("Cancelled");
  await expect(tree(page)).toHaveAttribute("data-order", "archive");
  const shown = (await labels(page)).slice(1);
  expect(shown).toEqual([...shown].sort().reverse());
});

test("Continue at the memory prompt: the order has the rows after the prompt", async ({ page }) => {
  await budgetOf(page, 8 * 2 ** 20, 2 ** 31);
  await page.goto("/");
  await openFile(page, MANY);
  await expect(tree(page)).toHaveAttribute("data-order", "archive");
  await page.locator("#budget-continue").click();
  await waitForOutcome(page);
  await expect(tree(page)).toHaveAttribute("data-order", "name");
  await expect(tree(page)).toHaveAttribute("data-rows", String(MANY.length + 1));
  await expect(rows(page).nth(1).locator('[data-part="label"]')).toHaveText("d000001");
});

test("the hard stop leaves the tree in archive order", async ({ page }) => {
  await budgetOf(page, 2 ** 31, 48 * 2 ** 20);
  await page.goto("/");
  await openFile(
    page,
    MANY.map((name) => `${"long".repeat(250)}${name}`),
  );
  await expect(page.locator("#health-stopped")).toBeVisible();
  await expect(tree(page)).toHaveAttribute("data-order", "archive");
  const shown = (await labels(page)).slice(1);
  expect(shown).toEqual([...shown].sort().reverse());
});

test("the selected row stays in place when the order lands", async ({ page }) => {
  await openHeld(page, FOLDERS);
  const label = (await labels(page))[2]!;
  await rowOf(page, label).locator('[data-part="label"]').click();
  await expect(rowOf(page, label)).toHaveAttribute("aria-selected", "true");
  const before = await top(page, label);
  await openGate(page);
  await waitForOutcome(page);
  await expect(tree(page)).toHaveAttribute("data-order", "name");
  await expect(rowOf(page, label)).toHaveAttribute("aria-selected", "true");
  expect(await top(page, label)).toBe(before);
  // The rows around it are in the new order.
  const names = (await labels(page)).slice(1);
  expect(names).toEqual([...names].sort());
});

test("with no selected row in view, the top row stays at the top", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 500 });
  await openHeld(page, FOLDERS);
  const box = await tree(page).evaluate((element) => element.getBoundingClientRect().top);
  const topLabel = () =>
    tree(page).evaluate((element, y) => {
      const rows = [...element.querySelectorAll<HTMLElement>("[role=treeitem]:not([hidden])")].sort(
        (a, b) => Number(a.dataset.row) - Number(b.dataset.row),
      );
      const row = rows.find((candidate) => Math.round(candidate.getBoundingClientRect().top) >= y);
      return row?.querySelector('[data-part="label"]')?.textContent;
    }, Math.round(box));
  const shown = await topLabel();
  await tree(page).evaluate((element) => element.scrollTo(0, 24 * 30));
  await expect.poll(topLabel).not.toBe(shown);
  const first = await topLabel();
  await openGate(page);
  await waitForOutcome(page);
  await expect(tree(page)).toHaveAttribute("data-order", "name");
  await expect.poll(topLabel).toBe(first);
  expect(await scrollTop(page)).toBeGreaterThan(0);
});

test("open folders stay open and the keyboard keeps its row after the landing", async ({
  page,
}) => {
  const names = FOLDER_NAMES.flatMap((name) => [`${name}/f.txt`, `${name}/sub/g`]);
  await openHeld(page, names);
  const label = (await labels(page))[2]!;
  await rowOf(page, label).locator('[data-part="toggle"]').click();
  await expect(rowOf(page, label)).toHaveAttribute("aria-expanded", "true");
  await tree(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(rows(page).nth(3)).toHaveAttribute("aria-selected", "true");
  const selected = await page
    .locator('#tree-viewport [aria-selected=true] [data-part="label"]')
    .textContent();
  await openGate(page);
  await waitForOutcome(page);
  await expect(tree(page)).toHaveAttribute("data-order", "name");
  await expect(page.locator('#tree-viewport [aria-selected=true] [data-part="label"]')).toHaveText(
    selected!,
  );
  await expect(page.locator("#tree-viewport [aria-selected=true]")).toBeInViewport();
  await expect(rowOf(page, label)).toHaveAttribute("aria-expanded", "true");
  // The next key moves from the selected row in the new order.
  await tree(page).focus();
  const index = Number(
    await page.locator("#tree-viewport [aria-selected=true]").getAttribute("data-row"),
  );
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#tree-viewport [aria-selected=true]")).toHaveAttribute(
    "data-row",
    String(index + 1),
  );
});
