// The largest files below a short listing: the block shows in
// the space below the listing only when it fits, and its rows behave like
// other entry rows.
//
// The block leaves out the direct entries of the listed
// folder (they are rows of the listing already), and it shows only when a
// remaining file holds at least 5% of the bytes of the folder, and only
// after the parse is complete. Thus `README.md` of `app/` is not in the
// block, and the expected rows, row counts and key moves change to that.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openArchive, waitForOutcome } from "./listing";
import { storedZip } from "./stored-zip";

async function open(page: Page, entries: [string, number][]) {
  const file = test.info().outputPath("largest.zip");
  writeFileSync(file, storedZip(entries));
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
}

const grid = (page: Page) => page.locator("#list-viewport");
const shown = (page: Page) => page.locator("#list-viewport [data-row]:not([hidden])");
/** The shown rows in row order: the label, with `#` before a largest
 *  file and `=` before the label row. */
const rowsText = (page: Page) =>
  shown(page).evaluateAll((rows) =>
    rows
      .map((row) => {
        const element = row as HTMLElement;
        const mark =
          element.dataset.kind === "heading" ? "= " : element.dataset.block === "true" ? "# " : "";
        return {
          index: Number(element.dataset.row),
          text: mark + (row.querySelector('[data-part="label"]')?.textContent ?? ""),
        };
      })
      .sort((a, b) => a.index - b.index)
      .map((row) => row.text),
  );
const selectedLabel = (page: Page) =>
  page.locator('#list-viewport [role=row][aria-selected="true"] [data-part="label"]');

const ENTRIES: [string, number][] = [
  ["app/src/", 0],
  ["app/src/main.rs", 3000],
  ["app/src/deep/huge.bin", 9000],
  ["app/src/deep/empty.txt", 0],
  ["app/docs/guide.md", 4000],
  ["app/docs/api/", 0],
  ["app/README.md", 100],
  ["other/outside.bin", 20000],
];

test("a short folder shows its largest files below the listing", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, ENTRIES);
  await page.locator("#tree-viewport [role=treeitem]", { hasText: "app" }).first().click();
  await expect
    .poll(() => rowsText(page))
    .toEqual([
      "src/",
      "docs/",
      "README.md",
      "= Largest files under this folder",
      // The block uses one path depth, so
      // the base names start at a more regular x. The title has the full path.
      "# …/deep/huge.bin",
      "# docs/guide.md",
      "# src/main.rs",
    ]);
  // The grid counts the label row and the files: 3 + 1 + 3 rows and the
  // header.
  await expect(grid(page)).toHaveAttribute("aria-rowcount", "8");
  const first = shown(page).filter({ hasText: "…/deep/huge.bin" });
  await expect(first).toHaveAttribute("aria-rowindex", "6");
  await expect(first.locator('[data-part="label"]')).toHaveAttribute(
    "title",
    "app/src/deep/huge.bin",
  );
  // The file outside the folder and the empty file do not show.
  await expect(shown(page).filter({ hasText: "outside.bin" })).toHaveCount(0);
  await expect(shown(page).filter({ hasText: "empty.txt" })).toHaveCount(0);
});

test("the keys move past the label row, and the rows preview and show in tree", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, ENTRIES);
  await page.locator("#tree-viewport [role=treeitem]", { hasText: "app" }).first().click();
  await expect.poll(() => rowsText(page)).toContain("# …/deep/huge.bin");
  await grid(page).focus();
  await page.keyboard.press("Home");
  await expect(selectedLabel(page)).toHaveText("src/");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(selectedLabel(page)).toHaveText("README.md");
  // The label row does not select.
  await page.keyboard.press("ArrowDown");
  await expect(selectedLabel(page)).toHaveText("…/deep/huge.bin");
  await page.keyboard.press("ArrowUp");
  await expect(selectedLabel(page)).toHaveText("README.md");
  await page.keyboard.press("End");
  await expect(selectedLabel(page)).toHaveText("src/main.rs");
  await expect(page.locator('#list-viewport [aria-selected="true"]')).toHaveAttribute(
    "data-block",
    "true",
  );
  // Space shows the preview of a file of the block.
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  const preview = page.locator("#preview-pane");
  await expect(preview).toContainText("huge.bin");
  // The row menu has the actions of an entry, and "Show in tree" lists
  // the folder of the file.
  await grid(page).focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.locator("#row-menu");
  await expect(menu.getByRole("menuitem", { name: /Preview/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Extract/ })).toBeVisible();
  await menu.getByRole("menuitem", { name: /Show in tree/ }).click();
  // `deep/` is flat, so it has no block.
  await expect.poll(() => rowsText(page)).toEqual(["huge.bin", "empty.txt"]);
  await expect(selectedLabel(page)).toHaveText("huge.bin");
  await expect(page.locator('#tree-viewport [aria-selected="true"]')).toContainText("deep");
});

