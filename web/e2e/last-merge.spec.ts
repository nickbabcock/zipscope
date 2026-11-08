// A parse that stops keeps the matches that it already parsed. Rows wait for a
// merge for up to 250 ms when the listing is not in archive order. Thus each
// stop makes a last merge: Cancel, Stop at the prompt, and the hard stop when
// the room allows it. The prompt also shows after a last merge.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { gate, openGate, pauseBetweenBatches } from "./parse-gate";
import { storedZip } from "./stored-zip";

/** The text of the strip when rows are missing (`ROWS_MISSING`). */
const ROWS_MISSING = "Some entries that were read are not in this listing.";

/** 4 of 5 rows match. All rows are in the root folder, so a listing with no
 *  query has them too. */
const ENTRIES: [string, number][] = Array.from({ length: 40_000 }, (_, index) => [
  index % 5 === 4 ? `other-${index}.txt` : `note-${index}.txt`,
  1 + (index % 97),
]);
/** The same rows with long names. The store grows by many MiB, far from its size
 *  at the start, so the limits below have a wide window. */
const LONG = "n".repeat(480);
const LONG_ENTRIES: [string, number][] = ENTRIES.map(([name, size]) => [`${LONG}-${name}`, size]);
const matches = (rows: number) => ENTRIES.slice(0, rows).filter(([name]) => name.includes("note"));
/**
 * The limits of these rows, from a scan on `LONG_ENTRIES`. Rows parsed at the
 * stop, with the limit in MiB:
 *
 *   Soft  20: 8,490   30: 16,962   40: 25,431   50: 33,900   55: no prompt
 *   Hard  30: 8,489   40: 16,961   45: 25,430   60: 33,899   65: no stop
 *
 * Each limit is in the middle of a window of about 30 MiB. The test needs only
 * a stop in the middle of the parse.
 */
const SOFT = 35 * 2 ** 20;
const HARD = 45 * 2 ** 20;

const search = (page: Page) => page.locator("#search-input");
const listed = (page: Page) =>
  page
    .locator("#list-viewport")
    .evaluate((grid) => Number(grid.getAttribute("aria-rowcount") ?? 1) - 1);
const parsed = async (page: Page) =>
  Number((await page.locator("#row-count").textContent())?.replace(/,/g, ""));

async function openHeld(page: Page, entries = ENTRIES) {
  const file = test.info().outputPath("held.zip");
  writeFileSync(file, storedZip(entries));
  await pauseBetweenBatches(page);
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");
  await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "true");
  await page.locator("#file-input").setInputFiles(file);
  await expect.poll(() => gate(page)).toBe(1);
  await gate(page, true);
  await expect.poll(() => gate(page)).toBe(2);
  await expect(page.locator("#row-count")).not.toHaveText("0");
}

/** Lets the parse run until rows wait: the listing shows fewer rows than the
 *  matches of the rows that the status counts. */
async function untilRowsWait(page: Page) {
  await expect
    .poll(
      async () => {
        await gate(page, true);
        return matches(await parsed(page)).length - (await listed(page));
      },
      { intervals: [1], timeout: 30_000 },
    )
    .toBeGreaterThan(0);
}

/** Lets the worker go on until `text` shows in the status. */
async function runUntil(page: Page, text: string) {
  const status = page.locator("#status").filter({ hasText: text });
  await expect
    .poll(
      async () => {
        await gate(page, true);
        return status.count();
      },
      { intervals: [5], timeout: 30_000 },
    )
    .toBe(1);
}

for (const [order, choose] of [
  ["no sort chosen", async () => {}],
  [
    "a chosen sort",
    async (page: Page) => {
      const header = page.locator("#list-viewport [role=columnheader][data-column=name]");
      await header.getByRole("button").click();
      await expect(header).toHaveAttribute("aria-sort", "ascending");
    },
  ],
] as const) {
  test(`Cancel with rows waiting lists all matches of the parsed rows, with ${order}`, async ({
    page,
  }) => {
    await openHeld(page);
    await choose(page);
    await search(page).fill("note");
    await untilRowsWait(page);
    await page.locator("#cancel-button").click();
    await runUntil(page, "Cancelled after");
    const rows = await parsed(page);
    expect(rows).toBeLessThan(ENTRIES.length);
    await expect.poll(() => listed(page)).toBe(matches(rows).length);
  });
}

