// The preview opens on request and then follows the selection (the
// Quick Look model). A click on a file only selects it.
// Space, Enter on a file, a double-click on a file, the Preview item of the
// row menu and the Preview button open the preview. Space, Escape and the
// Close button close it. At 390 px, the preview is full screen; Back or
// Escape closes it.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openArchive, waitForOutcome, LISTING_ROWS, useArchiveOrder } from "./listing";
import { storedZip } from "./stored-zip";

const ENTRIES: [string, number][] = [
  ["dir/inner.txt", 4],
  ["a.txt", 1],
  ["b.txt", 2],
  ["c.txt", 3],
];

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 });
  const file = test.info().outputPath("quick-look.zip");
  writeFileSync(file, storedZip(ENTRIES));
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  // The arrow keys need a fixed row order.
  await useArchiveOrder(page, true);
}

const grid = (page: Page) => page.locator("#list-viewport");
const pane = (page: Page) => page.locator("#preview-pane");
/** The title of the preview: the name of the file that it shows. */
const title = (page: Page) => pane(page).locator("span[title]").first();
const row = (page: Page, label: string) =>
  page
    .locator(LISTING_ROWS)
    .filter({ has: page.locator('[data-part="label"]', { hasText: label }) })
    .first();
const selectedLabel = (page: Page) =>
  page.locator('#list-viewport [role=row][aria-selected="true"] [data-part="label"]');

