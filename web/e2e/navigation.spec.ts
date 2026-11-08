// Navigation and history: the breadcrumb, push versus replace, Back to
// the front door with the archive still open, and the keyboard.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openArchive, waitForOutcome, LISTING_ROWS } from "./listing";
import { storedZip } from "./stored-zip";

const ENTRIES: [string, number][] = [
  ["app/src/main/a.rs", 10],
  ["app/src/main/b.rs", 20],
  ["app/src/test/t.rs", 5],
  ["app/README.md", 1],
  ["docs/guide.md", 2],
  ["top.txt", 3],
];

async function open(page: Page, width = 1440, entries = ENTRIES) {
  await page.setViewportSize({ width, height: 800 });
  const file = test.info().outputPath("nav.zip");
  writeFileSync(file, storedZip(entries));
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
}

const tableRows = (page: Page) => page.locator(LISTING_ROWS);
const labels = (page: Page) => tableRows(page).locator('[data-part="label"]').allTextContents();
const crumbs = (page: Page) => page.locator("#location li").allTextContents();
const folderRow = (page: Page, label: string) =>
  tableRows(page).filter({ has: page.locator('[data-part="label"]', { hasText: label }) });
const historyLength = (page: Page) => page.evaluate(() => history.length);
/** The focus is on the grid, and its cursor is the row of `label`. The
 *  grid keeps the focus and names the cursor row with
 *  aria-activedescendant. */
async function expectCursor(page: Page, label: string) {
  await expect(page.locator("#list-viewport")).toBeFocused();
  await expect(folderRow(page, label)).toHaveAttribute("aria-selected", "true");
  const active = await page.locator("#list-viewport").getAttribute("aria-activedescendant");
  await expect(page.locator(`#${active} [data-part="label"]`)).toHaveText(label);
}

test("the breadcrumb follows the tree, folder rows and its own segments", async ({ page }) => {
  await open(page);
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip"]);
  await expect(page.locator('#location [aria-current="location"]')).toHaveText("nav.zip");

  await folderRow(page, "app/").click();
  await expect.poll(() => labels(page)).toEqual(["src/", "README.md"]);
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app"]);

  await folderRow(page, "src/").click();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app", "/src"]);

  // A tree folder navigates there.
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])", { hasText: "docs" }).click();
  await expect.poll(() => labels(page)).toEqual(["guide.md"]);
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/docs"]);

  // A breadcrumb segment navigates there.
  await page.goBack();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app", "/src"]);
  await page.locator("#location button", { hasText: "app" }).click();
  await expect.poll(() => labels(page)).toEqual(["src/", "README.md"]);
  // The address bar stays plain.
  expect(new URL(page.url()).pathname).toBe("/");
  expect(new URL(page.url()).search).toBe("");
});

test("navigation pushes and inspection replaces", async ({ page }) => {
  await open(page);
  const start = await historyLength(page);

  // Entering a folder pushes.
  await folderRow(page, "app/").click();
  await expect.poll(() => historyLength(page)).toBe(start + 1);
  await folderRow(page, "src/").click();
  await expect.poll(() => historyLength(page)).toBe(start + 2);

  // Sort, column changes, scroll, the preview and search typing replace.
  await page.locator('[data-column="size"] button').click();
  await page.locator("#column-picker-button").click();
  await page.locator("#column-picker").getByRole("checkbox", { name: "Ratio" }).uncheck();
  await page.keyboard.press("Escape");
  await page.locator("#list-viewport").evaluate((list) => list.scrollTo(0, 10));
  await folderRow(page, "main/").click();
  await expect.poll(() => historyLength(page)).toBe(start + 3);
  // A click only selects; a double-click opens the preview.
  await tableRows(page).first().dblclick();
  await expect(page.locator("#preview-pane")).toBeVisible();
  await page.locator("#search-input").fill("rs");
  await expect.poll(() => labels(page)).toHaveLength(3);
  await page.locator("#search-input").fill("a.rs");
  await expect.poll(() => labels(page)).toEqual(["app/src/main/a.rs"]);
  expect(await historyLength(page)).toBe(start + 3);
  // A replace writes the entry within a short interval.
  const state = () => page.evaluate(() => history.state as { query: string; sort: unknown });
  await expect.poll(async () => (await state()).query).toBe("a.rs");
  expect((await state()).sort).not.toBeNull();

  // Back returns to the folder before the last push, and Forward to the
  // search that the replace recorded.
  await page.goBack();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app", "/src"]);
  await expect(page.locator("#search-input")).toHaveValue("");
  await page.goForward();
  await expect(page.locator("#search-input")).toHaveValue("a.rs");
  await expect.poll(() => labels(page)).toEqual(["app/src/main/a.rs"]);
  await page.goBack();
  await page.goBack();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app"]);
  expect(await historyLength(page)).toBe(start + 3);
});

