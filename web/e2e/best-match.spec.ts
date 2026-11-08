// The best-match order of search results: while a query is active and the user
// chose no sort, the tier of a name comes first (see `Tier` in
// crates/core/src/query.rs).
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { holdableWorkers, holdWorkers, releaseWorkers } from "./hold";
import { LISTING_ROWS, openArchive, waitForOutcome } from "./listing";
import { gate, pauseBetweenBatches } from "./parse-gate";
import { storedZip } from "./stored-zip";

const labels = (page: Page) =>
  page.locator(LISTING_ROWS).locator('[data-part="label"]').allTextContents();
const header = (page: Page, column: string) =>
  page.locator(`#list-viewport [role=columnheader][data-column=${column}]`);
const status = (page: Page) => page.locator("#sort-status");
const search = (page: Page) => page.locator("#search-input");
const keptSort = (page: Page) =>
  page.evaluate(() => (history.state as { sort: unknown } | null)?.sort);
const arrows = (page: Page) => page.locator("#list-viewport [role=columnheader][aria-sort]");

/** The exact file is the smallest, so the Size order has it last. */
const ENTRIES: [string, number][] = [
  ["big/readme.md.bak", 900],
  ["docs/readme.md", 1],
  ["old-readme.md", 500],
  ["readme.md/inner.txt", 700],
  ["other.txt", 50],
];
const BEST = ["docs/readme.md", "big/readme.md.bak", "old-readme.md", "readme.md/inner.txt"];
const BY_SIZE = ["big/readme.md.bak", "readme.md/inner.txt", "old-readme.md", "docs/readme.md"];

async function open(page: Page, entries = ENTRIES, name = "best.zip") {
  const file = test.info().outputPath(name);
  writeFileSync(file, storedZip(entries));
  await page.goto("/");
  await openArchive(page, file);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
}

/** Opens `entries` with the parse held after its first rows. */
async function openHeld(page: Page, entries: [string, number][]) {
  await pauseBetweenBatches(page);
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");
  await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "true");
  await page.locator("#file-input").setInputFiles({
    name: "held.zip",
    mimeType: "application/zip",
    buffer: storedZip(entries),
  });
  await expect.poll(() => gate(page)).toBe(1);
  await gate(page, true);
  await expect.poll(() => gate(page)).toBe(2);
  await expect(page.locator("#row-count")).not.toHaveText("0");
}

/** Lets the parse run to its end. */
async function release(page: Page) {
  const listed = page.locator("#status").filter({ hasText: "Listed in" });
  await expect
    .poll(
      async () => {
        await gate(page, true);
        return listed.count();
      },
      { intervals: [10], timeout: 30_000 },
    )
    .toBe(1);
}

test("an exact match comes above a larger partial match, then a header click, then a clear", async ({
  page,
}) => {
  await open(page);
  await search(page).fill("README.MD");
  await expect.poll(() => labels(page)).toEqual(BEST);
  await expect(status(page)).toHaveText("Best match");
  await expect(status(page)).toBeVisible();
  // No column claims the order, and the grid has it in words.
  await expect(arrows(page)).toHaveCount(0);
  await expect(page.locator("#list-viewport")).toHaveAttribute("aria-describedby", "sort-status");
  expect(await keptSort(page)).toBeNull();
  // A header click sorts by that column, and it is a choice.
  await header(page, "size").getByRole("button").click();
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => labels(page)).toEqual(BY_SIZE);
  await expect(status(page)).toHaveText("");
  await expect(page.locator("#list-viewport")).not.toHaveAttribute("aria-describedby");
  await expect
    .poll(() => keptSort(page), { timeout: 3000 })
    .toEqual({ column: 2, descending: true });
  // The clear goes back to the folder, in the sort of the folder.
  await search(page).fill("");
  await expect
    .poll(() => labels(page))
    .toEqual(["big/", "readme.md/", "docs/", "old-readme.md", "other.txt"]);
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  await expect(status(page)).toHaveText("");
  // The choice stays for the next query.
  await search(page).fill("readme.md");
  await expect.poll(() => labels(page)).toEqual(BY_SIZE);
  await expect(status(page)).toHaveText("");
});