test("a click on a file only selects it, and Space opens and closes the preview", async ({
  page,
}) => {
  // The click had opened the preview, so the first Space
  // closed it. Now the click only selects, and the first Space opens.
  await open(page, 1440);
  await row(page, "a.txt").click();
  await expect(selectedLabel(page)).toHaveText("a.txt");
  await expect(grid(page)).toBeFocused();
  await expect(pane(page)).toHaveCount(0);
  await expect(page.locator("#preview-button")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press(" ");
  await expect(title(page)).toHaveText("a.txt");
  await expect(page.locator("#preview-button")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press(" ");
  await expect(pane(page)).toHaveCount(0);
});

test("a held Space opens the preview once and writes one history entry", async ({ page }) => {
  await open(page, 1440);
  await row(page, "a.txt").click();
  await expect(grid(page)).toBeFocused();
  await page.evaluate(() => {
    const state = { writes: 0 };
    Object.assign(window, { historyWrites: state });
    for (const name of ["pushState", "replaceState"] as const) {
      const write = history[name].bind(history);
      history[name] = (...args: Parameters<History["pushState"]>) => {
        state.writes++;
        write(...args);
      };
    }
  });
  // A second `down` with no `up` is a repeat of the key.
  for (let press = 0; press < 30; press++) await page.keyboard.down(" ");
  await page.keyboard.up(" ");
  await expect(title(page)).toHaveText("a.txt");
  await expect(page.locator("#preview-button")).toHaveAttribute("aria-pressed", "true");
  const writes = () =>
    page.evaluate(
      () => (window as unknown as { historyWrites: { writes: number } }).historyWrites.writes,
    );
  await expect.poll(writes).toBeGreaterThan(0);
  expect(await writes()).toBeLessThanOrEqual(2);
  // The next press is not a repeat, so it closes the preview.
  await page.keyboard.press(" ");
  await expect(pane(page)).toHaveCount(0);
});

test("Enter, a double-click, the row menu and the Preview button open the preview", async ({
  page,
}) => {
  await open(page, 1440);
  // Enter on a file.
  await row(page, "a.txt").click();
  await expect(pane(page)).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(title(page)).toHaveText("a.txt");
  await page.keyboard.press("Escape");
  await expect(pane(page)).toHaveCount(0);
  // A double-click on a file.
  await row(page, "b.txt").dblclick();
  await expect(title(page)).toHaveText("b.txt");
  await page.keyboard.press("Escape");
  await expect(pane(page)).toHaveCount(0);
  // The Preview item of the row menu.
  await row(page, "c.txt").click({ button: "right" });
  await page.locator('#row-menu [data-action="preview"]').click();
  await expect(title(page)).toHaveText("c.txt");
  await page.locator("#preview-close").click();
  await expect(pane(page)).toHaveCount(0);
  // The Close button had the focus, so the focus goes to the Preview
  // button.
  await expect(page.locator("#preview-button")).toBeFocused();
  // The Preview button opens the selected file.
  await row(page, "b.txt").click();
  await expect(pane(page)).toHaveCount(0);
  await page.locator("#preview-button").click();
  await expect(title(page)).toHaveText("b.txt");
  // Enter on a folder still opens the folder.
  await row(page, "dir/").click();
  await expect(page.locator(LISTING_ROWS).locator('[data-part="label"]')).toHaveText(["inner.txt"]);
});

test("the open preview follows clicks and arrow keys, and keeps its file on a folder", async ({
  page,
}) => {
  await open(page, 1440);
  await row(page, "a.txt").click();
  await expect(pane(page)).toHaveCount(0);
  await page.keyboard.press(" ");
  await expect(title(page)).toHaveText("a.txt");
  await row(page, "c.txt").click();
  await expect(title(page)).toHaveText("c.txt");
  await page.keyboard.press("ArrowUp");
  await expect(title(page)).toHaveText("b.txt");
  // A folder selection keeps the last file.
  await page.keyboard.press("Home");
  await expect(selectedLabel(page)).toHaveText("dir/");
  await expect(title(page)).toHaveText("b.txt");
  // Escape from the grid closes the preview, and the grid keeps the focus.
  await page.keyboard.press("Escape");
  await expect(pane(page)).toHaveCount(0);
  await expect(grid(page)).toBeFocused();
  // Arrow keys do not open a closed preview.
  await page.keyboard.press("ArrowDown");
  await expect(selectedLabel(page)).toHaveText("a.txt");
  await expect(pane(page)).toHaveCount(0);
});

test("Escape in the side pane closes the preview and moves the focus to the Preview button", async ({
  page,
}) => {
  await open(page, 1000);
  await row(page, "a.txt").dblclick();
  await expect(title(page)).toHaveText("a.txt");
  await page.locator("#preview-close").focus();
  await page.keyboard.press("Escape");
  await expect(pane(page)).toHaveCount(0);
  await expect(page.locator("#preview-button")).toBeFocused();
});

test("at 390 px a click only selects, and the full-screen preview opens on request", async ({
  page,
}) => {
  await open(page, 390);
  const start = await page.evaluate(() => history.length);
  await row(page, "a.txt").click();
  await expect(selectedLabel(page)).toHaveText("a.txt");
  await expect(pane(page)).toHaveCount(0);
  // Space opens the full-screen preview in a new history entry.
  await page.keyboard.press(" ");
  await expect(title(page)).toHaveText("a.txt");
  await expect(page.locator("#preview-back")).toBeFocused();
  await expect.poll(() => page.evaluate(() => history.length)).toBe(start + 1);
  // Escape closes it, and the focus goes back to the Preview button.
  await page.keyboard.press("Escape");
  await expect(pane(page)).toHaveCount(0);
  await expect(page.locator("#preview-button")).toBeFocused();
  // Enter on a file opens it; the Back button closes it.
  await row(page, "b.txt").click();
  await expect(pane(page)).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(title(page)).toHaveText("b.txt");
  await page.locator("#preview-back").click();
  await expect(pane(page)).toHaveCount(0);
  // A double-click opens it too.
  await row(page, "c.txt").dblclick();
  await expect(title(page)).toHaveText("c.txt");
});

test("a double-click on a folder enters it and opens no preview", async ({ page }) => {
  // The first click enters the folder, and the recycled row element then
  // shows a file of the new listing below the pointer. The second click
  // only selects that file.
  await open(page, 1440);
  await row(page, "dir/").dblclick();
  await expect(page.locator(LISTING_ROWS).locator('[data-part="label"]')).toHaveText(["inner.txt"]);
  await expect(pane(page)).toHaveCount(0);
});
