// The tool shell: the three layouts, the preview splitter, the column
// picker, the narrow layout and the night theme.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { holdFinished } from "./hold";
import { openArchive, waitForOutcome } from "./listing";
import { storedZip } from "./stored-zip";

const ENTRIES: [string, number][] = [
  ["logs/ingest/ingest-2026-10-21.jsonl", 4000],
  ["logs/ingest/ingest-2026-10-22.jsonl", 3000],
  ["logs/app/app.log", 2000],
  ["media/cover.png", 1000],
  ["README.md", 100],
];

async function open(page: Page, width: number, height = 800) {
  await page.setViewportSize({ width, height });
  const file = test.info().outputPath("shell.zip");
  writeFileSync(file, storedZip(ENTRIES));
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
}

/** The header cells that show, by label. */
/** The names of the columns, with no arrow of the default sort. */
const headers = async (page: Page) =>
  (await page.locator("#list-viewport [role=columnheader]:not([hidden])").allTextContents()).map(
    (text) => text.replace(/[↑↓]$/, ""),
  );

/** The width of the name column. */
const nameWidth = (page: Page) =>
  page
    .locator('#list-viewport [role=columnheader][data-cell="name"]')
    .evaluate((cell) => Math.round(cell.getBoundingClientRect().width));

/** Returns true when the page or the table scrolls sideways. */
const scrollsSideways = (page: Page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    const table = document.getElementById("list-viewport");
    return (
      root.scrollWidth > root.clientWidth ||
      document.body.scrollWidth > document.body.clientWidth ||
      (table !== null && table.scrollWidth > table.clientWidth)
    );
  });

const previewWidth = (page: Page) =>
  page.locator("#preview-pane").evaluate((pane) => Math.round(pane.getBoundingClientRect().width));

for (const width of [1440, 1000, 390]) {
  test(`no horizontal scroll at ${width}px`, async ({ page }) => {
    await open(page, width);
    expect(await scrollsSideways(page)).toBe(false);
    await page.locator("#preview-button").click();
    await expect(page.locator("#preview-pane")).toBeVisible();
    expect(await scrollsSideways(page)).toBe(false);
    if (width >= 700) {
      // The widest preview still leaves room for the table.
      await page.locator("#preview-splitter").focus();
      await page.keyboard.press("End");
      expect(await scrollsSideways(page)).toBe(false);
    }
  });
}

