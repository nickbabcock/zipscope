// Grid interactions: the keyboard model, row selection, inline
// expansion, middle truncation, the row menu and scaled scrolling.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { holdableWorkers, holdWorkers, releaseWorkers } from "./hold";
import { openArchive, waitForOutcome, LISTING_ROWS, useArchiveOrder } from "./listing";
import { storedZip } from "./stored-zip";

async function open(page: Page, entries: [string, number][], declared?: bigint) {
  const file = test.info().outputPath("grid.zip");
  writeFileSync(file, storedZip(entries, declared));
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  // The keys and the menus need a fixed
  // row order. default-sort.spec.ts tests the default.
  await useArchiveOrder(page);
}

/**
 * Clicks the elements in one task. Thus the second request starts before
 * the first one can end.
 */
async function clickInOneTask(page: Page, locators: Locator[]) {
  const elements = await Promise.all(locators.map((locator) => locator.elementHandle()));
  await page.evaluate((all) => {
    for (const element of all) (element as HTMLElement).click();
  }, elements);
}

/**
 * The tree request (`expand`) started during the build of the open folder
 * (`expandInline`) and ended before it. A build in one piece makes the
 * tree request wait for all of it.
 */
async function expectTreeRequestBetweenSteps(page: Page) {
  const times = await page.evaluate(() =>
    performance.getEntriesByName("zipscope:view-request").map((entry) => ({
      kind: (entry as PerformanceMeasure).detail as string,
      start: entry.startTime,
      end: entry.startTime + entry.duration,
    })),
  );
  const expand = times.find((time) => time.kind === "expand");
  const inline = times.find((time) => time.kind === "expandInline");
  const message = JSON.stringify(times);
  expect(expand!.start, message).toBeLessThan(inline!.end);
  expect(expand!.end, message).toBeLessThan(inline!.end);
}

const grid = (page: Page) => page.locator("#list-viewport");
const tableRows = (page: Page) => page.locator(LISTING_ROWS);
/** The shown rows in row order, as `label` with two spaces for each level. */
const rowsText = (page: Page) =>
  tableRows(page).evaluateAll((rows) =>
    rows
      .map((row) => ({
        index: Number((row as HTMLElement).dataset.row),
        text:
          "  ".repeat(Number((row as HTMLElement).dataset.level ?? 0)) +
          (row.querySelector('[data-part="label"]')?.textContent ?? ""),
      }))
      .sort((a, b) => a.index - b.index)
      .map((row) => row.text),
  );
const selectedLabel = (page: Page) =>
  page.locator('#list-viewport [role=row][aria-selected="true"] [data-part="label"]');

const ENTRIES: [string, number][] = [
  ["docs/guide.md", 10],
  ["docs/api/index.md", 20],
  ["docs/api/deep/x.md", 5],
  ["src/main.rs", 50],
  ["README.md", 1],
];

test("the grid exposes its true size and the selected row", async ({ page }) => {
  await open(page, ENTRIES);
  const table = grid(page);
  await expect(table).toHaveAttribute("role", "grid");
  // The header, 3 rows of the listing, and the label row and 4 rows of the
  // largest files below it. The block leaves out README.md, a
  // direct entry of the root, so 4 rows, not 5.
  await expect(table).toHaveAttribute("aria-rowcount", "9");
  await expect(tableRows(page).nth(0)).toHaveAttribute("aria-rowindex", "2");
  // The focus selects the first row.
  await table.focus();
  await expect(selectedLabel(page)).toHaveText("docs/");
  const active = await table.getAttribute("aria-activedescendant");
  expect(active).not.toBeNull();
  await expect(page.locator(`#${active}`)).toHaveAttribute("aria-selected", "true");
  // The tree gives the place of each row in its parent.
  const tree = page.locator("#tree-viewport [role=treeitem]:not([hidden])");
  await expect(tree.nth(1)).toHaveAttribute("aria-posinset", "1");
  await expect(tree.nth(1)).toHaveAttribute("aria-setsize", "2");
});

