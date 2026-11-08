// Sort by column headers and search of all names.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { heldWorkers, holdableWorkers, holdWorkers, releaseWorkers } from "./hold";
import { openArchive, waitForOutcome, LISTING_ROWS } from "./listing";
import { storedZip } from "./stored-zip";

async function open(page: Page, entries: [string, number][]) {
  const file = test.info().outputPath("sort.zip");
  writeFileSync(file, storedZip(entries));
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
}

const tableRows = (page: Page) => page.locator(LISTING_ROWS);
const labels = (page: Page) => tableRows(page).locator('[data-part="label"]').allTextContents();
const header = (page: Page, column: string) =>
  page.locator(`#list-viewport [role=columnheader][data-column=${column}]`);

const ENTRIES: [string, number][] = [
  ["b.txt", 30],
  ["docs/README.md", 5],
  ["A.txt", 10],
  ["src/readme.rs", 50],
  ["c.TXT", 20],
  ["docs/guide.md", 1],
];

test("column headers sort folders first, then entries", async ({ page }) => {
  await open(page, ENTRIES);
  // Size, from the largest, with an arrow.
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => labels(page)).toEqual(["src/", "docs/", "b.txt", "c.TXT", "A.txt"]);
  await header(page, "name").getByRole("button").click();
  await expect(header(page, "name")).toHaveAttribute("aria-sort", "ascending");
  await expect.poll(() => labels(page)).toEqual(["docs/", "src/", "A.txt", "b.txt", "c.TXT"]);
  await header(page, "name").getByRole("button").click();
  await expect(header(page, "name")).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => labels(page)).toEqual(["src/", "docs/", "c.TXT", "b.txt", "A.txt"]);
  // Size starts from the largest. Folders sort by their rolled-up size.
  await header(page, "size").getByRole("button").click();
  await expect(header(page, "name")).not.toHaveAttribute("aria-sort");
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => labels(page)).toEqual(["src/", "docs/", "b.txt", "c.TXT", "A.txt"]);
  // The third activation returns to archive order.
  await header(page, "size").getByRole("button").click();
  await header(page, "size").getByRole("button").click();
  await expect(header(page, "size")).not.toHaveAttribute("aria-sort");
  await expect.poll(() => labels(page)).toEqual(["docs/", "src/", "b.txt", "A.txt", "c.TXT"]);
});

test("the Name sort orders numbers by value, in both directions", async ({ page }) => {
  await open(page, [
    ["file10", 1],
    ["dir10/a", 1],
    ["file2", 1],
    ["dir9/a", 1],
    ["File3", 1],
    ["Dir2/a", 1],
    ["file01", 1],
    ["dir01/a", 1],
    ["file1", 1],
    ["dir1/a", 1],
  ]);
  const button = header(page, "name").getByRole("button");
  await button.click();
  await expect(header(page, "name")).toHaveAttribute("aria-sort", "ascending");
  const up = [
    "dir01/",
    "dir1/",
    "Dir2/",
    "dir9/",
    "dir10/",
    "file01",
    "file1",
    "file2",
    "File3",
    "file10",
  ];
  await expect.poll(() => labels(page)).toEqual(up);
  await button.click();
  await expect(header(page, "name")).toHaveAttribute("aria-sort", "descending");
  const down = [...up.slice(0, 5).reverse(), ...up.slice(5).reverse()];
  await expect.poll(() => labels(page)).toEqual(down);
  // Back lists the folder again in the worker, and gets the same order.
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])", { hasText: "dir10" }).click();
  await expect.poll(() => labels(page)).toEqual(["a"]);
  await page.goBack();
  await expect(header(page, "name")).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => labels(page)).toEqual(down);
  // The tree has its own order, which the sort of the table does not change:
  // the same comparison, from the first name to the last.
  const tree = page.locator('#tree-viewport [role=treeitem]:not([hidden]) [data-part="label"]');
  await expect
    .poll(() => tree.allTextContents())
    .toEqual([expect.anything(), "dir01", "dir1", "Dir2", "dir9", "dir10"]);
  // A search uses the order too, but its match does not change.
  await page.locator("#search-input").fill("FILE");
  await expect.poll(() => labels(page)).toEqual(down.slice(5));
});

