/*
ASSUMED UI (largest files under a folder)

- #largest-files is the part of the list pane below the rows of the
  listing. It shows only when the listing is shorter than the table. It
  is hidden (or absent) when the listing fills the table, during a search,
  and when the subtree has no files.
- Its rows are `#largest-files [data-row]:not([hidden])`, at most ten, in
  rank order. `[data-part="label"]` of a row is the full path of the entry
  (as a search result shows it).
- A click on a row opens the preview, as for a row of the listing. The row
  menu (right click) is #row-menu with the same items, also
  `[data-action="extract"]` and `[data-action="show-in-tree"]`.
- A refused request for the largest files (the hard stop, or the test hook
  `__zipscopeTestRefuseViews`) does not show rows, does not change the
  listing, and is not an uncaught error.

The rank rules are pinned in crates/core/tests/hostile_largest.rs: declared
uncompressed size, largest first, equal sizes in archive order, files
only (no folder rows).

Names may change. Record a reason for a change to an expected result.

Changes for the implementation:

- The block is not a separate part: its rows are rows of the grid (the
  same row pool), so that they have the grid semantics, the keys and the
  selection of other rows. Thus the section is the label row
  (`[data-kind="heading"]`) and the rows are `[data-block="true"]`.
- The label of a row is the path below the listed folder, so the name
  column shows the part that differs; the title of the label is the full
  path. `largestLabels` reads the titles. The rows of a pool are not in
  row order in the DOM, so it sorts them by `data-row`.
- `tableRows` is the rows of the listing only: it leaves out the label row
  and the rows of the block, which are in the same grid.
- "A subtree with folders only": the tree row of `empty` is the compact
  chain `empty/a/b`, which lists `b`, a folder with no rows. Thus the
  test waits for the location, not for a first row.
- "previews, extracts": `big.bin` has more than 100 times its compressed
  size. It is
  smaller than 16 MiB, so it is not bomb-like, and the download starts
  with no question.
- A flat folder has no subfolder where space
  can hide, so the block would only repeat the listing. Thus `twelve/` and
  `other/` show no block, and the fit check of the window size uses the
  nested folder `src/`.
- The block leaves out the direct
  entries of the listed folder, because they are rows of the listing
  already. Thus `SRC_BLOCK` is `SRC_TOP` without `src/stored.bin`,
  `src/tie-1.txt` and `src/tie-3.txt` (7 rows), and the root
  block has no `README.md` (9 rows, not 10). The ranking of the core does
  not change: crates/core/tests/hostile_largest.rs still pins it, and the UI
  applies the rule where it shows the block. The other rules of the block
  (5% of the folder, only after the parse) do not change these results:
  `big.bin` holds more than 5% of `src/` and of the root.
- The block is a view of the listed folder, not a request of its own, so
  no request for it can be refused. The refusal test now refuses the first
  folder request: the listing and its block stay as they were (a refused
  request leaves the shown state).
*/
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { contentZip } from "./content-zip";
import type { ContentEntry } from "./content-zip";
import { openArchive, waitForOutcome } from "./listing";

const text = (bytes: number, word = "zipscope ") =>
  Buffer.from(word.repeat(Math.ceil(bytes / word.length)).slice(0, bytes));

/** Sizes are distinct, except the three "tie" files. */
const ENTRIES: ContentEntry[] = [
  { name: "README.md", data: text(90_000) },
  { name: "src/main.rs", data: text(1_000) },
  { name: "src/lib/a.rs", data: text(5_000) },
  { name: "src/lib/b.rs", data: text(6_000) },
  { name: "src/lib/deep/x/y/z/big.bin", data: text(80_000, "big ") },
  { name: "src/tie-1.txt", data: text(3_000, "1") },
  { name: "src/lib/tie-2.txt", data: text(3_000, "2") },
  { name: "src/tie-3.txt", data: text(3_000, "3") },
  { name: "src/test/t1.rs", data: text(7_000) },
  { name: "src/test/t2.rs", data: text(2_000) },
  { name: "src/test/t3.rs", data: text(4_000) },
  { name: "src/test/t4.rs", data: text(500) },
  { name: "src/test/t5.rs", data: text(100) },
  // An explicit folder row is not a file.
  { name: "src/test/", data: Buffer.alloc(0), method: 0 },
  { name: "src/stored.bin", data: text(9_000, "s"), method: 0 },
  { name: "other/only.txt", data: text(10) },
  { name: "empty/", data: Buffer.alloc(0), method: 0 },
  { name: "empty/a/", data: Buffer.alloc(0), method: 0 },
  { name: "empty/a/b/", data: Buffer.alloc(0), method: 0 },
  ...Array.from({ length: 300 }, (_, index) => ({
    name: `many/f${String(index).padStart(3, "0")}.txt`,
    data: text(10 + index),
  })),
  ...Array.from({ length: 12 }, (_, index) => ({
    name: `twelve/f${String(index).padStart(2, "0")}.txt`,
    data: text(100 + index),
  })),
];