// navigation.spec.ts tests Backspace and the history.
test("arrows, Home and End move, and Enter opens a folder with the focus kept", async ({
  page,
}) => {
  // A window where the largest files do not fit, so End goes
  // to the last row of the listing.
  await page.setViewportSize({ width: 1440, height: 400 });
  await open(page, ENTRIES);
  await grid(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(selectedLabel(page)).toHaveText("src/");
  await page.keyboard.press("End");
  await expect(selectedLabel(page)).toHaveText("README.md");
  await expect(page.locator("#list-viewport [data-block]")).toHaveCount(0);
  await page.keyboard.press("Home");
  await expect(selectedLabel(page)).toHaveText("docs/");
  await page.keyboard.press("Enter");
  await expect.poll(() => rowsText(page)).toEqual(["api/", "guide.md"]);
  await expect(page.locator('#tree-viewport [aria-selected="true"]')).toContainText("docs");
  await expect(grid(page)).toBeFocused();
});

test("Space toggles the preview of the selected entry, and / goes to search", async ({ page }) => {
  // A window where the largest files do not fit, so End selects
  // the last row of the listing, not a row of the block.
  await page.setViewportSize({ width: 1440, height: 400 });
  await open(page, ENTRIES);
  await grid(page).focus();
  await page.keyboard.press("End");
  await expect(page.locator('#list-viewport [aria-selected="true"]')).not.toHaveAttribute(
    "data-block",
  );
  await page.keyboard.press(" ");
  const preview = page.locator("#preview-pane");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("README.md");
  // The preview follows the selection.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await expect(preview).toContainText("README.md");
  await page.keyboard.press(" ");
  await expect(preview).toHaveCount(0);
  await page.keyboard.press("/");
  await expect(page.locator("#search-input")).toBeFocused();
});

// preview-open.spec.ts tests the click, Space and the other open actions
// of the preview (the Quick Look model).

test("folder rows open in place with the toggle, the arrows, * and Alt-click", async ({ page }) => {
  await open(page, ENTRIES);
  const docs = tableRows(page).filter({ hasText: "docs/" }).first();
  await expect(docs).toHaveAttribute("aria-expanded", "false");
  await docs.locator('[data-part="toggle"]').click();
  await expect
    .poll(() => rowsText(page))
    .toEqual(["docs/", "  api/", "  guide.md", "src/", "README.md"]);
  await expect(docs).toHaveAttribute("aria-expanded", "true");
  // The keyboard: Right opens, Left closes, then goes to the parent row.
  await page.keyboard.press("ArrowDown");
  await expect(selectedLabel(page)).toHaveText("api/");
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => rowsText(page))
    .toEqual(["docs/", "  api/", "    deep/", "    index.md", "  guide.md", "src/", "README.md"]);
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() => rowsText(page))
    .toEqual(["docs/", "  api/", "  guide.md", "src/", "README.md"]);
  await page.keyboard.press("ArrowLeft");
  await expect(selectedLabel(page)).toHaveText("docs/");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => rowsText(page)).toEqual(["docs/", "src/", "README.md"]);
  // * opens everything below.
  await page.keyboard.press("*");
  await expect
    .poll(() => rowsText(page))
    .toEqual([
      "docs/",
      "  api/",
      "    deep/",
      "      x.md",
      "    index.md",
      "  guide.md",
      "src/",
      "README.md",
    ]);
  // Alt-click closes everything below; a plain open then shows closed rows.
  await docs.locator('[data-part="toggle"]').click({ modifiers: ["Alt"] });
  await expect.poll(() => rowsText(page)).toEqual(["docs/", "src/", "README.md"]);
  await docs.locator('[data-part="toggle"]').click();
  await expect
    .poll(() => rowsText(page))
    .toEqual(["docs/", "  api/", "  guide.md", "src/", "README.md"]);
});

