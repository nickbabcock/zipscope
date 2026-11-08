// View requests that the hard stop refuses. The view state must agree with the
// listing that shows, the health panel has one finding for the hard stop,
// a screen reader hears each refusal, and after the hard stop the view
// controls are off.
//
// The archive has 80,000 empty entries in eight folders, so the root
// listing has folder rows.
// - A parse that stops at the hard stop: 32 MiB keeps 8 MiB for the read
//   worker. The first page of 65,536 rows fits below the other 24 MiB, and
//   the second page does not (see preview.spec.ts).
// - A refused request: the test hook `__zipscopeTestRefuseViews` makes the
//   worker refuse each view request after its change, as when the growth
//   of its listing does not fit. Thus the tests do not depend on the
//   memory that the store uses. The parse completes first. With a kind
//   ("sort"), the hook refuses only the first request of that kind, so a
//   test can list a folder or search before the stop.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openArchive, waitForOutcome } from "./listing";
import { storedZip } from "./stored-zip";

const ENTRIES = 80_000;

async function open(
  page: Page,
  options: { hard?: number; refuse?: boolean | "sort" },
): Promise<void> {
  await page.addInitScript(({ hard, refuse }) => {
    const test = globalThis as {
      __zipscopeTestBudget?: unknown;
      __zipscopeTestRefuseViews?: boolean | "sort";
    };
    if (hard !== undefined) test.__zipscopeTestBudget = { soft: 2 ** 31, hard };
    test.__zipscopeTestRefuseViews = refuse;
  }, options);
  const entries = Array.from(
    { length: ENTRIES },
    (_, index) => [`d${index % 8}/f${String(index).padStart(5, "0")}.txt`, 0] as [string, number],
  );
  const file = test.info().outputPath("stopped.zip");
  writeFileSync(file, storedZip(entries, BigInt(ENTRIES)));
  await page.goto("/");
  await openArchive(page, file);
}

/** Opens the archive with a parse that stops at the hard stop. */
async function openStopped(page: Page): Promise<void> {
  await open(page, { hard: 32 * 2 ** 20 });
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("failed");
  expect(result.rows).toBeGreaterThan(0);
  expect(result.rows).toBeLessThan(ENTRIES);
  await expect(page.locator("#health-strip")).toHaveAttribute("data-severity", "error");
  // The worker refuses view requests now, so the default sort does not start:
  // archive order, with no arrow.
  await expect(page.locator("#list-viewport [aria-sort]")).toHaveCount(0);
}

/** Opens the archive with a complete parse, and the worker refuses each
 *  view request, or each request from the first sort on. */
async function openRefusing(page: Page, refuse: true | "sort" = true): Promise<void> {
  await open(page, { refuse });
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  expect(await labels(page)).toEqual(FOLDERS);
}

const labels = (page: Page) =>
  page.locator('#list-viewport [data-row]:not([hidden]) [data-part="label"]').allTextContents();
const nameHeader = (page: Page) =>
  page.locator("#list-viewport [role=columnheader][data-column=name]");
const folderRow = (page: Page, label: string) =>
  page.locator('#list-viewport [data-row]:not([hidden])[data-kind="folder"]', { hasText: label });
const FOLDERS = ["d0/", "d1/", "d2/", "d3/", "d4/", "d5/", "d6/", "d7/"];
const historyState = (page: Page) => page.evaluate(() => history.state as Record<string, unknown>);
const status = (page: Page) => page.locator("#view-refused");

/** The ids of the findings in the health panel. */
async function findingIds(page: Page): Promise<(string | null)[]> {
  if (!(await page.locator("#health-panel").isVisible())) {
    await page.locator("#health-toggle").click();
  }
  return page
    .locator("#health-panel [data-finding]")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-finding")));
}

/** Checks that the search field, the sort buttons and the folders are off,
 *  and that the strip says so once. The controls have no tooltip with the
 *  reason: no element has a title that names the stop. */