test("a clear with no choice goes back to the default sort", async ({ page }) => {
  await open(page);
  await search(page).fill("readme.md");
  await expect(status(page)).toHaveText("Best match");
  await search(page).fill("");
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  await expect(status(page)).toHaveText("");
  await expect.poll(() => labels(page)).toContain("other.txt");
  expect(await keptSort(page)).toBeNull();
  // The next query has the best match again.
  await search(page).fill("readme.md");
  await expect.poll(() => labels(page)).toEqual(BEST);
  await expect(status(page)).toHaveText("Best match");
  // A longer query moves rows to their new tiers.
  await search(page).fill("readme.md.");
  await expect.poll(() => labels(page)).toEqual(["big/readme.md.bak"]);
  // A search with no result says so, and it tells no order.
  await search(page).fill("no such name");
  await expect(page.locator("#search-empty")).toBeVisible();
  await expect(status(page)).toHaveText("");
});

test("archive order from the header cycle is a choice, also with a query", async ({ page }) => {
  await open(page);
  await search(page).fill("readme.md");
  await expect(status(page)).toHaveText("Best match");
  const button = header(page, "size").getByRole("button");
  await button.click();
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  await button.click();
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "ascending");
  await expect.poll(() => labels(page)).toEqual([...BY_SIZE].reverse());
  await button.click();
  await expect(arrows(page)).toHaveCount(0);
  const archive = ["big/readme.md.bak", "docs/readme.md", "old-readme.md", "readme.md/inner.txt"];
  await expect.poll(() => labels(page)).toEqual(archive);
  await expect(status(page)).toHaveText("");
  await expect
    .poll(() => keptSort(page), { timeout: 3000 })
    .toEqual({ column: 0, descending: false });
  // A new query keeps it, and a clear too.
  await search(page).fill("readme");
  await expect.poll(() => labels(page)).toEqual(archive);
  await expect(status(page)).toHaveText("");
  await search(page).fill("");
  await expect(arrows(page)).toHaveCount(0);
  await expect
    .poll(() => labels(page))
    .toEqual(["big/", "docs/", "readme.md/", "old-readme.md", "other.txt"]);
});

test("Back and Forward keep the choice, and the query brings its order", async ({ page }) => {
  await open(page);
  await search(page).fill("readme.md");
  await expect.poll(() => labels(page)).toEqual(BEST);
  // A folder of the tree leaves the search in a new entry.
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])", { hasText: "docs" }).click();
  await expect(search(page)).toHaveValue("");
  await expect(status(page)).toHaveText("");
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  await page.goBack();
  await expect(search(page)).toHaveValue("readme.md");
  await expect.poll(() => labels(page)).toEqual(BEST);
  await expect(status(page)).toHaveText("Best match");
  await expect(arrows(page)).toHaveCount(0);
  await page.goForward();
  await expect(search(page)).toHaveValue("");
  await expect(status(page)).toHaveText("");
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  // A choice in the folder stays through Back: it is a view setting.
  await header(page, "name").getByRole("button").click();
  await expect(header(page, "name")).toHaveAttribute("aria-sort", "ascending");
  await page.goBack();
  await expect(search(page)).toHaveValue("readme.md");
  await expect(header(page, "name")).toHaveAttribute("aria-sort", "ascending");
  await expect(status(page)).toHaveText("");
  await expect.poll(() => labels(page)).toEqual([...BY_SIZE].sort());
});

/** Rows for some batches, with the matches of all tiers, and the exact name
 *  in the last row. */
const MANY: [string, number][] = [
  ...Array.from({ length: 2048 }, (_, index): [string, number] => [
    `row-${String(index).padStart(4, "0")}-note.txt`,
    1 + (index % 97),
  ]),
  ["huge-note.txt", 100_000],
  ["z/note.txt", 1],
];