test("long names shorten in the middle and keep the extension", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 700 });
  const name = `ingest-${"x".repeat(80)}-2026-10-21.jsonl`;
  await open(page, [
    [name, 10],
    [`ingest-${"x".repeat(80)}-2026-10-22.jsonl`, 10],
  ]);
  const labels = tableRows(page).locator('[data-part="label"]');
  await expect(labels.first()).toHaveAttribute("title", name);
  const shown = (await labels.allTextContents()).sort();
  expect(shown[0]).toMatch(/^ingest-x+…-10-21\.jsonl$/);
  expect(shown[1]).toMatch(/^ingest-x+…-10-22\.jsonl$/);
  // The label fits in its cell: no clipping by CSS.
  const fits = await labels.evaluateAll((elements) =>
    elements.every((element) => element.scrollWidth <= element.clientWidth + 1),
  );
  expect(fits).toBe(true);
});

test("the row menu opens at the pointer and with the keyboard", async ({ page }) => {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { copied: string[] }).copied = copied;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void copied.push(text) },
    });
  });
  await open(page, ENTRIES);
  const menu = page.locator("#row-menu");
  const readme = tableRows(page).filter({ hasText: "README.md" });
  await readme.click({ button: "right", position: { x: 40, y: 10 } });
  await expect(menu).toBeVisible();
  await expect(menu.locator("[role=menuitem]:not([hidden])")).toHaveText([
    // The verbs first, the copies after a rule.
    "PreviewP",
    "ExtractE",
    "Copy pathC",
    "Copy rowR",
  ]);
  await expect(menu.locator('[data-action="extract"]')).not.toHaveAttribute("aria-disabled");
  // Anchored at the pointer.
  // The menu opens at the pointer, but
  // below the row, so that it does not cover the name of its row.
  // On a name it starts at the start of the
  // names, and a pointer open makes no item active: the menu has the focus.
  const box = await readme.boundingBox();
  const name = await readme.locator('[data-part="label"]').boundingBox();
  const at = await menu.boundingBox();
  expect(Math.abs(at!.x - name!.x)).toBeLessThan(2);
  expect(Math.abs(at!.y - (box!.y + box!.height))).toBeLessThan(2);
  await expect(menu).toBeFocused();
  // A one-key shortcut runs the item and closes the menu.
  await page.keyboard.press("r");
  await expect(menu).toBeHidden();
  await expect(grid(page)).toBeFocused();
  const copied = () => page.evaluate(() => (window as unknown as { copied: string[] }).copied);
  await expect.poll(copied).toEqual(["README.md\t1\t1\t100.0%\tStored\t"]);

  // Shift+F10 opens it at the selected row; Escape closes it.
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  const row = await tableRows(page).filter({ hasText: "docs/" }).boundingBox();
  const below = await menu.boundingBox();
  expect(below!.y).toBeGreaterThanOrEqual(row!.y + row!.height - 4);
  await expect(menu.locator('[data-action="preview"]')).toHaveAttribute("aria-disabled", "true");
  // A folder has no preview, so the keys start at
  // Extract, the first item that can run.
  await expect(menu.locator('[data-action="extract"]')).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(menu.locator('[data-action="copy-row"]')).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect.poll(copied).toContain("docs/");
  await expect(menu).toBeHidden();
  await page.keyboard.press("ContextMenu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(grid(page)).toBeFocused();
  // The focus goes back to the grid in the same task as the item, so the
  // next key goes to the grid. Before, it went back on the toggle event
  // of the popover, in a later task, and a fast key went to the hidden
  // item.
  for (const key of ["Enter", "Escape"]) {
    await page.keyboard.press("ContextMenu");
    await expect(menu.locator('[data-action="extract"]')).toBeFocused();
    const focused = await page.evaluate((key) => {
      const item = document.querySelector<HTMLElement>('#row-menu [data-action="copy-path"]')!;
      if (key === "Enter") item.click();
      else item.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      return document.activeElement?.id;
    }, key);
    expect(focused).toBe("list-viewport");
    await expect(menu).toBeHidden();
  }
});