const SRC_TOP = [
  "src/lib/deep/x/y/z/big.bin",
  "src/stored.bin",
  "src/test/t1.rs",
  "src/lib/b.rs",
  "src/lib/a.rs",
  "src/test/t3.rs",
  "src/tie-1.txt",
  "src/lib/tie-2.txt",
  "src/tie-3.txt",
  "src/test/t2.rs",
];

/** `SRC_TOP` without the direct entries of `src/`. */
const SRC_BLOCK = SRC_TOP.filter(
  (name) => !["src/stored.bin", "src/tie-1.txt", "src/tie-3.txt"].includes(name),
);

async function open(page: Page, init?: () => void) {
  if (init !== undefined) await page.addInitScript(init);
  const file = test.info().outputPath("largest.zip");
  writeFileSync(file, contentZip(ENTRIES));
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
}

const tableRows = (page: Page) =>
  page.locator(
    '#list-viewport [data-row]:not([hidden]):not([data-block]):not([data-kind="heading"])',
  );
const section = (page: Page) => page.locator('#list-viewport [data-kind="heading"]:not([hidden])');
const largestRows = (page: Page) =>
  page.locator('#list-viewport [data-block="true"]:not([hidden])');
const largestLabels = async (page: Page) =>
  (await section(page).isVisible())
    ? largestRows(page).evaluateAll((rows) =>
        rows
          .map((row) => ({
            index: Number((row as HTMLElement).dataset.row),
            path: (row.querySelector('[data-part="label"]') as HTMLElement | null)?.title ?? "",
          }))
          .sort((a, b) => a.index - b.index)
          .map((row) => row.path),
      )
    : [];

/** Lists a folder of the root from the tree. */
async function list(page: Page, name: string) {
  await page.locator("#tree-viewport [role=treeitem]", { hasText: name }).first().click();
  await expect(page.locator("#location")).toContainText(name);
}

test("a short listing shows the ten largest files of its whole subtree", async ({ page }) => {
  await open(page);
  await list(page, "src");
  // The ten largest, less the direct entries of src/.
  await expect.poll(() => largestLabels(page)).toEqual(SRC_BLOCK);
  // Folders and the explicit row of src/test/ do not show.
  await expect(largestRows(page)).toHaveCount(SRC_BLOCK.length);
  // The same answer after a sort of the listing.
  await page
    .locator("#list-viewport [role=columnheader][data-column=name]")
    .getByRole("button")
    .click();
  await expect.poll(() => largestLabels(page)).toEqual(SRC_BLOCK);
});

test("the root counts every file of the archive", async ({ page }) => {
  await open(page);
  // README.md is a direct entry of the root, so the block leaves it out:
  // 9 of the ten largest.
  await expect
    .poll(async () => (await largestLabels(page)).slice(0, 3))
    .toEqual(["src/lib/deep/x/y/z/big.bin", "src/stored.bin", "src/test/t1.rs"]);
  const labels = await largestLabels(page);
  expect(labels).toHaveLength(9);
});

test("a listing that fills the table hides the files, and only that rule moves them", async ({
  page,
}) => {
  await open(page);
  await list(page, "many");
  await expect(tableRows(page).first()).toBeVisible();
  await expect(section(page)).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 2000 });
  await expect(section(page)).toBeHidden();

  await page.setViewportSize({ width: 1440, height: 900 });
  // A flat folder has no subfolder where space can hide. The block would
  // only repeat the listing.
  await list(page, "twelve");
  await expect(tableRows(page)).toHaveCount(12);
  await expect(section(page)).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1600 });
  await expect(section(page)).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });

  // A nested folder of 6 rows: only the fit rule moves its block.
  await list(page, "src");
  const expected = SRC_BLOCK;
  await expect.poll(() => largestLabels(page)).toEqual(expected);
  // A taller window does not show more than ten.
  await page.setViewportSize({ width: 1440, height: 1600 });
  await expect.poll(() => largestLabels(page)).toEqual(expected);
  // A window where the listing and the block do not fit hides them.
  await page.setViewportSize({ width: 1440, height: 320 });
  await expect(section(page)).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => largestLabels(page)).toEqual(expected);
});