test("the header shows a sort while it runs, and the history records it after", async ({
  page,
}) => {
  await holdableWorkers(page);
  await open(page, ENTRIES);
  await holdWorkers(page);
  await header(page, "name").getByRole("button").click();
  // The sort waits for the worker. The header and the status show it, but
  // the listing and the history entry do not change yet.
  await expect(header(page, "name")).toHaveAttribute("aria-sort", "ascending");
  // The listing keeps the default sort,
  // and the status shows after a short wait, so a short sort does not flash.
  await expect(page.locator("#sort-status")).toHaveText("Sorting…");
  expect(await labels(page)).toEqual(["src/", "docs/", "b.txt", "c.TXT", "A.txt"]);
  expect(await page.evaluate(() => (history.state as { sort: unknown }).sort)).toBeNull();
  await releaseWorkers(page);
  await expect.poll(() => labels(page)).toEqual(["docs/", "src/", "A.txt", "b.txt", "c.TXT"]);
  await expect(header(page, "name")).toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator("#sort-status")).toHaveText("");
  await expect
    .poll(() => page.evaluate(() => (history.state as { sort: unknown }).sort))
    .toEqual({ column: 1, descending: false });
});

test("two overlapping sorts that resolve in reverse order end on the last sort", async ({
  page,
}) => {
  await holdableWorkers(page);
  await open(page, ENTRIES);
  await holdWorkers(page);
  await header(page, "name").getByRole("button").click();
  await expect(header(page, "name")).toHaveAttribute("aria-sort", "ascending");
  // The last sort is Compressed, because
  // Size from the largest is the default and changes nothing.
  await header(page, "compressed").getByRole("button").click();
  await expect(header(page, "compressed")).toHaveAttribute("aria-sort", "descending");
  // The worker answered both sorts. The reply of the last sort comes first.
  await expect.poll(() => heldWorkers(page)).toBeGreaterThanOrEqual(2);
  await releaseWorkers(page, true);
  await expect(page.locator("#sort-status")).toHaveText("");
  await expect.poll(() => labels(page)).toEqual(["src/", "docs/", "b.txt", "c.TXT", "A.txt"]);
  await expect(header(page, "compressed")).toHaveAttribute("aria-sort", "descending");
  await expect(header(page, "name")).not.toHaveAttribute("aria-sort");
  await expect
    .poll(() => page.evaluate(() => (history.state as { sort: unknown }).sort))
    .toEqual({ column: 3, descending: true });
  // The next activation starts from the sort that shows.
  await header(page, "compressed").getByRole("button").click();
  await expect(header(page, "compressed")).toHaveAttribute("aria-sort", "ascending");
});

test("search lists full paths from the whole archive, without ASCII case", async ({ page }) => {
  await open(page, ENTRIES);
  const search = page.locator("#search-input");
  // `/` focuses the search field.
  await page.locator("body").click();
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await page.keyboard.type("readme");
  await expect.poll(() => labels(page)).toEqual(["src/readme.rs", "docs/README.md"]);
  // With no sort chosen, no header has the order of the
  // search, so the first activation goes to the first direction. Then the
  // other direction, then archive order.
  await header(page, "size").getByRole("button").click();
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => labels(page)).toEqual(["src/readme.rs", "docs/README.md"]);
  await header(page, "size").getByRole("button").click();
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "ascending");
  await expect.poll(() => labels(page)).toEqual(["docs/README.md", "src/readme.rs"]);
  await header(page, "size").getByRole("button").click();
  await expect(header(page, "size")).not.toHaveAttribute("aria-sort");
  await expect.poll(() => labels(page)).toEqual(["docs/README.md", "src/readme.rs"]);
  await header(page, "size").getByRole("button").click();
  await expect.poll(() => labels(page)).toEqual(["src/readme.rs", "docs/README.md"]);
  await page.keyboard.press("/");
  await search.fill("xyz");
  await expect(page.locator("#search-empty")).toHaveText("No names match");
  await expect(tableRows(page)).toHaveCount(0);
  // Escape clears the search and lists the folder again.
  await search.focus();
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page.locator("#search-empty")).toBeHidden();
  await expect.poll(() => labels(page)).toEqual(["src/", "docs/", "b.txt", "c.TXT", "A.txt"]);
  // A second Escape leaves the field.
  await page.keyboard.press("Escape");
  await expect(search).not.toBeFocused();
});