test("a click selects a file of the block, and a double-click opens its preview", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, ENTRIES);
  await page.locator("#tree-viewport [role=treeitem]", { hasText: "app" }).first().click();
  const file = shown(page).filter({ hasText: "docs/guide.md" });
  // A click only selects (the Quick Look model).
  await file.click();
  await expect(file).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#preview-pane")).toHaveCount(0);
  await file.dblclick();
  await expect(page.locator("#preview-pane")).toContainText("guide.md");
  // The label row does nothing on a click.
  await shown(page).filter({ hasText: "Largest files" }).click();
  await expect(file).toHaveAttribute("aria-selected", "true");
});

test("the block shows only when the listing and all its rows fit", async ({ page }) => {
  // A long folder: 30 rows of its own and files in a child folder.
  const entries: [string, number][] = [["long/sub/big.bin", 5000]];
  for (let index = 0; index < 30; index++) {
    entries.push([`long/file-${String(index).padStart(2, "0")}.txt`, 10 + index]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, entries);
  await expect.poll(() => rowsText(page)).toContain("file-00.txt");
  await expect(shown(page).filter({ hasText: "Largest files" })).toHaveCount(0);
  await expect(grid(page)).toHaveAttribute("aria-rowcount", "32");

  // A short folder: the block comes and goes only at the rule.
  await open(page, ENTRIES);
  await page.locator("#tree-viewport [role=treeitem]", { hasText: "app" }).first().click();
  await expect(shown(page).filter({ hasText: "Largest files" })).toHaveCount(1);
  // The fit rule reserves
  // the 8 px gap above the block, so the room is in pixels.
  const room = async () => grid(page).evaluate((element) => element.clientHeight - 28);
  // 3 listing rows, 11 block rows and the gap.
  expect(await room()).toBeGreaterThanOrEqual(14 * 24 + 8);
  const height = await grid(page).evaluate((element) => element.clientHeight);
  // One pixel less than 14 rows and the gap.
  await page.setViewportSize({ width: 1440, height: 900 - (height - (28 + 14 * 24 + 8)) - 1 });
  await expect.poll(room).toBe(14 * 24 + 7);
  await expect(shown(page).filter({ hasText: "Largest files" })).toHaveCount(0);
  await expect(grid(page)).toHaveAttribute("aria-rowcount", "4");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(shown(page).filter({ hasText: "Largest files" })).toHaveCount(1);
  // The block never makes the table scroll.
  const scroll = await grid(page).evaluate(
    (element) => element.scrollHeight - element.clientHeight,
  );
  expect(scroll).toBeLessThanOrEqual(0);
});

test("search results have no block, and the block comes back after", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, ENTRIES);
  await page.locator("#tree-viewport [role=treeitem]", { hasText: "app" }).first().click();
  await expect(shown(page).filter({ hasText: "Largest files" })).toHaveCount(1);
  await page.locator("#search-input").fill("bin");
  await expect.poll(() => rowsText(page)).toEqual(["other/outside.bin", "app/src/deep/huge.bin"]);
  await page.locator("#search-input").fill("");
  await expect(shown(page).filter({ hasText: "Largest files" })).toHaveCount(1);
});