test("without anchor positioning, the menu places itself below the row", async ({ page }) => {
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((...args: [string, string?]) =>
      /position-area/.test(args[0])
        ? false
        : supports(...(args as [string]))) as typeof CSS.supports;
  });
  await open(page, ENTRIES);
  const menu = page.locator("#row-menu");
  await grid(page).focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("data-anchored", "false");
  const row = await tableRows(page).filter({ hasText: "README.md" }).boundingBox();
  const box = await menu.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(row!.y + row!.height - 4);
  expect(Math.abs(box!.x - row!.x)).toBeLessThan(64);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("show in tree from a search result lists its folder and selects it", async ({ page }) => {
  await open(page, ENTRIES);
  await page.locator("#search-input").fill("index");
  await expect.poll(() => rowsText(page)).toEqual(["docs/api/index.md"]);
  await tableRows(page).first().click({ button: "right" });
  await expect(page.locator('#row-menu [data-action="show-in-tree"]')).toBeVisible();
  await page.keyboard.press("t");
  await expect(page.locator("#search-input")).toHaveValue("");
  await expect.poll(() => rowsText(page)).toEqual(["deep/", "index.md"]);
  await expect(selectedLabel(page)).toHaveText("index.md");
  await expect(page.locator('#tree-viewport [aria-selected="true"]')).toContainText("api");
});

test("show in tree does nothing when its archive closed before the answer", async ({ page }) => {
  await holdableWorkers(page);
  await open(page, ENTRIES);
  await page.locator("#search-input").fill("index");
  await expect.poll(() => rowsText(page)).toEqual(["docs/api/index.md"]);
  await tableRows(page).first().click({ button: "right" });
  await expect(page.locator('#row-menu [data-action="show-in-tree"]')).toBeVisible();
  // The answer to "show in tree" waits until another archive opened.
  await holdWorkers(page);
  await page.keyboard.press("t");
  const file = test.info().outputPath("other.zip");
  writeFileSync(file, storedZip([["other.txt", 1]]));
  await openArchive(page, file);
  await releaseWorkers(page);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  await expect.poll(() => rowsText(page)).toEqual(["other.txt"]);
  // The old answer did not move the new archive to a folder of the old one.
  expect(await page.evaluate(() => (history.state as { entry: string | null }).entry)).toBe(null);
  await expect(page.locator("#list-viewport")).toHaveAttribute("data-listing-folder", "0");
});

test("the row menu acts on the row on the screen when a sort is not drawn yet", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { copied: string[] }).copied = copied;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void copied.push(text) },
    });
  });
  await open(page, [
    ["b.txt", 1],
    ["a.txt", 2],
  ]);
  await expect.poll(() => rowsText(page)).toEqual(["b.txt", "a.txt"]);
  // Hold the frames, so the screen keeps the archive order while the
  // worker publishes the name order.
  await page.evaluate(() => {
    const held: FrameRequestCallback[] = [];
    const scope = window as unknown as {
      held: FrameRequestCallback[];
      raf: typeof requestAnimationFrame;
    };
    scope.held = held;
    scope.raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      held.push(callback);
      return held.length;
    };
  });
  await page.locator('#list-viewport [data-column="name"] button').click();
  // The worker publishes the name order in this time. The held frames must
  // keep it off the screen.
  await page.waitForTimeout(500);
  expect(await rowsText(page)).toEqual(["b.txt", "a.txt"]);
  // Right-click the first row on the screen, which shows b.txt.
  await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('#list-viewport [data-row="0"]')!;
    const box = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: box.left + 20,
        clientY: box.top + 10,
      }),
    );
  });
  await expect(page.locator("#row-menu")).toBeVisible();
  await page.keyboard.press("c");
  const copied = () => page.evaluate(() => (window as unknown as { copied: string[] }).copied);
  await expect.poll(copied).toEqual(["b.txt"]);
  await page.evaluate(() => {
    const scope = window as unknown as {
      held: FrameRequestCallback[];
      raf: typeof requestAnimationFrame;
    };
    window.requestAnimationFrame = scope.raf;
    for (const callback of scope.held.splice(0)) {
      scope.raf(callback);
    }
  });
  await expect.poll(() => rowsText(page)).toEqual(["a.txt", "b.txt"]);
});

