// The health strip and panel for a hostile archive, and the memory-budget
// prompt. The budget tests lower the budget with the test-only global
// `__zipscopeTestBudget`, which the app reads when it opens an archive.
// Before the first batch the store is a few MiB of wasm memory. The first
// batch adds a page and a name chunk in wasm and in the mirrors (about
// 17 MiB), so a 12 MiB soft budget pauses after the first batch.
const SOFT = 12 * 2 ** 20;
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { archives, corpus, openArchive, waitForOutcome } from "./listing";

/** Sets a small memory budget before the app loads. */
async function lowBudget(page: Page, soft: number, hard: number): Promise<void> {
  await page.addInitScript(
    ([softBytes, hardBytes]) => {
      (globalThis as { __zipscopeTestBudget?: unknown }).__zipscopeTestBudget = {
        soft: softBytes,
        hard: hardBytes,
      };
    },
    [soft, hard],
  );
}

test("the health strip lists the findings of a hostile archive", async ({ page }) => {
  await page.goto("/");
  await openArchive(page, path.join(corpus, "generated/hostile.zip"));
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  expect(result.rows).toBe(7);
  const strip = page.locator("#health-strip");
  await expect(strip).toBeVisible();
  // The zip-bomb findings
  // are errors, so they come first and the strip has the error tone.
  await expect(strip).toHaveAttribute("data-severity", "error");
  await expect(page.locator("#health-toggle")).toHaveText("8 findings");
  await page.locator("#health-toggle").click();
  const panel = page.locator("#health-panel");
  await expect(panel).toBeVisible();
  const ids = await panel
    .locator("[data-finding]")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-finding")));
  expect(ids).toEqual([
    "overlaps",
    "bomb-ratio",
    "count-mismatch",
    "duplicate-names",
    "depth-cap",
    "prelude",
    "epilogue",
    "encrypted",
  ]);
  await expect(panel.locator('[data-finding="duplicate-names"]')).toContainText(
    "For example: readme.txt",
  );
  await expect(panel.locator('[data-finding="count-mismatch"]')).toContainText(
    "declares 9 entries, but its central directory has 7 entries",
  );
  await expect(panel.locator('[data-finding="prelude"]')).toContainText("26 B of data");
  await page.locator("#health-toggle").click();
  await expect(panel).toBeHidden();
});

test("a new findings list keeps the items of the same findings", async ({ page }) => {
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openArchive(page, path.join(corpus, "generated/hostile.zip"));
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  await page.locator("#health-toggle").click();
  const items = page.locator("#health-panel [data-finding]");
  await expect(items).toHaveCount(8);
  await items.evaluateAll((list) => {
    for (const item of list) (item as unknown as { kept: boolean }).kept = true;
  });
  // A preview checks the local header of its entry. That makes a new list
  // of the findings.
  await page.locator('#list-viewport [data-kind="entry"] [data-part="label"]').first().dblclick();
  await expect(page.locator("#preview-meta")).toBeVisible();
  await expect(page.locator("#preview-content")).not.toContainText("Loading");
  // The first entry (readme.txt) has a
  // CRC-32 of 0 for 5 bytes, so its preview adds the crc-failure finding.
  // The 8 items of the earlier findings stay.
  await expect(items).toHaveCount(9);
  const kept = await items.evaluateAll((list) =>
    list.map((item) => [
      item.getAttribute("data-finding"),
      (item as unknown as { kept?: boolean }).kept === true,
    ]),
  );
  expect(kept.filter(([, old]) => !old)).toEqual([["crc-failure", false]]);
});

test("a healthy archive shows no health strip", async ({ page }) => {
  await page.goto("/");
  await openArchive(page, path.join(archives, "2000.zip"));
  const result = await waitForOutcome(page);
  expect(result.outcome).toBe("complete");
  // Far below the 1 GiB budget, the map margin has no store memory after
  // the parse.
  await expect(page.locator("#store-memory")).toHaveCount(0);
  await expect(page.locator("#health-strip")).toHaveCount(0);
});