test("tree arrow keys replace and a tree click pushes", async ({ page }) => {
  await open(page);
  const start = await historyLength(page);
  await page.locator("#tree-viewport").focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app"]);
  expect(await historyLength(page)).toBe(start);
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])", { hasText: "docs" }).click();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/docs"]);
  await expect.poll(() => historyLength(page)).toBe(start + 1);
  // The replace recorded the folder that the arrow key selected.
  await page.goBack();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app"]);
});

test("Back from the archive root shows the front door, and the archive stays", async ({ page }) => {
  await open(page);
  await folderRow(page, "app/").click();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app"]);

  await page.goBack();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip"]);
  await page.goBack();
  const door = page.locator("#front-door");
  await expect(door).toBeVisible();
  await expect(page.locator("#panes")).toBeHidden();
  const back = page.locator("#return-button");
  await expect(back).toHaveText("Return to nav.zip");
  await expect(back).toBeFocused();
  // The archive is still open.
  await expect(page.locator("#archive-name")).toHaveText("nav.zip");
  expect(new URL(page.url()).pathname).toBe("/");

  // Forward returns.
  await page.goForward();
  await expect(door).toBeHidden();
  await expect.poll(() => labels(page)).toEqual(["app/", "docs/", "top.txt"]);

  // "Return to" returns, and Forward still reaches the folder after it.
  await page.goBack();
  await back.click();
  await expect(door).toBeHidden();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip"]);
  await page.goForward();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app"]);
});

test("Enter opens a folder and Backspace goes up a level", async ({ page }) => {
  await open(page);
  const start = await historyLength(page);
  // Tab from the control before the table reaches one row of it, and the
  // arrow keys move it.
  await page.locator("#preview-button").focus();
  await page.keyboard.press("Tab");
  await expectCursor(page, "app/");
  await page.keyboard.press("ArrowDown");
  await expectCursor(page, "docs/");
  await page.keyboard.press("ArrowUp");
  await expectCursor(page, "app/");
  await page.keyboard.press("Enter");
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app"]);
  await expectCursor(page, "src/");
  await page.keyboard.press("Enter");
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app", "/src"]);
  await page.keyboard.press("Backspace");
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app"]);
  await page.keyboard.press("Backspace");
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip"]);
  // At the root, Backspace does nothing.
  await page.keyboard.press("Backspace");
  await expect.poll(() => historyLength(page)).toBe(start + 4);

  // Backspace in the search field edits the query.
  await page.locator("#search-input").fill("ab");
  await page.locator("#search-input").press("Backspace");
  await expect(page.locator("#search-input")).toHaveValue("a");
  // Out of the field, Backspace leaves the search for its folder.
  await page.locator("#search-input").blur();
  await page.keyboard.press("Backspace");
  await expect(page.locator("#search-input")).toHaveValue("");
  await expect.poll(() => labels(page)).toEqual(["app/", "docs/", "top.txt"]);
});