test("Copy row quotes names that a spreadsheet reads as formulas", async ({ page }) => {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { copied: string[] }).copied = copied;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void copied.push(text) },
    });
  });
  await open(page, [
    ["=1+1", 1],
    ["@cmd", 1],
    ["-x", 1],
  ]);
  const copied = () => page.evaluate(() => (window as unknown as { copied: string[] }).copied);
  for (const name of ["=1+1", "@cmd", "-x"]) {
    await tableRows(page).filter({ hasText: name }).click({ button: "right" });
    await page.keyboard.press("r");
    await expect.poll(async () => (await copied()).at(-1)?.split("\t")[0]).toBe(`'${name}`);
    // Copy path stays as the name is.
    await tableRows(page).filter({ hasText: name }).click({ button: "right" });
    await page.keyboard.press("c");
    await expect.poll(async () => (await copied()).at(-1)).toBe(name);
  }
});

test("Backspace goes to the parent folder inside a compact chain", async ({ page }) => {
  await open(page, [
    ["a/b/c/x.txt", 1],
    ["z.txt", 1],
  ]);
  await expect.poll(() => rowsText(page)).toEqual(["a/b/c/", "z.txt"]);
  await grid(page).focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect.poll(() => rowsText(page)).toEqual(["x.txt"]);
  await page.keyboard.press("Backspace");
  await expect.poll(() => rowsText(page)).toEqual(["c/"]);
  await page.keyboard.press("Backspace");
  await expect.poll(() => rowsText(page)).toEqual(["b/c/"]);
  await page.keyboard.press("Backspace");
  await expect.poll(() => rowsText(page)).toEqual(["a/b/c/", "z.txt"]);
});

test("show in tree selects the folder row of a folder entry", async ({ page }) => {
  await open(page, [
    ["docs/", 0],
    ["docs/guide.md", 1],
    ["src/main.rs", 1],
  ]);
  await page.locator("#search-input").fill("docs");
  await expect.poll(() => rowsText(page)).toEqual(["docs/", "docs/guide.md"]);
  await tableRows(page).first().click({ button: "right" });
  await page.keyboard.press("t");
  await expect(page.locator("#search-input")).toHaveValue("");
  await expect.poll(() => rowsText(page)).toEqual(["docs/", "src/"]);
  await expect(selectedLabel(page)).toHaveText("docs/");
});

test("show in tree finds the folder of a second folder entry and of a folded deep path", async ({
  page,
}) => {
  const deep = `${"d/".repeat(258)}f.txt`;
  await open(page, [
    ["docs/", 0],
    ["docs/guide.md", 1],
    ["docs/", 0],
    [deep, 1],
  ]);
  // The second `docs/` is an entry of the folder `docs`.
  await page.locator("#search-input").fill("docs");
  await expect.poll(() => rowsText(page)).toEqual(["docs/", "docs/guide.md", "docs/"]);
  await page.locator('#list-viewport [data-row="2"]').click({ button: "right" });
  await page.keyboard.press("t");
  await expect.poll(() => rowsText(page)).toEqual(["guide.md", "docs/"]);
  await expect(selectedLabel(page)).toHaveText("docs/");
  // A path of 258 folders is in the folder that the last folders fold
  // into.
  await page.locator("#search-input").fill("f.txt");
  await expect.poll(() => rowsText(page)).toHaveLength(1);
  await tableRows(page).first().click({ button: "right" });
  await page.keyboard.press("t");
  await expect.poll(() => rowsText(page)).toEqual(["f.txt"]);
  await expect(selectedLabel(page)).toHaveText("f.txt");
  await expect(page.locator('#tree-viewport [aria-selected="true"]')).toContainText("d/d/d");
});