test("a subtree with folders only shows no files", async ({ page }) => {
  await open(page);
  await list(page, "empty");
  await expect(page.locator("#location")).toContainText("b");
  await expect.poll(() => largestRows(page).count()).toBe(0);
});

test("the files follow the listed folder and leave during a search", async ({ page }) => {
  await open(page);
  await list(page, "src");
  await expect.poll(() => largestLabels(page)).toEqual(SRC_BLOCK);
  // A flat folder has no subfolder where space can hide. The block would
  // only repeat the listing.
  await list(page, "other");
  await expect(tableRows(page)).toHaveCount(1);
  await expect(section(page)).toBeHidden();
  await page.locator("#search-input").fill("t");
  await expect.poll(() => tableRows(page).count()).toBeGreaterThan(0);
  await expect(section(page)).toBeHidden();
});

test.describe(() => {
  // The download streams through the service worker.
  test.use({ serviceWorkers: "allow" });

  test("a row of the files previews, extracts and shows in the tree", async ({ page }) => {
    await page.addInitScript(() => {
      for (const name of ["showSaveFilePicker", "showDirectoryPicker"]) {
        Object.defineProperty(window, name, { value: undefined, configurable: true });
      }
    });
    await open(page);
    await list(page, "src");
    const big = largestRows(page).filter({ hasText: "big.bin" });
    await expect(big).toHaveCount(1);

    // A click only selects; a double-click opens the preview.
    await big.dblclick();
    await expect(page.locator('#preview-meta [data-field="path"]')).toHaveText(
      "src/lib/deep/x/y/z/big.bin",
    );
    const download = page.waitForEvent("download");
    await page.locator("#preview-extract").click();
    const file = await download;
    await expect(page.locator("#extract-warnings")).toHaveCount(0);
    expect(file.suggestedFilename()).toBe("big.bin");

    await big.click({ button: "right" });
    await expect(page.locator('#row-menu [data-action="extract"]')).toBeVisible();
    await page.locator('#row-menu [data-action="show-in-tree"]').click();
    await expect(page.locator('#tree-viewport [aria-selected="true"]')).toContainText("z");
    await expect(tableRows(page).filter({ hasText: "big.bin" })).toHaveCount(1);
  });
});

test("the block of the largest files does not blink when the list height changes", async ({
  page,
}) => {
  await open(page);
  // 9 rows: README.md is a direct entry of the root.
  await expect.poll(async () => (await largestLabels(page)).length).toBe(9);
  // At each animation frame, count the frames where the painted table has
  // no row of the block. A resize observer that hides the rows and draws
  // them on the next frame leaves one such frame.
  await page.evaluate(() => {
    const state = { frames: 0, empty: 0, live: true };
    Object.assign(window, { __blink19: state });
    const check = () => {
      if (!state.live) return;
      state.frames++;
      const rows = document.querySelectorAll('#list-viewport [data-block="true"]:not([hidden])');
      if (rows.length === 0) state.empty++;
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  for (const height of [860, 900, 840, 900]) {
    await page.setViewportSize({ width: 1440, height });
    await page.waitForTimeout(100);
  }
  const state = await page.evaluate(() => {
    const value = (
      window as unknown as { __blink19: { frames: number; empty: number; live: boolean } }
    ).__blink19;
    value.live = false;
    return value;
  });
  expect(state.frames).toBeGreaterThan(10);
  expect(state.empty).toBe(0);
});

test("a refused request keeps the listing and its files", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, () => {
    (globalThis as { __zipscopeTestRefuseViews?: string }).__zipscopeTestRefuseViews = "folder";
  });
  // 9 rows: README.md is a direct entry of the root.
  await expect.poll(async () => (await largestLabels(page)).length).toBe(9);
  const files = await largestLabels(page);
  const before = await tableRows(page).locator('[data-part="label"]').allTextContents();
  expect(before.length).toBeGreaterThan(0);
  // The worker refuses the folder request: no files of src/ show.
  await page.locator("#tree-viewport [role=treeitem]", { hasText: "src" }).first().click();
  await expect(page.locator("#view-refused")).not.toBeEmpty();
  expect(await largestLabels(page)).toEqual(files);
  expect(await tableRows(page).locator('[data-part="label"]').allTextContents()).toEqual(before);
  expect(errors).toEqual([]);
});
