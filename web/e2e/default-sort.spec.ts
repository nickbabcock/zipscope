// The default order of the table: Size from the
// largest after the parse, archive order during it, and the third step of the
// header cycle is archive order.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { LISTING_ROWS, openArchive, useArchiveOrder, waitForOutcome } from "./listing";
import { gate, pauseBetweenBatches } from "./parse-gate";
import { storedZip } from "./stored-zip";

const labels = (page: Page) =>
  page.locator(LISTING_ROWS).locator('[data-part="label"]').allTextContents();
const header = (page: Page, column: string) =>
  page.locator(`#list-viewport [role=columnheader][data-column=${column}]`);
const historyLength = (page: Page) => page.evaluate(() => history.length);
const keptSort = (page: Page) =>
  page.evaluate(() => (history.state as { sort: unknown } | null)?.sort);

const SMALL: [string, number][] = [
  ["small.txt", 1],
  ["large.txt", 30],
  ["middle.txt", 10],
];

async function open(page: Page, entries: [string, number][]) {
  const file = test.info().outputPath("sorted.zip");
  writeFileSync(file, storedZip(entries));
  await page.goto("/");
  await openArchive(page, file);
  return file;
}

/** Enough rows for some batches and a scroll, largest last. */
const MANY: [string, number][] = Array.from({ length: 2049 }, (_, index) => [
  `row-${String(index).padStart(4, "0")}.txt`,
  1 + (index % 97),
]);

/** Opens `MANY` with the parse held after its first rows. */
async function openHeld(page: Page, entries = MANY) {
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

test("the table starts by Size, and the third step of the cycle is archive order", async ({
  page,
}) => {
  await open(page, SMALL);
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => labels(page)).toEqual(["large.txt", "middle.txt", "small.txt"]);
  const button = header(page, "size").getByRole("button");
  await button.click();
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "ascending");
  await expect.poll(() => labels(page)).toEqual(["small.txt", "middle.txt", "large.txt"]);
  await button.click();
  await expect(header(page, "size")).not.toHaveAttribute("aria-sort");
  await expect.poll(() => labels(page)).toEqual(["small.txt", "large.txt", "middle.txt"]);
  await button.click();
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => labels(page)).toEqual(["large.txt", "middle.txt", "small.txt"]);
});

test("the listing stays in archive order during the parse, and the sort lands at its end", async ({
  page,
}) => {
  await openHeld(page);
  await expect(header(page, "size")).not.toHaveAttribute("aria-sort");
  const first = await labels(page);
  expect(first.slice(0, 3)).toEqual(["row-0000.txt", "row-0001.txt", "row-0002.txt"]);
  // The text of the status never says that a sort runs.
  await page.evaluate(() => {
    const seen: string[] = [];
    Object.assign(window, { sortStatus: seen });
    const status = document.getElementById("sort-status")!;
    new MutationObserver(() => seen.push(status.textContent ?? "")).observe(status, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  });
  // A selection and a scroll position of the user during the parse.
  const row = page.locator(LISTING_ROWS).filter({ hasText: "row-0002.txt" });
  await row.click();
  const viewport = page.locator("#list-viewport");
  await expect(row).toHaveAttribute("aria-selected", "true");
  const entries = await historyLength(page);
  await release(page);
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  await expect.poll(async () => (await labels(page)).includes("row-0002.txt")).toBe(true);
  // The selected row stays selected and in view, and the first rows now hold
  // the largest sizes.
  const selected = page.locator(`${LISTING_ROWS}[aria-selected="true"]`);
  await expect(selected).toContainText("row-0002.txt");
  await expect(selected).toBeInViewport();
  expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  // The landing adds no history entry and keeps no sort, and the status said
  // nothing.
  expect(await historyLength(page)).toBe(entries);
  expect(await keptSort(page)).toBeNull();
  expect(
    await page.evaluate(() =>
      (window as unknown as { sortStatus: string[] }).sortStatus.filter((text) =>
        text.startsWith("Sorting"),
      ),
    ),
  ).toEqual([]);
});

test("a scroll position of the user stays when the sort lands", async ({ page }) => {
  await openHeld(page);
  // Rows of the held parse only: a scroll that is in range after the end too.
  const viewport = page.locator("#list-viewport");
  await viewport.evaluate((element) => (element.scrollTop = 240));
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(240);
  await release(page);
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(240);
});

test("a sort from the user during the parse wins", async ({ page }) => {
  await openHeld(page);
  await header(page, "name").getByRole("button").click();
  await expect(header(page, "name")).toHaveAttribute("aria-sort", "ascending");
  await release(page);
  await expect(header(page, "name")).toHaveAttribute("aria-sort", "ascending");
  await expect(header(page, "size")).not.toHaveAttribute("aria-sort");
  expect((await labels(page)).slice(0, 2)).toEqual(["row-0000.txt", "row-0001.txt"]);
});

test("archive order that the user chooses during the parse is not a missing sort", async ({
  page,
}) => {
  await openHeld(page);
  const button = header(page, "size").getByRole("button");
  await button.click();
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  await button.click();
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "ascending");
  await button.click();
  await expect(header(page, "size")).not.toHaveAttribute("aria-sort");
  await release(page);
  await expect(header(page, "size")).not.toHaveAttribute("aria-sort");
  expect((await labels(page)).slice(0, 2)).toEqual(["row-0000.txt", "row-0001.txt"]);
});