test("show in tree does not read the names of a large folder", async ({ page }) => {
  const count = 100_000;
  const entries: [string, number][] = Array.from({ length: count }, (_, index) => {
    const id = String(index).padStart(6, "0");
    return [`dir${id}/f${id}.txt`, 0];
  });
  // Count the names that the page decodes. The store reader decodes each
  // name with a TextDecoder.
  await page.addInitScript(() => {
    const scope = window as unknown as { decoded: number };
    scope.decoded = 0;
    const decode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = function (...args) {
      scope.decoded++;
      return decode.apply(this, args);
    };
  });
  await open(page, entries, BigInt(count));
  await page.locator("#search-input").fill("f099999.txt");
  await expect.poll(() => rowsText(page)).toEqual(["dir099999/f099999.txt"]);
  const decoded = () => page.evaluate(() => (window as unknown as { decoded: number }).decoded);
  const before = await decoded();
  await tableRows(page).first().click({ button: "right" });
  await page.keyboard.press("t");
  await expect.poll(() => rowsText(page)).toEqual(["f099999.txt"]);
  await expect(selectedLabel(page)).toHaveText("f099999.txt");
  // The folder comes from the worker. The page decodes only the names of
  // the rows that it shows, not the 100,000 names of the archive.
  expect((await decoded()) - before).toBeLessThan(1000);
});

test("an open folder with many child folders is made in steps", async ({ page }) => {
  const count = 100_000;
  const entries: [string, number][] = Array.from({ length: count }, (_, index) => [
    `big/d${String(count - index).padStart(6, "0")}/x`,
    0,
  ]);
  entries.push(["other/x", 0], ["other/y/z", 0]);
  await open(page, entries, BigInt(entries.length));
  await page.locator('#list-viewport [data-column="name"] button').click();
  await expect(grid(page)).toHaveAttribute("aria-rowcount", "3");
  await page.evaluate(() => performance.clearMeasures("zipscope:view-request"));
  const big = tableRows(page).filter({ hasText: "big/" }).first();
  // At once, a tree request. The tree shows the 100,000 folders of
  // `big`, so its first row is the one on the screen.
  await clickInOneTask(page, [
    big.locator('[data-part="toggle"]'),
    page
      .locator("#tree-viewport [role=treeitem]:not([hidden])")
      .first()
      .locator('[data-part="toggle"]'),
  ]);
  await expect(grid(page)).toHaveAttribute("aria-rowcount", String(count + 3));
  await expect(tableRows(page).nth(1)).toContainText("d000001/");
  await expectTreeRequestBetweenSteps(page);
});