test("the memory prompt shows all matches of the parsed rows, and also after Stop", async ({
  page,
}) => {
  await page.addInitScript((soft) => {
    Object.assign(globalThis, { __zipscopeTestBudget: { soft, hard: 2 ** 31 } });
  }, SOFT);
  await openHeld(page, LONG_ENTRIES);
  await search(page).fill("note");
  await openGate(page);
  await expect(page.locator("#budget-prompt")).toBeVisible({ timeout: 30_000 });
  const rows = await parsed(page);
  // A prompt in the middle of the parse, so rows can wait behind it.
  expect(rows).toBeGreaterThan(0);
  expect(rows).toBeLessThan(ENTRIES.length);
  await expect.poll(() => listed(page)).toBe(matches(rows).length);
  await page.locator("#budget-stop").click();
  await expect(page.locator("#status")).toContainText("Cancelled after");
  const end = await parsed(page);
  await expect.poll(() => listed(page)).toBe(matches(end).length);
});

for (const [name, query, choose] of [
  ["a plain parse with no query", "", false],
  ["no query and a chosen sort", "", true],
  ["a query", "note", false],
] as const) {
  test(`at the hard stop, with ${name}, the line tells if rows are absent`, async ({ page }) => {
    await page.addInitScript((hard) => {
      Object.assign(globalThis, { __zipscopeTestBudget: { soft: 2 ** 31, hard } });
    }, HARD);
    await openHeld(page, LONG_ENTRIES);
    if (choose) {
      const header = page.locator("#list-viewport [role=columnheader][data-column=name]");
      await header.getByRole("button").click();
      await expect(header).toHaveAttribute("aria-sort", "ascending");
    }
    if (query !== "") await search(page).fill(query);
    await openGate(page);
    await expect(page.locator("#status")).toContainText("Stopped after", { timeout: 30_000 });
    const strip = page.locator("#health-strip");
    await expect(strip).toContainText("memory limit");
    const rows = await parsed(page);
    expect(rows).toBeLessThan(ENTRIES.length);
    const want = query === "" ? rows : matches(rows).length;
    // The line shows when rows are absent, and only then. The frame after the
    // end shows the last listing.
    await expect
      .poll(async () => {
        const complete = (await listed(page)) === want;
        const line = (await strip.textContent())?.includes(ROWS_MISSING) === true;
        return complete === line ? "wrong" : "right";
      })
      .toBe("right");
    // A frame can come later: the result stays.
    const complete = (await listed(page)) === want;
    const line = (await strip.textContent())?.includes(ROWS_MISSING) === true;
    expect(line).toBe(!complete);
  });
}

// A plain parse at low limits, which a parse with many short names reaches in
// each stage of its store. The stop can be at any row, or there can be no stop:
// the test needs only that the line tells the truth.
for (const hard of [80, 100, 115]) {
  test(`a plain parse with a limit of ${hard} MiB has no line over a complete listing`, async ({
    page,
  }) => {
    await page.addInitScript(
      (bytes) => {
        Object.assign(globalThis, { __zipscopeTestBudget: { soft: 2 ** 31, hard: bytes } });
      },
      hard * 2 ** 20,
    );
    const file = test.info().outputPath("flat.zip");
    writeFileSync(
      file,
      storedZip(
        Array.from({ length: 300_000 }, (_, index): [string, number] => [
          `generated-entry-name-of-a-file-in-the-root-folder-${index}.txt`,
          0,
        ]),
        300_000n,
      ),
    );
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.goto("/");
    await page.locator("#file-input").setInputFiles(file);
    const end = page.locator("#status").filter({ hasText: /Stopped after|Listed in/ });
    await expect(end).toHaveCount(1, { timeout: 60_000 });
    const strip = page.locator("#health-strip");
    const lineShows = async () =>
      (await strip.count()) > 0 && (await strip.textContent())?.includes(ROWS_MISSING) === true;
    await expect
      .poll(async () => {
        const complete = (await listed(page)) === (await parsed(page));
        return complete === (await lineShows()) ? "wrong" : "right";
      })
      .toBe("right");
  });
}