test("the focus follows to a shorter listing", async ({ page }) => {
  await open(page, 1440, [
    ["a/one/f1", 1],
    ["a/one/f2", 1],
    ["a/one/f3", 1],
    ["b/g", 1],
  ]);
  // The label of the cursor row of the focused grid.
  const focused = () =>
    page.evaluate(() => {
      const grid = document.activeElement;
      const id = grid?.getAttribute("aria-activedescendant");
      const row = id === null || id === undefined ? null : document.getElementById(id);
      return row?.querySelector('[data-part="label"]')?.textContent ?? "";
    });
  await page.locator("#preview-button").focus();
  await page.keyboard.press("Tab");
  await expect.poll(focused).toBe("a/one/");
  // Enter on row 2 into a listing of one row.
  await page.keyboard.press("ArrowDown");
  await expect.poll(focused).toBe("b/");
  await page.keyboard.press("Enter");
  await expect.poll(() => labels(page)).toEqual(["g"]);
  await expect.poll(focused).toBe("g");
  // Backspace from row 3 into a parent listing of two rows.
  await page.keyboard.press("Backspace");
  await expect.poll(focused).toBe("a/one/");
  await page.keyboard.press("Enter");
  await expect.poll(() => labels(page)).toEqual(["f1", "f2", "f3"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect.poll(focused).toBe("f3");
  // Backspace goes to the parent folder, also inside the compact chain
  // `a/one/`: first `a/`, then the root.
  await page.keyboard.press("Backspace");
  await expect.poll(() => labels(page)).toEqual(["one/"]);
  await expect.poll(focused).toBe("one/");
  await page.keyboard.press("Backspace");
  await expect.poll(() => labels(page)).toEqual(["a/one/", "b/"]);
  await expect.poll(focused).toBe("a/one/");
  // The keys still work.
  await page.keyboard.press("ArrowDown");
  await expect.poll(focused).toBe("b/");
});

test("the archive root opens the Archive panel in a new entry", async ({ page }) => {
  await open(page);
  const start = await historyLength(page);
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
  await expect(page.locator("#archive-panel")).toBeVisible();
  await expect.poll(() => historyLength(page)).toBe(start + 1);
  await page.goBack();
  await expect(page.locator("#preview-pane")).toHaveCount(0);

  // The root segment is current and still opens the panel.
  const root = page.locator('#location button[aria-current="location"]');
  await expect(root).toHaveText("nav.zip");
  await root.click();
  await expect(page.locator("#archive-panel")).toBeVisible();
  await expect.poll(() => historyLength(page)).toBe(start + 1);
  await page.goBack();
  await expect(page.locator("#preview-pane")).toHaveCount(0);
});

test("Back during a search shows the folder of the entry", async ({ page }) => {
  await open(page);
  await folderRow(page, "app/").click();
  await page.locator("#search-input").fill("rs");
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app", "·Search results"]);
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])", { hasText: "docs" }).click();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/docs"]);
  await page.locator("#search-input").fill("rs");
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/docs", "·Search results"]);
  await page.goBack();
  await expect(page.locator("#search-input")).toHaveValue("rs");
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app", "·Search results"]);
  // Backspace leaves the search for the folder that the breadcrumb shows.
  await page.locator("#tree-viewport").focus();
  await page.keyboard.press("Backspace");
  await expect.poll(() => labels(page)).toEqual(["src/", "README.md"]);
});

test("Back before a listing arrives lists the folder of the entry", async ({ page }) => {
  // Holds the messages to the parse worker, so a list request waits.
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    const gate = { held: undefined as (() => void)[] | undefined };
    Object.assign(window, { navGate: gate });
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      if (gate.held !== undefined) {
        gate.held.push(() => Reflect.apply(post, this, args));
        return;
      }
      return Reflect.apply(post, this, args) as void;
    };
  });
  await open(page);
  const hold = () =>
    page.evaluate(() => {
      (window as unknown as { navGate: { held?: (() => void)[] } }).navGate.held = [];
    });
  const release = () =>
    page.evaluate(() => {
      const gate = (window as unknown as { navGate: { held?: (() => void)[] } }).navGate;
      const held = gate.held ?? [];
      gate.held = undefined;
      for (const send of held) send();
    });
  await hold();
  await folderRow(page, "app/").click();
  await page.goBack();
  await expect
    .poll(() => page.evaluate(() => (history.state as { folder: number }).folder))
    .toBe(0);
  await release();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip"]);
  await expect.poll(() => labels(page)).toEqual(["app/", "docs/", "top.txt"]);

  // A folder that waits is the target: the breadcrumb root still pushes.
  await hold();
  await folderRow(page, "app/").click();
  await page.locator("#location button", { hasText: "nav.zip" }).click();
  await release();
  await expect(page.locator("#archive-panel")).toBeVisible();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip"]);
});