test("parsing pauses at the soft budget and continues after the answer", async ({ page }) => {
  await lowBudget(page, SOFT, 2 ** 31);
  await page.goto("/");
  await openArchive(page, path.join(archives, "2000.zip"));
  const prompt = page.locator("#budget-prompt");
  await expect(prompt).toBeVisible();
  // The first row allocates a page and a name chunk with their mirrors,
  // more than the 12 MiB budget, and the batch estimate counts them, so
  // the prompt can come after the first row.
  // A no-break space joins a number and its unit.
  await expect(prompt).toContainText(
    // The prompt leads with its state.
    /^Paused: (1 entry|.+ entries) listed using [\d.]+\sMiB so far\. Continue\?/,
  );
  await expect(page.locator("#status")).toContainText("Paused");
  // While parsing, the map margin shows the store memory.
  // A no-break space joins a number and its unit.
  await expect(page.locator("#store-memory")).toHaveText(/^Store [\d.]+\sMiB$/);
  // The prompt is the only strip: the notice of the soft budget tells the
  // same, so it does not show while the prompt waits.
  await expect(page.locator("#health-strip")).toHaveCount(0);
  const paused = Number((await page.locator("#row-count").textContent())?.replace(/,/g, ""));
  expect(paused).toBeGreaterThan(0);
  expect(paused).toBeLessThan(2000);
  // Nothing parses while the prompt waits.
  await page.waitForTimeout(200);
  await expect(page.locator("#row-count")).toHaveText(String(paused));
  await page.locator("#budget-continue").click();
  await expect(prompt).toBeHidden();
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  expect(result.rows).toBe(2000);
  // After the answer, the strip shows the finding of the budget. The
  // store is above half of the 12 MiB budget, so the map margin keeps it.
  await expect(page.locator("#health-strip")).toContainText("budget");
  await expect(page.locator("#store-memory")).toBeVisible();
  await page.locator("#health-toggle").click();
  await expect(page.locator('[data-finding="memory-budget"]')).toContainText(
    "Store memory passed the 12.0 MiB budget. Parsing continued when you chose to.",
  );
});

test("stopping at the soft budget keeps the partial listing", async ({ page }) => {
  await lowBudget(page, SOFT, 2 ** 31);
  await page.goto("/");
  await openArchive(page, path.join(archives, "2000.zip"));
  await expect(page.locator("#budget-prompt")).toBeVisible();
  await page.locator("#budget-stop").click();
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("cancelled");
  expect(result.rows).toBeGreaterThan(0);
  expect(result.rows).toBeLessThan(2000);
  await expect(page.locator("#budget-prompt")).toBeHidden();
  await expect(page.locator("#health-strip")).toContainText("memory budget");
});

test("the prompt is the one way to stop the wait at the soft budget", async ({ page }) => {
  await lowBudget(page, SOFT, 2 ** 31);
  await page.goto("/");
  await openArchive(page, path.join(archives, "2000.zip"));
  await expect(page.locator("#budget-prompt")).toBeVisible();
  // While the prompt waits, the map margin
  // has no Cancel, because "Stop here" stops the parse the same way.
  // Parsing waits, so the listing stays in archive order, with no arrow.
  await expect(page.locator("#list-viewport [aria-sort]")).toHaveCount(0);
  // "Continue" is the primary action.
  await expect(page.locator("#cancel-button")).toHaveCount(0);
  await expect(page.locator("#budget-continue")).toHaveCSS("font-weight", "600");
  await page.locator("#budget-stop").click();
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("cancelled");
  expect(result.rows).toBeLessThan(2000);
});

for (const width of [1440, 1000, 390]) {
  test(`health in the shell preserves search and layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await openArchive(page, path.join(corpus, "generated/hostile.zip"));
    await waitForOutcome(page);
    // The strip is the only health control: the top bar has no health
    // indicator, at all widths.
    await expect(page.locator("#health-indicator")).toHaveCount(0);
    await expect(page.locator("#health-slot")).toHaveCount(0);
    const toggle = page.locator("#health-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("8 findings");
    await toggle.click();
    await expect(page.locator("#health-panel")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const table = page.locator("#list-viewport");
    expect(await table.evaluate((element) => element.clientHeight)).toBeGreaterThan(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("/");
    await expect(page.getByRole("searchbox")).toBeFocused();
    await page.getByRole("searchbox").fill("readme");
    await expect(page.locator("#list-viewport")).toHaveAttribute(
      "data-listing-folder",
      String(0xffff_ffff),
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("searchbox")).toHaveValue("");
    await expect(toggle).toHaveText("8 findings");
  });
}