test("the layouts place the tree, the table and the preview", async ({ page }) => {
  await open(page, 1440);
  await expect(page.locator("#tree-pane")).toBeVisible();
  await expect(page.locator("#drawer-button")).toHaveCount(0);
  await expect(page.locator("#preview-pane")).toHaveCount(0);

  // Medium: the tree is behind the drawer button.
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(page.locator("#tree-pane")).toBeHidden();
  await expect(page.locator("#drawer-button")).toBeVisible();
  await page.locator("#drawer-button").click();
  await expect(page.locator("#tree-pane")).toBeVisible();
  await expect(page.locator("#drawer-button")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#tree-viewport")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#tree-pane")).toBeHidden();
  await expect(page.locator("#drawer-button")).toBeFocused();

  // A click on a folder in the drawer lists it and closes the drawer.
  await page.locator("#drawer-button").click();
  await page
    .locator('#tree-viewport [role=treeitem] [data-part="label"]', { hasText: "media" })
    .click();
  await expect(page.locator("#tree-pane")).toBeHidden();
  await expect(page.locator('#list-viewport [data-part="label"]').first()).toHaveText("cover.png");
});

test("the wide layout closes the drawer, and it stays closed after", async ({ page }) => {
  await open(page, 1000);
  await page.locator("#drawer-button").click();
  await expect(page.locator("#drawer-scrim")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(page.locator("#drawer-button")).toHaveCount(0);
  await expect(page.locator("#drawer-scrim")).toHaveCount(0);
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(page.locator("#drawer-button")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#drawer-scrim")).toHaveCount(0);
  await expect(page.locator("#tree-pane")).toBeHidden();
});

test("the splitter moves in 16px steps, clamps and is remembered", async ({ page }) => {
  // Wide enough that the table keeps room next to a 720px preview.
  await open(page, 1920);
  await page.locator("#preview-button").click();
  const splitter = page.locator("#preview-splitter");
  await expect(splitter).toHaveAttribute("role", "separator");
  await expect(splitter).toHaveAttribute("aria-orientation", "vertical");
  await expect(splitter).toHaveAttribute("aria-valuemin", "280");
  await expect(splitter).toHaveAttribute("aria-valuemax", "720");
  // The default width is
  // 440 px, the natural width of the hex view.
  await expect(splitter).toHaveAttribute("aria-valuenow", "440");
  expect(await previewWidth(page)).toBe(440);

  await splitter.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(splitter).toHaveAttribute("aria-valuenow", "456");
  expect(await previewWidth(page)).toBe(456);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(splitter).toHaveAttribute("aria-valuenow", "424");

  // Clamped at both ends.
  await page.keyboard.press("End");
  await expect(splitter).toHaveAttribute("aria-valuenow", "720");
  await page.keyboard.press("ArrowLeft");
  await expect(splitter).toHaveAttribute("aria-valuenow", "720");
  expect(await previewWidth(page)).toBe(720);
  await page.keyboard.press("Home");
  await expect(splitter).toHaveAttribute("aria-valuenow", "280");
  await page.keyboard.press("ArrowRight");
  await expect(splitter).toHaveAttribute("aria-valuenow", "280");
  expect(await previewWidth(page)).toBe(280);

  // A drag past either limit also clamps.
  const drag = async (to: number) => {
    const box = (await splitter.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(to, y, { steps: 4 });
    await page.mouse.up();
  };
  await drag(200);
  await expect(splitter).toHaveAttribute("aria-valuenow", "720");
  await drag(1910);
  await expect(splitter).toHaveAttribute("aria-valuenow", "280");
  await splitter.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(splitter).toHaveAttribute("aria-valuenow", "312");

  // The width survives a reload.
  await page.reload();
  const file = test.info().outputPath("shell.zip");
  await openArchive(page, file);
  await waitForOutcome(page);
  await page.locator("#preview-button").click();
  await expect(page.locator("#preview-splitter")).toHaveAttribute("aria-valuenow", "312");
  expect(await previewWidth(page)).toBe(312);
});

test("Compressed and Method hide while the preview is open; the picker restores them", async ({
  page,
}) => {
  // The preview keeps its width and minor
  // columns leave, so all columns fit next to it only in a wider window.
  await open(page, 1920);
  // This archive has no times, so Modified
  // collapses, and its folder rows give the Entries column.
  expect(await headers(page)).toEqual(["Name", "Size", "Compressed", "Ratio", "Entries", "Method"]);
  await page.locator("#preview-button").click();
  await expect.poll(() => headers(page)).toEqual(["Name", "Size", "Ratio", "Entries"]);

  // The picker shows the hidden columns again.
  await page.locator("#column-picker-button").click();
  const picker = page.locator("#column-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("checkbox", { name: "Method" })).not.toBeChecked();
  await picker.getByRole("checkbox", { name: "Method" }).check();
  await picker.getByRole("checkbox", { name: "Compressed" }).check();
  await expect
    .poll(() => headers(page))
    .toEqual(["Name", "Size", "Compressed", "Ratio", "Entries", "Method"]);
  await picker.getByRole("checkbox", { name: "Ratio" }).uncheck();
  await expect
    .poll(() => headers(page))
    .toEqual(["Name", "Size", "Compressed", "Entries", "Method"]);
  // The rows follow the header.
  const cells = () =>
    page
      .locator("#list-viewport [data-row]:not([hidden])")
      .first()
      .locator("[data-cell]:not([hidden])")
      .evaluateAll((list) => list.map((cell) => (cell as HTMLElement).dataset.cell));
  await expect.poll(cells).toEqual(["name", "size", "compressed", "entries", "method"]);
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();

  // With the preview closed, the other choice applies.
  await page.locator("#preview-button").click();
  await expect
    .poll(() => headers(page))
    .toEqual(["Name", "Size", "Compressed", "Ratio", "Entries", "Method"]);
});

test("the narrow layout shows one pane at a time", async ({ page }) => {
  await open(page, 390);
  await expect.poll(() => headers(page)).toEqual(["Name", "Size"]);
  await expect(page.locator("#tree-pane")).toBeHidden();
  await expect(page.locator("#column-picker-button")).toHaveCount(0);

  // The tree opens over the table.
  await page.locator("#drawer-button").click();
  await expect(page.locator("#tree-pane")).toBeVisible();
  await expect(page.locator("#tree-viewport")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#tree-pane")).toBeHidden();

  // A double-click on an entry opens the preview full screen (a click
  // only selects), and Back returns to the list.
  await page.locator('#list-viewport [data-kind="entry"] [data-part="label"]').first().dblclick();
  const preview = page.locator("#preview-pane");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("README.md");
  const box = (await preview.boundingBox())!;
  expect(box.x).toBe(0);
  expect(Math.round(box.width)).toBe(390);
  await expect(page.locator("#preview-splitter")).toBeHidden();
  await expect(page.locator("#table-pane")).toHaveAttribute("inert", "");
  await expect(page.locator("#preview-back")).toBeFocused();
  await page.locator("#preview-back").click();
  await expect(preview).toHaveCount(0);
  await expect(page.locator("#table-pane")).not.toHaveAttribute("inert", "");
  await expect(page.locator("#preview-button")).toBeFocused();
});

test("the focus moves in the same task as the action", async ({ page }) => {
  // A key that the user presses at once must go to the new target, so
  // the focus must not wait for a frame.
  await open(page, 390);
  const afterDrawer = await page.evaluate(() => {
    document.getElementById("drawer-button")!.click();
    return document.activeElement?.id;
  });
  expect(afterDrawer).toBe("tree-viewport");
  const afterEscape = await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return document.activeElement?.id;
  });
  expect(afterEscape).toBe("drawer-button");
  const afterEntry = await page.evaluate(() => {
    const label = document.querySelector<HTMLElement>(
      '#list-viewport [data-kind="entry"] [data-part="label"]',
    );
    // A click only selects; Enter on the file opens the preview.
    label!.click();
    document
      .getElementById("list-viewport")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return document.activeElement?.id;
  });
  expect(afterEntry).toBe("preview-back");
});

test("the night sheet follows the system setting", async ({ page }) => {
  const ground = () =>
    page.evaluate(
      () => getComputedStyle(document.getElementById("root")!.firstElementChild!).backgroundColor,
    );
  const ink = () =>
    page.evaluate(
      () => getComputedStyle(document.getElementById("root")!.firstElementChild!).color,
    );
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, 1440);
  expect(await ground()).toBe("rgb(255, 255, 255)");
  expect(await ink()).toBe("rgb(28, 25, 23)");
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await ground()).toBe("rgb(12, 10, 9)");
  expect(await ink()).toBe("rgb(245, 245, 244)");
  const panel = await page
    .locator("#tree-pane")
    .evaluate((tree) => getComputedStyle(tree).backgroundColor);
  expect(panel).toBe("rgb(28, 25, 23)");
});

test("the status bar reads like a map margin", async ({ page }) => {
  await open(page, 1440);
  const footer = page.locator("footer");
  await expect(footer).toContainText("shell.zip");
  // One reading of the file size, with a label, in the map margin only.
  // The top bar gives the name with no size.
  const size = page.locator("#file-size");
  // A no-break space joins a number and its unit.
  await expect(size).toHaveText(/^File size [\d.]+\sKiB$/);
  await expect(size).toHaveAttribute("title", /^The size of the archive file: [\d,]+ bytes$/);
  await expect(footer).not.toContainText("Scale");
  // A no-break space joins a number and its unit.
  await expect(page.locator("header").first()).not.toContainText(/\d+(\.\d+)?\s(B|KiB|MiB)/);
  await expect(footer).toContainText("5 entries listed");
  await expect(page.locator("#status")).toHaveText(/Listed in \d+ ms/);
  // After the parse, far below the budget, the store memory does not show.
  await expect(page.locator("#store-memory")).toHaveCount(0);
});

test("names keep room next to a wide preview and restored columns", async ({ page }) => {
  await open(page, 1000);
  await page.locator("#preview-button").click();
  const splitter = page.locator("#preview-splitter");
  await splitter.focus();
  await page.keyboard.press("End");
  // The minor columns leave first, and the preview gives way only to the
  // least table. 999px for the table and the preview (the splitter is
  // 1 px); the table keeps 312px, the name and the size (the size text is
  // 72 px).
  await expect(splitter).toHaveAttribute("aria-valuenow", "687");
  await expect.poll(() => headers(page)).toEqual(["Name", "Size"]);
  expect(await nameWidth(page)).toBeGreaterThanOrEqual(200);
  expect(await scrollsSideways(page)).toBe(false);

  // Restore Compressed and Method. Method has no room next to the preview.
  await page.keyboard.press("Home");
  await page.locator("#column-picker-button").click();
  const picker = page.locator("#column-picker");
  await picker.getByRole("checkbox", { name: "Compressed" }).check();
  await expect(picker.getByRole("checkbox", { name: "Method" })).toBeDisabled();
  await expect(picker.locator("#column-picker-note")).toBeVisible();
  await expect.poll(() => headers(page)).toEqual(["Name", "Size", "Compressed", "Ratio"]);
  expect(await nameWidth(page)).toBeGreaterThanOrEqual(200);
  expect(await scrollsSideways(page)).toBe(false);
  await page.keyboard.press("Escape");

  // A wider window has room for Method.
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.locator("#column-picker-button").click();
  await expect(picker.getByRole("checkbox", { name: "Method" })).toBeEnabled();
  await picker.getByRole("checkbox", { name: "Method" }).check();
  await expect.poll(() => headers(page)).toEqual(["Name", "Size", "Compressed", "Ratio", "Method"]);
  await page.keyboard.press("Escape");
  expect(await nameWidth(page)).toBeGreaterThanOrEqual(200);
  expect(await scrollsSideways(page)).toBe(false);

  // A narrower window hides Modified, the
  // first minor column to leave, and a wider one shows it again.
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect.poll(() => headers(page)).toEqual(["Name", "Size", "Compressed", "Ratio", "Method"]);
  expect(await nameWidth(page)).toBeGreaterThanOrEqual(200);
  expect(await scrollsSideways(page)).toBe(false);
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect.poll(() => headers(page)).toEqual(["Name", "Size", "Compressed", "Ratio", "Method"]);
});

test("the layouts agree with the controls at the breakpoints", async ({ page }) => {
  await open(page, 1200);
  await expect(page.locator("#tree-pane")).toBeVisible();
  await expect(page.locator("#drawer-button")).toHaveCount(0);
  await page.setViewportSize({ width: 1199, height: 800 });
  await expect(page.locator("#tree-pane")).toBeHidden();
  await expect(page.locator("#drawer-button")).toBeVisible();

  await page.setViewportSize({ width: 700, height: 800 });
  await page.locator("#preview-button").click();
  await expect(page.locator("#preview-splitter")).toBeVisible();
  await expect(page.locator("#preview-close")).toBeVisible();
  await expect(page.locator("#preview-back")).toHaveCount(0);
  expect((await page.locator("#preview-pane").boundingBox())!.x).toBeGreaterThan(0);

  await page.setViewportSize({ width: 699, height: 800 });
  await expect(page.locator("#preview-back")).toBeVisible();
  await expect(page.locator("#preview-close")).toHaveCount(0);
  await expect(page.locator("#preview-splitter")).toHaveCount(0);
  const box = (await page.locator("#preview-pane").boundingBox())!;
  expect(box.x).toBe(0);
  expect(Math.round(box.width)).toBe(699);
});

test("Tab stays out of the panes that the drawer covers", async ({ page }) => {
  await open(page, 1000);
  await page.locator("#preview-button").click();
  await page.locator("#drawer-button").click();
  await expect(page.locator("#tree-viewport")).toBeFocused();
  await expect(page.locator("#preview-splitter")).toHaveAttribute("inert", "");
  await expect(page.locator("#preview-pane")).toHaveAttribute("inert", "");
  for (let step = 0; step < 6; step++) {
    await page.keyboard.press("Tab");
    const covered = await page.evaluate(() => {
      const active = document.activeElement;
      return ["table-pane", "preview-pane", "preview-splitter"].some(
        (id) => active !== null && document.getElementById(id)?.contains(active) === true,
      );
    });
    expect(covered, `Tab ${step + 1}`).toBe(false);
  }
});

test("Cancel stays on the screen at 390px with a hostile entry count", async ({ page }) => {
  // A small archive parses at once. To keep the app in the parsing state,
  // hold back the "finished" reply of the worker until the test ends.
  await page.addInitScript(holdFinished);
  const file = test.info().outputPath("hostile-count.zip");
  writeFileSync(file, storedZip(ENTRIES, 2n ** 63n - 1n));
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/");
  await openArchive(page, file);
  await expect(page.locator("#row-count")).toHaveText("5");
  const listed = page.locator("#entries-listed");
  // 2^63 − 1 as a float64 is 2^63; Intl.NumberFormat shows 17 digits.
  await expect(listed).toHaveAttribute(
    "title",
    /^5 of ~9,223,372,036,854,7\d\d,\d{3} entries listed$/,
  );
  const cancel = page.locator("#cancel-button");
  await expect(cancel).toBeVisible();
  const box = (await cancel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  // The estimate shrinks with an ellipsis.
  expect(await listed.evaluate((field) => field.scrollWidth > field.clientWidth)).toBe(true);
  expect(await scrollsSideways(page)).toBe(false);
  await cancel.click();
});