for (const preview of [false, true]) {
  test(`Tab goes through the grid in one line, preview ${preview ? "open" : "closed"}`, async ({
    page,
    browserName,
  }) => {
    // WebKit on macOS skips buttons with Tab by default (the system
    // setting "Press Tab to highlight each item"). The order is the order
    // of the document, which the other browsers check.
    test.skip(browserName === "webkit", "Tab skips buttons in WebKit on macOS");
    await page.setViewportSize({ width: 1440, height: 800 });
    await open(page, ENTRIES);
    if (preview) {
      await page.locator("#preview-button").click();
      await expect(page.locator("#preview-pane")).toBeVisible();
    }
    /** A name for the focused element. */
    const focused = () =>
      page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (element === null || element === document.body) {
          return "body";
        }
        const header = element.closest<HTMLElement>("[role=columnheader]");
        if (header !== null) {
          return `sort:${header.dataset.column}`;
        }
        return element.id === "" ? element.tagName : `#${element.id}`;
      });
    const headers = await page
      // The Entries header has no sort button.
      .locator("#list-viewport [role=columnheader]:not([hidden]):has(button)")
      .evaluateAll((cells) => cells.map((cell) => `sort:${(cell as HTMLElement).dataset.column}`));
    await page.locator("#preview-button").focus();
    const forward: string[] = [];
    for (let step = 0; step < headers.length + 2; step++) {
      await page.keyboard.press("Tab");
      forward.push(await focused());
    }
    // The rows first, then the sort buttons, then a control after the grid.
    expect(forward.slice(0, headers.length + 1), JSON.stringify(forward)).toEqual([
      "#list-viewport",
      ...headers,
    ]);
    // A control after the grid takes the focus from the last sort button.
    // When the page has none (the preview is closed), the focus goes to the
    // browser, so the browsers differ there.
    const next = await page.evaluate(() => {
      const grid = document.getElementById("list-viewport")!;
      return [...document.querySelectorAll<HTMLElement>("button, input, [tabindex]")].some(
        (element) =>
          element.tabIndex >= 0 &&
          !element.closest("[inert]") &&
          element.checkVisibility() &&
          (grid.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
          !grid.contains(element),
      );
    });
    expect(next).toBe(preview);
    if (next) {
      const after = forward.at(-1)!;
      expect(after.startsWith("sort:"), JSON.stringify(forward)).toBe(false);
      expect(after, JSON.stringify(forward)).not.toBe("#list-viewport");
      expect(
        await page.evaluate(() => document.activeElement?.closest("#list-viewport") === null),
      ).toBe(true);
    }
    // Shift+Tab from the last sort button goes back the same way.
    await page.locator(`#list-viewport [data-column="${headers.at(-1)!.slice(5)}"] button`).focus();
    const backward: string[] = [];
    for (let step = 0; step < headers.length + 1; step++) {
      await page.keyboard.press("Shift+Tab");
      backward.push(await focused());
    }
    expect(backward).toEqual(
      headers.slice(0, -1).reverse().concat(["#list-viewport", "#preview-button"]),
    );
  });
}

test("an empty archive has a row count of the header only", async ({ page }) => {
  await open(page, []);
  await expect(grid(page)).toHaveAttribute("aria-rowcount", "1");
  // The table says that the archive is empty, in place of
  // a header with no rows.
  await expect(page.locator("#archive-empty")).toBeVisible();
  await expect(page.locator("#archive-empty")).toHaveText("This archive has no entries.");
  await expect(page.locator("#search-empty")).toBeHidden();
});

test("an archive with entries does not say that it is empty", async ({ page }) => {
  // Also a root with only empty folders: a folder entry is an entry.
  await open(page, [
    ["a/", 0],
    ["b/", 0],
  ]);
  await expect(tableRows(page)).toHaveCount(2);
  await expect(page.locator("#archive-empty")).toBeHidden();
  // A search with no result says "No names match", not that the archive
  // is empty.
  await page.locator("#search-input").fill("zzz");
  await expect(page.locator("#search-empty")).toHaveText("No names match");
  await expect(page.locator("#archive-empty")).toBeHidden();
});

test("the status bar uses the singular for one entry", async ({ page }) => {
  await open(page, [["one.txt", 1]]);
  await expect(page.locator("#entries-listed")).toHaveText("1 entry listed");
  await expect(page.locator("#entries-listed")).toHaveAttribute("title", "1 entry listed");
  await open(page, [
    ["one.txt", 1],
    ["two.txt", 2],
  ]);
  await expect(page.locator("#entries-listed")).toHaveText("2 entries listed");
});

test("an empty folder says so", async ({ page }) => {
  // An archive whose only entry is one folder opens in that folder.
  await open(page, [["only/", 0]]);
  await expect(page.locator("#folder-empty")).toBeVisible();
  await expect(page.locator("#folder-empty")).toHaveText("This folder is empty.");
  await expect(page.locator("#archive-empty")).toBeHidden();
});

test("an empty folder below the root says so, and the root does not", async ({ page }) => {
  await open(page, [
    ["a/", 0],
    ["b.txt", 1],
  ]);
  await expect(tableRows(page)).toHaveCount(2);
  await expect(page.locator("#folder-empty")).toBeHidden();
  await tableRows(page).filter({ hasText: "a/" }).click();
  await expect(tableRows(page)).toHaveCount(0);
  await expect(page.locator("#folder-empty")).toBeVisible();
  await expect(page.locator("#archive-empty")).toBeHidden();
});