async function expectStopped(page: Page): Promise<void> {
  await expect(page.locator("#health-stopped")).toHaveText(
    "Search, sort and folder changes are off.",
  );
  await expect(page.locator("#health-stopped")).toBeVisible();
  const search = page.locator("#search-input");
  await expect(search).toBeDisabled();
  // One placeholder for all widths.
  // A short text that a narrow field shows
  // whole. The strip says why.
  await expect(search).toHaveAttribute("placeholder", "Search off");
  await expect(search).not.toHaveAttribute("title");
  const button = nameHeader(page).getByRole("button");
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(button).not.toHaveAttribute("title");
  // A screen reader hears the reason on each control that is off, with
  // no tooltip.
  const reason = "Search, sort and folder changes are off.";
  await expect(button).toHaveAccessibleDescription(reason);
  const row = folderRow(page, "d0/");
  await expect(row).toHaveAttribute("aria-disabled", "true");
  await expect(row).not.toHaveAttribute("title");
  await expect(row).toHaveAccessibleDescription(reason);
  await expect(row.locator('[data-part="label"]')).toHaveAttribute("title", "d0/");
  await expect(row.locator('[data-part="toggle"] svg')).toBeHidden();
  const tree = page.locator("#tree-viewport [role=treeitem]", { hasText: "d0" });
  await expect(tree).toHaveAttribute("aria-disabled", "true");
  await expect(tree).not.toHaveAttribute("title");
  await expect(tree).toHaveAccessibleDescription(reason);
  await expect(tree.locator('[data-part="label"]')).toHaveAttribute("title", "d0");
  await expect(tree.locator('[data-part="toggle"]')).toBeHidden();
  const titles = await page.evaluate(
    () =>
      [...document.querySelectorAll("[title]")].filter((element) =>
        /stopped at|memory limit/i.test(element.getAttribute("title") ?? ""),
      ).length,
  );
  expect(titles).toBe(0);
}

/** Clicks the name header: the hook refuses the sort, so the hard stop
 *  turns the controls off. */
async function refuseSort(page: Page): Promise<string> {
  await nameHeader(page).getByRole("button").click();
  const text = "The sort could not run at the 2.00 GiB memory limit.";
  await expect(status(page)).toHaveText(text);
  return text;
}

test("a hard stop shows one finding and turns the view controls off", async ({ page }) => {
  await openStopped(page);
  expect(await findingIds(page)).toEqual(["memory-limit"]);
  await expect(page.locator('[data-finding="memory-limit"]')).toContainText(
    "Parsing stopped at the 32.0 MiB memory limit",
  );
  await expectStopped(page);
  // A click asks for nothing. Playwright does not click an aria-disabled
  // control on its own.
  await nameHeader(page).getByRole("button").click({ force: true });
  await folderRow(page, "d0/").click({ force: true });
  await expect(nameHeader(page)).not.toHaveAttribute("aria-sort");
  await expect(page.locator("#sort-status")).toHaveText("");
  expect(await labels(page)).toEqual(FOLDERS);
  const state = await historyState(page);
  expect(state.sort).toBeNull();
  expect(state.folder).toBeNull();
  // Nothing was refused, so the screen-reader status is empty.
  await expect(status(page)).toHaveText("");
});

test("at 390 px the strip shows the sentence about the controls whole", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStopped(page);
  const sentence = page.locator("#health-stopped");
  await expect(sentence).toBeVisible();
  expect(await sentence.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a sort that the hard stop refuses keeps the header of the listing", async ({ page }) => {
  await openRefusing(page);
  // Before the stop, the strip has no sentence about the controls.
  await expect(page.locator("#health-stopped")).toHaveCount(0);
  await nameHeader(page).getByRole("button").click();
  const text = "The sort could not run at the 2.00 GiB memory limit.";
  await expect(page.locator("#health-strip")).toContainText(text);
  // A screen reader hears the refusal.
  await expect(status(page)).toHaveText(text);
  await expect(status(page)).toHaveAttribute("role", "status");
  await expect(nameHeader(page)).not.toHaveAttribute("aria-sort");
  await expect(page.locator("#sort-status")).toHaveText("");
  expect(await labels(page)).toEqual(FOLDERS);
  expect((await historyState(page)).sort).toBeNull();
  await expectStopped(page);
  expect(await findingIds(page)).toEqual(["memory-limit"]);
});