test("a query during the parse has the best match, and new rows go to their tiers", async ({
  page,
}) => {
  await openHeld(page, MANY);
  await expect(arrows(page)).toHaveCount(0);
  await search(page).fill("note.txt");
  await expect.poll(async () => (await labels(page))[0]).toMatch(/^row-.*-note\.txt$/);
  await expect(status(page)).toHaveText("Best match");
  await expect(arrows(page)).toHaveCount(0);
  // A selection of the user during the parse follows its row.
  const first = (await labels(page))[0]!;
  await page.locator(LISTING_ROWS).filter({ hasText: first }).click();
  const selected = page.locator(`${LISTING_ROWS}[aria-selected="true"]`);
  await expect(selected).toContainText(first);
  await release(page);
  // The exact name of the last row is first, then the prefix, then the rest.
  await expect.poll(async () => (await labels(page))[0]).toBe("z/note.txt");
  await expect(status(page)).toHaveText("Best match");
  await expect(arrows(page)).toHaveCount(0);
  // The selected row moved below the rows that came first, with its selection.
  await expect(selected).toContainText(first);
  await expect(selected).toHaveAttribute("aria-rowindex", "4");
  await page.locator("#list-viewport").focus();
  await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveAttribute("aria-rowindex", "5");
  // The landing of the default sort does not change the listing or the entry.
  expect(await keptSort(page)).toBeNull();
  await expect(page.locator("#row-count")).toHaveText("2,050");
  // The clear lists the folder in the default sort that landed below it.
  await search(page).fill("");
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  await expect(status(page)).toHaveText("");
  await expect.poll(async () => (await labels(page))[0]).toBe("z/");
});

test("a query before the default sort lands stays in the best match", async ({ page }) => {
  // More rows than the 16,384 that the worker sorts in one call, so the sort
  // lands in steps. The query goes in before the parse reads the last row.
  await openHeld(page, [
    ...Array.from({ length: 40_000 }, (_, index): [string, number] => [
      `r${index}.txt`,
      1 + (index % 97),
    ]),
    ["big-exact.txt", 50_000],
    ["exact.txt", 1],
  ]);
  await search(page).fill("exact.txt");
  await expect(status(page)).toHaveText("");
  await page.evaluate(() => {
    const seen: string[] = [];
    Object.assign(window, { sortStatus: seen });
    const text = document.getElementById("sort-status")!;
    new MutationObserver(() => seen.push(text.textContent ?? "")).observe(text, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  });
  await release(page);
  await expect.poll(() => labels(page)).toEqual(["exact.txt", "big-exact.txt"]);
  await expect(status(page)).toHaveText("Best match");
  await expect(arrows(page)).toHaveCount(0);
  // The status never said that a sort runs.
  expect(
    await page.evaluate(() =>
      (window as unknown as { sortStatus: string[] }).sortStatus.filter((text) =>
        text.startsWith("Sorting"),
      ),
    ),
  ).toEqual([]);
  // The worker holds the steps of the folder listing.
  await search(page).fill("");
  await expect
    .poll(
      async () => {
        await gate(page, true);
        return header(page, "size").getAttribute("aria-sort");
      },
      { intervals: [10], timeout: 30_000 },
    )
    .toBe("descending");
  await expect.poll(async () => (await labels(page))[0]).toBe("big-exact.txt");
});

test("the keys, the row menu and the preview follow the rows of the best match", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await open(page);
  await search(page).fill("readme.md");
  await expect.poll(() => labels(page)).toEqual(BEST);
  const row = page.locator(LISTING_ROWS).filter({ hasText: "docs/readme.md" });
  await row.click();
  const selected = page.locator(`${LISTING_ROWS}[aria-selected="true"]`);
  await expect(selected).toContainText("docs/readme.md");
  // The keys move in the order that shows.
  await page.locator("#list-viewport").focus();
  await page.keyboard.press("ArrowDown");
  await expect(selected).toContainText("big/readme.md.bak");
  // The preview opens the row that is selected, and follows the selection.
  await page.keyboard.press("Space");
  await expect(page.locator("#preview-pane")).toContainText("readme.md.bak");
  await page.keyboard.press("ArrowUp");
  await expect(selected).toContainText("docs/readme.md");
  await expect(page.locator("#preview-pane")).toContainText("docs/readme.md");
  // The row menu acts on the row, not on its index in another order.
  await page.locator(LISTING_ROWS).filter({ hasText: "old-readme.md" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Show in tree/ }).click();
  await expect(search(page)).toHaveValue("");
  await expect(page.locator(`${LISTING_ROWS}[aria-selected="true"]`)).toContainText(
    "old-readme.md",
  );
});