test("the block leaves out direct entries and needs a file of 5% of the folder", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, [
    ["flat/a.bin", 300],
    ["flat/b.bin", 200],
    ["small/big-1.bin", 900],
    ["small/big-2.bin", 800],
    ["small/sub/small.txt", 89],
    ["hog/big-1.bin", 900],
    ["hog/big-2.bin", 800],
    ["hog/sub/hog.bin", 90],
    ["hog/sub/tiny.txt", 10],
  ]);
  // A flat folder has no subfolder where space can hide. The block would
  // only repeat the listing.
  await page.locator("#tree-viewport [role=treeitem]", { hasText: "flat" }).first().click();
  await expect.poll(() => rowsText(page)).toEqual(["a.bin", "b.bin"]);
  await expect(shown(page).filter({ hasText: "Largest files" })).toHaveCount(0);
  // The file below `small/sub/` holds 89 of 1,789 bytes,
  // less than 5%: no file is a hog, so no block. Before, the block showed
  // because a subfolder holds bytes, and it repeated the direct entries.
  await page.locator("#tree-viewport [role=treeitem]", { hasText: "small" }).first().click();
  await expect.poll(() => rowsText(page)).toEqual(["sub/", "big-1.bin", "big-2.bin"]);
  await expect(shown(page).filter({ hasText: "Largest files" })).toHaveCount(0);
  // `hog/sub/hog.bin` holds 90 of 1,800 bytes, which is 5%: the block
  // shows the files below the subfolders only.
  await page.locator("#tree-viewport [role=treeitem]", { hasText: "hog" }).first().click();
  await expect
    .poll(() => rowsText(page))
    .toEqual([
      "sub/",
      "big-1.bin",
      "big-2.bin",
      "= Largest files under this folder",
      "# sub/hog.bin",
      "# sub/tiny.txt",
    ]);
});

test("a file that inline expansion shows stays in the block, with one selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, ENTRIES);
  await page.locator("#tree-viewport [role=treeitem]", { hasText: "app" }).first().click();
  await expect.poll(() => rowsText(page)).toContain("# src/main.rs");
  // Open `src/` in place: `main.rs` is now a row of the listing too, at
  // level 1. It is not a direct entry of `app/`, so it stays in the block.
  await shown(page)
    .filter({ has: page.locator('[data-part="label"]', { hasText: /^src\/$/ }) })
    .locator('[data-part="toggle"]')
    .click();
  await expect.poll(() => rowsText(page)).toContain("main.rs");
  await expect.poll(() => rowsText(page)).toContain("# src/main.rs");
  await grid(page).focus();
  await page.keyboard.press("End");
  await expect(selectedLabel(page)).toHaveCount(1);
  await expect(selectedLabel(page)).toHaveText("src/main.rs");
  await expect(page.locator('#list-viewport [aria-selected="true"]')).toHaveCount(1);
});

test("screen readers hear the label with each row of the block", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, ENTRIES);
  await page.locator("#tree-viewport [role=treeitem]", { hasText: "app" }).first().click();
  const heading = shown(page).filter({ hasText: "Largest files" });
  await expect(heading).toHaveCount(1);
  // The label row is a row header, and it never selects.
  await expect(heading).not.toHaveAttribute("aria-selected");
  await expect(heading.getByRole("rowheader")).toHaveText("Largest files under this folder");
  // The name of the row header is in mixed case, not as the upper case
  // label shows.
  await expect(heading.getByRole("rowheader")).toHaveAccessibleName(
    "Largest files under this folder",
  );
  // Each row of the block has the label as its description.
  const file = shown(page).filter({ hasText: "…/deep/huge.bin" });
  await expect(file).toHaveAccessibleDescription("Largest files under this folder");
  await grid(page).focus();
  await page.keyboard.press("End");
  await expect(heading).not.toHaveAttribute("aria-selected");
  // A row of the listing has no description.
  await expect(
    page.locator('#list-viewport [data-kind="folder"]', { hasText: "docs/" }),
  ).not.toHaveAttribute("aria-describedby");
});

test("the label row writes its name only when the name changes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, ENTRIES);
  await page.locator("#tree-viewport [role=treeitem]", { hasText: "app" }).first().click();
  // Wait for the listing of app/, not only for a label row: the root has a
  // block too (other/outside.bin), and on a slow runner the root listing
  // can still show here. Then the label row moves one row down when app/
  // arrives, which writes the name two times (CI failure on 2026-11-03).
  await expect.poll(() => rowsText(page)).toContain("README.md");
  await expect(shown(page).filter({ hasText: "Largest files" })).toHaveCount(1);
  // Count the writes of `aria-label` in the list from now on.
  await page.evaluate(() => {
    const state = window as unknown as { __labelWrites: number };
    state.__labelWrites = 0;
    new MutationObserver((records) => {
      state.__labelWrites += records.length;
    }).observe(document.querySelector("#list-viewport")!, {
      subtree: true,
      attributeFilter: ["aria-label"],
    });
  });
  // A new column layout fills all the rows again, with the same label.
  const widths = () =>
    page.evaluate(() => document.querySelector("#list-viewport [data-row]")?.clientWidth);
  const before = await widths();
  await page.setViewportSize({ width: 1300, height: 900 });
  await expect.poll(widths).not.toBe(before);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(widths).toBe(before);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  await expect(shown(page).filter({ hasText: "Largest files" })).toHaveCount(1);
  expect(
    await page.evaluate(() => (window as unknown as { __labelWrites: number }).__labelWrites),
  ).toBe(0);
});