test("a refused request before the health report shows the sentence", async ({ page }) => {
  // Holds each health request of the page, so the refusal comes first.
  await page.addInitScript(() => {
    const state = window as unknown as { holdHealth: boolean; releaseHealth: () => void };
    const held: (() => void)[] = [];
    state.holdHealth = false;
    state.releaseHealth = () => {
      state.holdHealth = false;
      for (const send of held.splice(0)) send();
    };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      const path = (args[0] as { path?: unknown[] } | null)?.path;
      if (state.holdHealth && Array.isArray(path) && path[0] === "health") {
        held.push(() => (post as (...all: unknown[]) => void).apply(this, args));
        return;
      }
      (post as (...all: unknown[]) => void).apply(this, args);
    } as Worker["postMessage"];
  });
  await openRefusing(page);
  await expect(page.locator("#health-strip")).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as { holdHealth: boolean }).holdHealth = true;
  });
  await refuseSort(page);
  // No finding yet: the strip has only the sentence, in the error tone,
  // and no link to a list.
  const strip = page.locator("#health-strip");
  await expect(strip).toHaveAttribute("data-severity", "error");
  await expect(page.locator("#health-stopped")).toHaveText(
    "Search, sort and folder changes are off.",
  );
  await expect(page.locator("#health-toggle")).toHaveCount(0);
  await expect(nameHeader(page).getByRole("button")).toHaveAccessibleDescription(
    "Search, sort and folder changes are off.",
  );
  await page.evaluate(() => {
    (window as unknown as { releaseHealth: () => void }).releaseHealth();
  });
  await expect(strip).toContainText("The sort could not run at the 2.00 GiB memory limit.");
  await expect(page.locator("#health-toggle")).toHaveText("1 finding");
  await expect(page.locator("#health-stopped")).toBeVisible();
});

test("a search that the hard stop refuses keeps the folder listing", async ({ page }) => {
  await openRefusing(page);
  const search = page.locator("#search-input");
  await search.fill("f0001");
  const text = "The search could not run at the 2.00 GiB memory limit.";
  await expect(page.locator("#health-strip")).toContainText(text);
  await expect(status(page)).toHaveText(text);
  // The search field, the breadcrumb and the history entry go back to the
  // listing that shows. Then the field is off.
  await expect(search).toHaveValue("");
  await expect(page.locator("#location")).not.toContainText("Search results");
  await expect(page.locator('#location [aria-current="location"]')).toHaveText("stopped.zip");
  await expect(page.locator("#folder-extract")).toBeVisible();
  expect(await labels(page)).toEqual(FOLDERS);
  await expect.poll(async () => (await historyState(page)).query).toBe("");
  await expectStopped(page);
  expect(await findingIds(page)).toEqual(["memory-limit"]);
});

test("a folder that the hard stop refuses keeps the location of the listing", async ({ page }) => {
  await openRefusing(page);
  await folderRow(page, "d0/").locator('[data-part="label"]').click();
  const text = "The folder could not change at the 2.00 GiB memory limit.";
  await expect(page.locator("#health-strip")).toContainText(text);
  await expect(status(page)).toHaveText(text);
  await expect(page.locator('#location [aria-current="location"]')).toHaveText("stopped.zip");
  expect(await labels(page)).toEqual(FOLDERS);
  await expect.poll(async () => (await historyState(page)).folder).toBe(0);
  // The tree selection stays on the listed folder.
  await expect(
    page.locator('#tree-viewport [role=treeitem][aria-selected="true"]'),
  ).toHaveAttribute("data-folder", "0");
  await expectStopped(page);
  expect(await findingIds(page)).toEqual(["memory-limit"]);
});