for (const width of [1440, 390]) {
  test(`the status shows the whole order at ${width} pixels`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    // A long breadcrumb gives way to the status.
    await open(page, ENTRIES, `${"a-long-archive-name-".repeat(5)}.zip`);
    await search(page).fill("readme.md");
    await expect(status(page)).toHaveText("Best match");
    await expect(status(page)).toBeInViewport();
    const fit = await status(page).evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
    expect(fit.client).toBeGreaterThan(0);
    expect(fit.scroll).toBeLessThanOrEqual(fit.client);
  });
}

const selectedRow = (page: Page) => page.locator(`${LISTING_ROWS}[aria-selected="true"]`);
const table = (page: Page) => page.locator("#list-viewport");

test.describe("Enter in the search field", () => {
  test("selects the first result, moves the focus, and opens nothing", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    await open(page);
    await search(page).fill("readme.md");
    await expect.poll(() => labels(page)).toEqual(BEST);
    const entries = await page.evaluate(() => history.length);
    await search(page).press("Enter");
    await expect(table(page)).toBeFocused();
    await expect(selectedRow(page)).toContainText("docs/readme.md");
    await expect(page.locator("#preview-pane")).toHaveCount(0);
    expect(await page.evaluate(() => history.length)).toBe(entries);
    // A held key is one key: its repeat does not open the row.
    await table(page).evaluate((grid) => {
      grid.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true }),
      );
    });
    await expect(page.locator("#preview-pane")).toHaveCount(0);
    // Space then previews, as on any selected row.
    await page.keyboard.press("Space");
    await expect(page.locator("#preview-pane")).toContainText("docs/readme.md");
    // A new Enter on the table is the key of the table again.
    await page.keyboard.press("Space");
    await expect(page.locator("#preview-pane")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page.locator("#preview-pane")).toContainText("docs/readme.md");
  });

  test("does nothing with no results or an empty field", async ({ page }) => {
    await open(page);
    await search(page).fill("no such name");
    await expect(page.locator("#search-empty")).toBeVisible();
    await search(page).press("Enter");
    await expect(search(page)).toBeFocused();
    await expect(selectedRow(page)).toHaveCount(0);
    await search(page).fill("");
    await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
    await search(page).press("Enter");
    await expect(search(page)).toBeFocused();
    await expect(selectedRow(page)).toHaveCount(0);
  });

  test("waits for its results, with the focus in the field, and a new key ends the wait", async ({
    page,
  }) => {
    await holdableWorkers(page);
    await open(page);
    await search(page).fill("old");
    await expect.poll(() => labels(page)).toEqual(["old-readme.md"]);
    // The worker holds its reply, so this search has not ended for the page.
    await holdWorkers(page);
    await search(page).fill("readme.md");
    await search(page).press("Enter");
    // The wait is a part of the test: the key must not act in this time.
    await page.waitForTimeout(100);
    await expect(search(page)).toBeFocused();
    await expect(selectedRow(page)).toHaveCount(0);
    await releaseWorkers(page);
    await expect(table(page)).toBeFocused();
    await expect(selectedRow(page)).toContainText("docs/readme.md");
    // A new key ends the wait: Enter does not act on a later listing.
    await search(page).focus();
    await holdWorkers(page);
    await search(page).fill("old");
    await search(page).press("Enter");
    await search(page).fill("big");
    await releaseWorkers(page);
    await expect.poll(() => labels(page)).toEqual(["big/readme.md.bak"]);
    await expect(search(page)).toBeFocused();
    // A caret key ends it too: the person is placing the caret to edit.
    await holdWorkers(page);
    await search(page).fill("old");
    await search(page).press("Enter");
    await search(page).press("ArrowLeft");
    await releaseWorkers(page);
    await expect.poll(() => labels(page)).toEqual(["old-readme.md"]);
    await expect(status(page)).toHaveText("Best match");
    // The wait is a part of the test: the key must not act in this time.
    await page.waitForTimeout(100);
    await expect(search(page)).toBeFocused();
    await expect(selectedRow(page)).toHaveCount(0);
    // A move of the focus ends it too. This is a new query, so the reply holds
    // the key: the last query has its results, and the key would act on them.
    await holdWorkers(page);
    await search(page).fill("big");
    await search(page).press("Enter");
    await page.locator("#tree-viewport").focus();
    await releaseWorkers(page);
    await expect.poll(() => labels(page)).toEqual(["big/readme.md.bak"]);
    await expect(table(page)).not.toBeFocused();
    await expect(selectedRow(page)).toHaveCount(0);
  });

  interface FrameState {
    frameRequests: number;
    heldFrames: FrameRequestCallback[] | undefined;
    releaseFrames: () => void;
  }

  /** Opens 40,000 rows in few folders. The worker holds the steps of a search,
   *  so the table still shows the folder when the key comes. */
  async function openForWait(page: Page) {
    await openHeld(
      page,
      Array.from({ length: 40_000 }, (_, index): [string, number] => [
        `d${index % 7}/note-${index}.txt`,
        1 + (index % 97),
      ]),
    );
    await release(page);
    await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
    await expect.poll(() => labels(page)).toContain("d0/");
    // Counts the frame requests, and can hold the frames.
    await page.evaluate(() => {
      const state = window as unknown as FrameState;
      state.frameRequests = 0;
      state.heldFrames = undefined;
      const request = window.requestAnimationFrame.bind(window);
      state.releaseFrames = () => {
        const held = state.heldFrames ?? [];
        state.heldFrames = undefined;
        for (const callback of held) request(callback);
      };
      window.requestAnimationFrame = (callback) => {
        state.frameRequests += 1;
        if (state.heldFrames === undefined) return request(callback);
        state.heldFrames.push(callback);
        return 0;
      };
    });
  }

  /** Lets the worker make its steps until it has nothing left to do: until it
   *  asks for no step in 300 ms. A step when the worker does not wait does
   *  nothing. */
  async function runSteps(page: Page) {
    await page.evaluate(async () => {
      const state = (window as unknown as { parseGateState: { worker: Worker; waits: number } })
        .parseGateState;
      let waits = state.waits;
      let asked = performance.now();
      while (performance.now() - asked < 300) {
        state.worker.postMessage({ parseGate: "step" });
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (state.waits !== waits) {
          waits = state.waits;
          asked = performance.now();
        }
      }
    });
    await expect(status(page)).not.toHaveText(/Searching|Sorting/);
  }

  /** The frame loop stops when nothing can change. */
  async function expectFramesToStop(page: Page) {
    await expect
      .poll(async () => {
        const count = () => page.evaluate(() => (window as unknown as FrameState).frameRequests);
        const before = await count();
        await page.waitForTimeout(200);
        return (await count()) - before;
      })
      .toBe(0);
  }

  for (const [name, leave] of [
    ["Escape", (page: Page) => search(page).press("Escape")],
    ["Back", (page: Page) => page.goBack()],
  ] as const) {
    test(`${name} ends a wait that started on a folder listing`, async ({ page }) => {
      await openForWait(page);
      // A folder in a new entry, so that Back leaves the search for a folder.
      await page.locator("#tree-viewport [role=treeitem]:not([hidden])", { hasText: "d0" }).click();
      await runSteps(page);
      await expect.poll(async () => (await labels(page))[0]).toMatch(/^note-/);
      await search(page).fill("note");
      await search(page).press("Enter");
      await leave(page);
      await expect(search(page)).toHaveValue("");
      // No frame reads the results of the old query: they go in a moment, and
      // a frame that shows them cannot be a part of this test.
      await page.evaluate(() => {
        (window as unknown as FrameState).heldFrames = [];
      });
      await runSteps(page);
      await page.evaluate(() => (window as unknown as FrameState).releaseFrames());
      await expectFramesToStop(page);
      await expect(selectedRow(page)).toHaveCount(0);
      // The same query with no Enter takes no selection and no focus.
      await search(page).focus();
      await search(page).fill("note");
      await runSteps(page);
      await expect(status(page)).toHaveText("Best match");
      await expectFramesToStop(page);
      await expect(search(page)).toBeFocused();
      await expect(selectedRow(page)).toHaveCount(0);
    });
  }

  test("selects the first row of the sort after a header click", async ({ page }) => {
    await holdableWorkers(page);
    await open(page);
    await search(page).fill("readme.md");
    await expect.poll(() => labels(page)).toEqual(BEST);
    await header(page, "size").getByRole("button").click();
    await expect.poll(() => labels(page)).toEqual(BY_SIZE);
    await search(page).focus();
    await search(page).press("Enter");
    await expect(selectedRow(page)).toContainText("big/readme.md.bak");
    await expect(table(page)).toBeFocused();
    // While a new sort runs, the key waits for that sort.
    await search(page).focus();
    await holdWorkers(page);
    await header(page, "name").getByRole("button").click();
    await search(page).focus();
    await search(page).press("Enter");
    // The wait is a part of the test: the key must not act in this time.
    await page.waitForTimeout(100);
    await expect(search(page)).toBeFocused();
    await releaseWorkers(page);
    await expect(table(page)).toBeFocused();
    await expect(selectedRow(page)).toContainText("big/readme.md.bak");
    await expect(header(page, "name")).toHaveAttribute("aria-sort", "ascending");
  });

  test("during a parse selects the row that shows, and the row keeps the selection", async ({
    page,
  }) => {
    await openHeld(page, MANY);
    await search(page).fill("note.txt");
    await expect.poll(async () => (await labels(page))[0]).toMatch(/^row-.*-note\.txt$/);
    const first = (await labels(page))[0]!;
    await search(page).press("Enter");
    await expect(table(page)).toBeFocused();
    await expect(selectedRow(page)).toContainText(first);
    // The exact name of the last row comes above it. The selection stays.
    await release(page);
    await expect.poll(async () => (await labels(page))[0]).toBe("z/note.txt");
    await expect(selectedRow(page)).toContainText(first);
    await expect(selectedRow(page)).toHaveAttribute("aria-rowindex", "4");
    await expect(table(page)).toBeFocused();
  });

  test("does nothing at the end of an IME composition", async ({ page }) => {
    await open(page);
    await search(page).fill("readme.md");
    await expect.poll(() => labels(page)).toEqual(BEST);
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      await search(page).evaluate((input, more) => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...more }));
      }, init);
    }
    // The wait is a part of the test: the key must not act in this time.
    await page.waitForTimeout(100);
    await expect(search(page)).toBeFocused();
    await expect(selectedRow(page)).toHaveCount(0);
    // The next Enter is the key.
    await search(page).press("Enter");
    await expect(table(page)).toBeFocused();
    await expect(selectedRow(page)).toContainText("docs/readme.md");
  });

  test("after Back, no row is selected, and a new Enter acts on the listing", async ({ page }) => {
    await open(page);
    await search(page).fill("readme.md");
    await expect.poll(() => labels(page)).toEqual(BEST);
    await search(page).press("Enter");
    await expect(selectedRow(page)).toContainText("docs/readme.md");
    await page.locator("#tree-viewport [role=treeitem]:not([hidden])", { hasText: "big" }).click();
    await expect(search(page)).toHaveValue("");
    await page.goBack();
    await expect(search(page)).toHaveValue("readme.md");
    await expect.poll(() => labels(page)).toEqual(BEST);
    await expect(selectedRow(page)).toHaveCount(0);
    await search(page).focus();
    await search(page).press("Enter");
    await expect(table(page)).toBeFocused();
    await expect(selectedRow(page)).toContainText("docs/readme.md");
  });
});