test("selecting a folder in the tree leaves the search", async ({ page }) => {
  await open(page, ENTRIES);
  await page.locator("#search-input").fill("md");
  await expect.poll(() => labels(page)).toEqual(["docs/README.md", "docs/guide.md"]);
  await page
    .locator("#tree-viewport [role=treeitem]")
    .filter({ hasText: "docs" })
    .locator('[data-part="label"]')
    .click();
  await expect(page.locator("#search-input")).toHaveValue("");
  await expect.poll(() => labels(page)).toEqual(["README.md", "guide.md"]);
});

for (const width of [1440, 1000, 390]) {
  test(`search works in the header at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page, ENTRIES);
    const search = page.locator("#search-slot #search-input");
    await expect(search).toBeVisible();
    const box = (await search.boundingBox())!;
    expect(box.width).toBeGreaterThan(80);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await search.fill("readme");
    await expect.poll(() => labels(page)).toEqual(["src/readme.rs", "docs/README.md"]);
    // The first activation goes to the first direction.
    await header(page, "size").getByRole("button").click();
    await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
    await header(page, "size").getByRole("button").click();
    await expect.poll(() => labels(page)).toEqual(["docs/README.md", "src/readme.rs"]);
    await search.focus();
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
  });
}

test("a new search says Searching, also from a folder with an arrow", async ({ page }) => {
  await holdableWorkers(page);
  await open(page, ENTRIES);
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  await holdWorkers(page);
  await page.locator("#search-input").fill("readme");
  // The status shows after a short wait, so a short search does not flash.
  await expect(page.locator("#sort-status")).toHaveText("Searching…");
  await releaseWorkers(page);
  await expect(page.locator("#sort-status")).toHaveText("Best match");
});

test("the third step of the header cycle says Sorting", async ({ page }) => {
  await holdableWorkers(page);
  await open(page, ENTRIES);
  const size = header(page, "size");
  await size.getByRole("button").click();
  await expect(size).toHaveAttribute("aria-sort", "ascending");
  await holdWorkers(page);
  await size.getByRole("button").click();
  await expect(size).not.toHaveAttribute("aria-sort");
  await expect(page.locator("#sort-status")).toHaveText("Sorting…");
  await releaseWorkers(page);
  await expect(page.locator("#sort-status")).toHaveText("");
});

test("a search does not stay as the status after another file opens", async ({ page }) => {
  await open(page, ENTRIES);
  await page.locator("#search-input").fill("readme");
  await expect.poll(() => labels(page)).toEqual(["src/readme.rs", "docs/README.md"]);
  // The status tells the order of the results.
  await expect(page.locator("#sort-status")).toHaveText("Best match");
  // Open a second file while the search shows.
  const file = test.info().outputPath("second.zip");
  writeFileSync(
    file,
    storedZip([
      ["x.txt", 1],
      ["y.txt", 2],
    ]),
  );
  await openArchive(page, file);
  await expect(page.locator("#search-input")).toHaveValue("");
  await expect.poll(() => labels(page)).toEqual(["y.txt", "x.txt"]);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  await expect(page.locator("#sort-status")).toHaveText("");
});