test("a row that was selected keeps no selected style in another role", async ({ page }) => {
  // Pool slots are `row % size`, so the element of a
  // selected block row can become the label row when the listing grows.
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, ENTRIES);
  await page.locator("#tree-viewport [role=treeitem]", { hasText: "app" }).first().click();
  await expect(shown(page).filter({ hasText: "Largest files" })).toHaveCount(1);
  const plainClass = await shown(page)
    .first()
    .evaluate(() => document.querySelector("#list-viewport [data-row]")!.className);
  /** The shown rows that look or read as selected, and the label row's
   *  state. */
  const state = () =>
    shown(page).evaluateAll((rows, base) => {
      const selected = rows.filter(
        (row) => row.getAttribute("aria-selected") === "true" || row.className !== base,
      );
      const heading = rows.find((row) => (row as HTMLElement).dataset.kind === "heading");
      return {
        selected: selected.map((row) => row.querySelector('[data-part="label"]')?.textContent),
        heading: heading === undefined ? "none" : heading.className === base ? "plain" : "styled",
      };
    }, plainClass);
  await grid(page).focus();
  // `docs/guide.md` is row 5, which is the label row after `src/` opens
  // (the block has no `README.md`).
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp");
  await expect.poll(state).toEqual({ selected: ["docs/guide.md"], heading: "plain" });
  const toggle = shown(page)
    .filter({ has: page.locator('[data-part="label"]', { hasText: /^src\/$/ }) })
    .locator('[data-part="toggle"]');
  await toggle.click();
  await expect.poll(state).toEqual({ selected: ["src/"], heading: "plain" });
  await toggle.click();
  await expect.poll(state).toEqual({ selected: ["src/"], heading: "plain" });
});

for (const late of [false, true]) {
  test(`the block shows only after the parse${late ? ", so it never shows and then goes" : ""}`, async ({
    page,
  }) => {
    // From the archive `flicker.zip`: a hog comes
    // first, so the block of the root was due during the parse. With
    // `late`, root folders at the end make the listing too long, so the
    // block went at the end. Now the block waits for the end of the parse:
    // it shows one time at the end, or never.
    const entries: [string, number][] = [["hog/big.bin", 5000]];
    for (let index = 0; index < 300_000; index++) {
      entries.push([`bulk/f${String(index).padStart(6, "0")}`, 0]);
    }
    for (let index = 0; late && index < 40; index++) {
      entries.push([`late-${String(index).padStart(2, "0")}/x`, 0]);
    }
    const file = test.info().outputPath("flicker.zip");
    // More than 65,535 entries need the zip64 end record.
    writeFileSync(file, storedZip(entries, BigInt(entries.length)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    // At each animation frame, record the frames with listing rows, and
    // the frames with a row of the block before and after the status says
    // that the parse is complete.
    await page.evaluate(() => {
      const state = { rows: 0, early: 0, after: 0, live: true };
      Object.assign(window, { __flicker: state });
      const check = () => {
        if (!state.live) return;
        const shown = "#list-viewport [data-row]:not([hidden])";
        const done = document.querySelector("#status")?.textContent?.includes("Listed in") === true;
        if (document.querySelector(`${shown}:not([data-block])`) !== null && !done) state.rows++;
        if (document.querySelector(`${shown}[data-block="true"]`) !== null) {
          if (done) state.after++;
          else state.early++;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    await openArchive(page, file);
    const result = await waitForOutcome(page);
    expect(result.outcome, result.status).toBe("complete");
    await expect(page.locator("#list-viewport [data-row]:not([hidden])").first()).toBeVisible();
    for (let frame = 0; frame < 10; frame++) {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    }
    const state = await page.evaluate(() => {
      const value = (
        window as unknown as {
          __flicker: { rows: number; early: number; after: number; live: boolean };
        }
      ).__flicker;
      value.live = false;
      return value;
    });
    // The listing showed during the parse, with no block.
    expect(state.rows).toBeGreaterThan(1);
    expect(state).toMatchObject({ early: 0 });
    if (late) {
      expect(state).toMatchObject({ after: 0 });
    } else {
      expect(state.after).toBeGreaterThan(0);
      await expect.poll(() => rowsText(page)).toContain("# hog/big.bin");
    }
  });
}