test("a large folder opens in place in steps, and other requests do not wait", async ({ page }) => {
  const count = 340_000;
  // Names in reverse order, so the name sort has work to do.
  const entries: [string, number][] = Array.from({ length: count }, (_, index) => [
    `big/f${String(count - index).padStart(6, "0")}`,
    0,
  ]);
  entries.push(["other/x", 0], ["other/y/z", 0]);
  await open(page, entries, BigInt(entries.length));
  await page.locator('#list-viewport [data-column="name"] button').click();
  await expect(grid(page)).toHaveAttribute("aria-rowcount", "3");
  await page.evaluate(() => performance.clearMeasures("zipscope:view-request"));
  const big = tableRows(page).filter({ hasText: "big/" }).first();
  // At once, a tree request: it runs between the steps of the build.
  await clickInOneTask(page, [
    big.locator('[data-part="toggle"]'),
    page
      .locator("#tree-viewport [role=treeitem]", { hasText: "other" })
      .locator('[data-part="toggle"]'),
  ]);
  await expect(grid(page)).toHaveAttribute("aria-rowcount", String(count + 3));
  await expect(tableRows(page).nth(1)).toContainText("f000001");
  await expectTreeRequestBetweenSteps(page);
});

test("above 8M px the grid scrolls scaled to the last row and to an index", async ({ page }) => {
  // 340,000 rows of 24 px pass the 8M px cap.
  const count = 340_000;
  const entries: [string, number][] = Array.from({ length: count }, (_, index) => [
    `f${String(index).padStart(6, "0")}`,
    0,
  ]);
  await open(page, entries, BigInt(count));
  const table = grid(page);
  await expect(table).toHaveAttribute("aria-rowcount", String(count + 1));
  const spacer = await table.evaluate((element) =>
    Math.round((element.children[1] as HTMLElement).getBoundingClientRect().height),
  );
  expect(spacer).toBe(8_000_000);
  /** The row that shows its whole height at the bottom of the grid. */
  const lastShown = () =>
    table.evaluate((element) => {
      const bottom = element.getBoundingClientRect().bottom;
      const rows = [...element.querySelectorAll<HTMLElement>("[data-row]:not([hidden])")];
      const inside = rows.filter((row) => row.getBoundingClientRect().bottom <= bottom + 0.5);
      return Math.max(...inside.map((row) => Number(row.dataset.row)));
    });

  await table.focus();
  await page.keyboard.press("End");
  await expect(selectedLabel(page)).toHaveText("f339999");
  await expect.poll(lastShown).toBe(count - 1);
  await expect(
    page.locator(`#list-viewport [aria-rowindex="${count + 1}"]:not([hidden])`),
  ).toBeVisible();
  // Up by one stays near the end, as native scrolling would.
  await page.keyboard.press("ArrowUp");
  await expect(selectedLabel(page)).toHaveText("f339998");
  await page.keyboard.press("Home");
  await expect(selectedLabel(page)).toHaveText("f000000");
  await expect(tableRows(page).filter({ hasText: "f000000" })).toBeInViewport();

  // A wheel step moves by rows, not by scaled pixels.
  await table.hover();
  await page.mouse.wheel(0, 24 * 10);
  await expect
    .poll(() =>
      table.evaluate((element) => {
        const top = element.getBoundingClientRect().top + 28;
        const rows = [...element.querySelectorAll<HTMLElement>("[data-row]:not([hidden])")];
        const first = rows.find((row) => Math.abs(row.getBoundingClientRect().top - top) < 1);
        return Number(first?.dataset.row);
      }),
    )
    .toBe(10);

  // Show in tree of a deep search result scrolls to its index.
  await page.locator("#search-input").fill("f300000");
  await expect.poll(() => rowsText(page)).toEqual(["f300000"]);
  await tableRows(page).first().click({ button: "right" });
  await page.keyboard.press("t");
  await expect(selectedLabel(page)).toHaveText("f300000");
  await expect(tableRows(page).filter({ hasText: "f300000" })).toBeInViewport();
});