test("the archive name opens the Archive panel during a search", async ({ page }) => {
  await open(page);
  await folderRow(page, "app/").click();
  await page.locator("#search-input").fill("rs");
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app", "·Search results"]);
  const start = await historyLength(page);
  await page.locator("#location button", { hasText: "nav.zip" }).click();
  await expect(page.locator("#archive-panel")).toBeVisible();
  await expect(page.locator("#search-input")).toHaveValue("");
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip"]);
  await expect.poll(() => historyLength(page)).toBe(start + 1);

  // With the panel open, a search and then the archive name push again.
  await page.locator("#search-input").fill("rs");
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "·Search results"]);
  await page.locator("#location button", { hasText: "nav.zip" }).click();
  await expect(page.locator("#search-input")).toHaveValue("");
  await expect.poll(() => labels(page)).toEqual(["app/", "docs/", "top.txt"]);
  await expect(page.locator("#archive-panel")).toBeVisible();
  await expect.poll(() => historyLength(page)).toBe(start + 2);
  // A second click with nothing to change adds no entry.
  await page.locator("#location button", { hasText: "nav.zip" }).click();
  expect(await historyLength(page)).toBe(start + 2);
});

test("a collapse above the listed folder updates the entry", async ({ page }) => {
  await open(page);
  await folderRow(page, "app/").click();
  await folderRow(page, "src/").click();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app", "/src"]);
  const app = page.locator("#tree-viewport [role=treeitem]:not([hidden])", { hasText: /^app/ });
  await app.locator('[data-part="toggle"]').click();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app"]);
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])", { hasText: "docs" }).click();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/docs"]);
  await page.goBack();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app"]);
  await expect.poll(() => labels(page)).toEqual(["src/", "README.md"]);
});

test("the narrow preview pushes, and Back closes it", async ({ page }) => {
  await open(page, 390);
  const start = await historyLength(page);
  // A click only selects (the Quick Look model): Enter opens the preview.
  await folderRow(page, "top.txt").click();
  await expect(page.locator("#preview-pane")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.locator("#preview-pane")).toBeVisible();
  await expect.poll(() => historyLength(page)).toBe(start + 1);
  await page.goBack();
  await expect(page.locator("#preview-pane")).toHaveCount(0);
  await expect.poll(() => labels(page)).toEqual(["app/", "docs/", "top.txt"]);

  // The Back button of the preview goes back too, so Forward reopens it.
  await folderRow(page, "top.txt").dblclick();
  await page.locator("#preview-back").click();
  await expect(page.locator("#preview-pane")).toHaveCount(0);
  await page.goForward();
  await expect(page.locator("#preview-pane")).toBeVisible();
});

test("Back with the tree drawer open leaves the top bar on", async ({ page }) => {
  await open(page, 390);
  const bar = page.locator("header");
  const inert = () => bar.evaluate((element) => (element as HTMLElement).inert);
  await page.locator("#drawer-button").click();
  await expect.poll(inert).toBe(true);
  await page.goBack();
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "return");
  await expect.poll(inert).toBe(false);
  await expect(bar.getByRole("button", { name: /open/i }).first()).toBeEnabled();
  await page.goForward();
  await expect(page.locator("#front-door")).toBeHidden();
  await expect.poll(inert).toBe(true);
});