test("history keeps archive order as a value, and no choice as none", async ({ page }) => {
  await open(page, SMALL);
  await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  expect(await keptSort(page)).toBeNull();
  await useArchiveOrder(page);
  // The sort goes to the history entry after REPLACE_INTERVAL.
  await expect
    .poll(() => keptSort(page), { timeout: 3000 })
    .toEqual({ column: 0, descending: false });
  // Back does not change a view setting: the sort stays.
  const result = await waitForOutcome(page);
  expect(result.outcome).toBe("complete");
  await expect(header(page, "size")).not.toHaveAttribute("aria-sort");
});

test("the status says Sorting while the default sort ends", async ({ page }) => {
  // Notes when the app asks for the end of the sort.
  await page.addInitScript(() => {
    const send = Worker.prototype.postMessage as (...args: unknown[]) => void;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      const data = args[0] as { path?: string[] } | undefined;
      if (data?.path?.[0] === "settleListing") Object.assign(window, { settling: true });
      send.apply(this, args);
    };
  });
  // More rows than the 16,384 that the worker sorts in one call.
  await openHeld(
    page,
    Array.from({ length: 40_000 }, (_, index) => [`r${index}.txt`, 1 + (index % 97)]),
  );
  // The worker holds the last steps of the sort, so the sort does not land.
  await expect
    .poll(
      async () => {
        const asked = await page.evaluate(() => "settling" in window);
        if (!asked) await gate(page, true);
        return asked;
      },
      { intervals: [10], timeout: 30_000 },
    )
    .toBe(true);
  await expect(header(page, "size")).not.toHaveAttribute("aria-sort");
  await expect(page.locator("#sort-status")).toHaveText("Sorting…");
  // The rest of the steps let the sort land.
  await expect
    .poll(
      async () => {
        await gate(page, true);
        return header(page, "size").getAttribute("aria-sort");
      },
      { intervals: [10], timeout: 30_000 },
    )
    .toBe("descending");
  await expect(page.locator("#sort-status")).toHaveText("");
});

// The worker tests check each memory rule of the default sort with exact bytes
// (`hostile-worker.test.ts`). Here the sort lands at low budgets in the real
// app. The store of this archive changes from run to run by about 0.5 MiB, and
// the sort lands from about 24 MiB soft and 33 MiB hard, so these limits are far
// above that.
for (const [limit, soft, hard] of [
  ["soft", 32, 2000],
  ["hard", 2000, 48],
] as const) {
  test(`with a ${limit} budget of ${Math.min(soft, hard)} MiB the sort lands, with no prompt`, async ({
    page,
  }) => {
    await page.addInitScript(
      ([softBytes, hardBytes]) => {
        Object.assign(globalThis, {
          __zipscopeTestBudget: { soft: softBytes, hard: hardBytes },
        });
      },
      [soft * 2 ** 20, hard * 2 ** 20],
    );
    await open(
      page,
      Array.from({ length: 60_000 }, (_, index) => [`r${index}.txt`, 1 + (index % 97)]),
    );
    await expect(page.locator("#status")).toContainText("Listed in");
    await expect(page.locator("#budget-prompt")).toHaveCount(0);
    await expect(page.locator("#health-strip")).toHaveCount(0);
    await expect(header(page, "size")).toHaveAttribute("aria-sort", "descending");
  });
}