test("the refusal status speaks also when the tree drawer makes the table inert", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openRefusing(page);
  await page.locator("#drawer-button").click();
  await expect(page.locator("#table-pane")).toHaveAttribute("inert", "");
  // Open d0 in the tree with the keyboard: the worker refuses it.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(status(page)).toHaveText(
    "The folder could not change at the 2.00 GiB memory limit.",
  );
  expect(await status(page).evaluate((node) => node.closest("[inert]") === null)).toBe(true);
});

test("after the hard stop, the breadcrumb and Backspace do not change the folder", async ({
  page,
}) => {
  await openRefusing(page, "sort");
  await folderRow(page, "d0/").locator('[data-part="label"]').click();
  const current = page.locator('#location [aria-current="location"]');
  await expect(current).toHaveText("d0");
  const folder = (await historyState(page)).folder;
  const text = await refuseSort(page);
  // The root segment would list the root: it is off. The strip gives the
  // reason, not a tooltip.
  const root = page.locator("#location button", { hasText: "stopped.zip" });
  await expect(root).toHaveAttribute("aria-disabled", "true");
  await expect(root).toHaveAttribute("title", "stopped.zip");
  await expect(root).toHaveAccessibleDescription("Search, sort and folder changes are off.");
  await expect(page.locator("#health-stopped")).toBeVisible();
  await root.click({ force: true });
  // Backspace in the table and outside it does not go up.
  await page.locator("#list-viewport").focus();
  await page.keyboard.press("Backspace");
  await page.locator("body").focus();
  await page.keyboard.press("Backspace");
  // No request ran: the status still speaks the refused sort, and the
  // location and the history entry did not change.
  await expect(status(page)).toHaveText(text);
  await expect(current).toHaveText("d0");
  expect((await historyState(page)).folder).toBe(folder);
  await expect(page.locator("#archive-panel")).toBeHidden();
});

test("after the hard stop, show in tree is off and the search stays", async ({ page }) => {
  await openRefusing(page, "sort");
  await page.locator("#search-input").fill("f00001");
  await expect(page.locator("#location")).toContainText("Search results");
  const text = await refuseSort(page);
  const rows = page.locator('#list-viewport [data-row]:not([hidden])[data-kind="entry"]');
  await rows.first().click({ button: "right" });
  const item = page.locator('#row-menu [data-action="show-in-tree"]');
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await expect(item).toContainText("Folders stopped at the memory limit");
  await page.keyboard.press("t");
  await page.keyboard.press("Escape");
  // The root segment would leave the search: it is off.
  await expect(page.locator("#location button", { hasText: "stopped.zip" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.locator("#list-viewport").focus();
  await page.keyboard.press("Backspace");
  await expect(status(page)).toHaveText(text);
  await expect(page.locator("#location")).toContainText("Search results");
  expect((await historyState(page)).query).toBe("f00001");
});

test("after the hard stop, the Show entry link of a finding is off", async ({ page }) => {
  // A duplicate name gives a finding with an example row and a link.
  await page.addInitScript(() => {
    (globalThis as { __zipscopeTestRefuseViews?: string }).__zipscopeTestRefuseViews = "sort";
  });
  const file = test.info().outputPath("duplicates.zip");
  writeFileSync(
    file,
    storedZip([
      ["a/x.txt", 1],
      ["a/x.txt", 1],
      ["b.txt", 1],
    ]),
  );
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  const text = await refuseSort(page);
  // The root segment of the current location stays on: it opens the
  // Archive panel and sends no request. The
  // panel links to the health list, and the list has "Show entry".
  await page.locator("#location button", { hasText: "duplicates.zip" }).click();
  await page.locator("#archive-health-link").click();
  const link = page.locator(
    '#health-panel [data-finding="duplicate-names"] [data-action="show-entry"]',
  );
  await expect(link).toHaveText("Show entry");
  await expect(link).toHaveAttribute("aria-disabled", "true");
  await expect(link).toHaveAccessibleDescription("Search, sort and folder changes are off.");
  await expect(link).not.toHaveAttribute("title");
  await link.click({ force: true });
  // No request ran: the panel stays, and the status still speaks the sort.
  await expect(page.locator("#archive-panel")).toBeVisible();
  await expect(status(page)).toHaveText(text);
});
