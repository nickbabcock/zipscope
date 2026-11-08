// The "Show entry" link of a health finding opens the preview on its entry
// and selects its row, with the row in view (show-entry-preview).
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  heldWorkers,
  holdableLists,
  holdableWorkers,
  holdLists,
  holdWorkers,
  releaseLists,
  releaseWorkers,
} from "./hold";
import { hostileZip } from "./hostile-zip";
import type { HostileEntry } from "./hostile-zip";
import { LISTING_ROWS, openArchive, waitForOutcome } from "./listing";
import { gate, openGate, pauseBetweenBatches } from "./parse-gate";
import { storedZip } from "./stored-zip";

const WIDE = 1440;
const NARROW = 390;

/** Two entries with the name `name` give a finding with a link to one. */
const twice = (name: string, size = 1): [string, number][] => [
  [name, size],
  [name, size],
];

async function open(page: Page, width: number, zip: Buffer, height = 800) {
  await page.setViewportSize({ width, height });
  const file = test.info().outputPath("show-entry.zip");
  writeFileSync(file, zip);
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  await page.locator("#health-toggle").click();
}

const link = (page: Page) => page.locator('#health-panel [data-action="show-entry"]').first();
const steps = (page: Page) => page.evaluate(() => history.length);
const title = (page: Page) => page.locator("#preview-pane span[title]").first();
const labels = (page: Page) => page.locator(`${LISTING_ROWS} [data-part="label"]`);
const nameSort = (page: Page) =>
  page.locator("#list-viewport [role=columnheader][data-column=name]");
const selected = (page: Page) => page.locator('#list-viewport [role=row][aria-selected="true"]');

/** Expects one selected row with this label, with nothing on top of it. */
async function expectRowInView(page: Page, label: string) {
  await expect(selected(page).locator('[data-part="label"]')).toHaveText(label);
  await expect
    .poll(() =>
      selected(page).evaluate((row) => {
        const box = row.getBoundingClientRect();
        const view = document.getElementById("list-viewport")!.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        // The height of the table can have a fraction of a pixel.
        return box.top >= view.top && box.bottom <= view.bottom + 1 && row.contains(top);
      }),
    )
    .toBe(true);
}

test("wide, in the listed folder: the link adds no history entry", async ({ page }) => {
  await open(page, WIDE, storedZip([["a.txt", 3], ...twice("same.txt"), ["z.txt", 2]]));
  await expect(page.locator("#preview-pane")).toHaveCount(0);
  const before = await steps(page);
  await link(page).click();
  await expect(title(page)).toHaveText("same.txt");
  await expect(page.locator("#preview-button")).toHaveAttribute("aria-pressed", "true");
  await expectRowInView(page, "same.txt");
  await expect(page.locator("#list-viewport")).toBeFocused();
  expect(await steps(page)).toBe(before);
  // The keys of the table work on the row: Space closes the preview.
  await page.keyboard.press(" ");
  await expect(page.locator("#preview-pane")).toHaveCount(0);
  await expectRowInView(page, "same.txt");
});

test("wide, in another folder: the folder lists first, and Back closes all of it", async ({
  page,
}) => {
  await open(page, WIDE, storedZip([["a.txt", 3], ["b/c.txt", 1], ...twice("sub/dir/same.txt")]));
  await expect(labels(page)).toContainText(["sub/dir/", "b/", "a.txt"]);
  const before = await steps(page);
  await link(page).click();
  await expect(title(page)).toHaveText("same.txt");
  await expect(page.locator("#location")).toContainText("dir");
  await expectRowInView(page, "same.txt");
  expect(await steps(page)).toBe(before + 1);
  await page.goBack();
  await expect(page.locator("#preview-pane")).toHaveCount(0);
  await expect(labels(page)).toContainText(["sub/dir/", "b/", "a.txt"]);
  await expect(selected(page)).toHaveCount(0);
});

test("wide, with the preview open on another file: the link moves it", async ({ page }) => {
  await open(page, WIDE, storedZip([["a.txt", 3], ...twice("same.txt")]));
  await page.locator(LISTING_ROWS).filter({ hasText: "a.txt" }).click();
  await page.keyboard.press(" ");
  await expect(title(page)).toHaveText("a.txt");
  const before = await steps(page);
  await link(page).click();
  await expect(title(page)).toHaveText("same.txt");
  await expectRowInView(page, "same.txt");
  expect(await steps(page)).toBe(before);
});

test("wide, from the Archive panel: the link takes its place, and Back goes to it", async ({
  page,
}) => {
  await open(page, WIDE, storedZip([["a.txt", 3], ...twice("same.txt")]));
  await page.locator("#location button", { hasText: "show-entry.zip" }).click();
  await expect(page.locator("#archive-panel")).toBeVisible();
  await link(page).click();
  await expect(page.locator("#archive-panel")).toHaveCount(0);
  await expect(title(page)).toHaveText("same.txt");
  await expectRowInView(page, "same.txt");
  await page.goBack();
  await expect(page.locator("#archive-panel")).toBeVisible();
});

test("narrow, in the listed folder: one Back closes the preview on the row", async ({ page }) => {
  await open(page, NARROW, storedZip([["a.txt", 3], ...twice("same.txt")]));
  const before = await steps(page);
  await link(page).click();
  await expect(title(page)).toHaveText("same.txt");
  await expect(page.locator("#preview-back")).toBeFocused();
  expect(await steps(page)).toBe(before + 1);
  await page.goBack();
  await expect(page.locator("#preview-pane")).toHaveCount(0);
  await expect(page.locator("#preview-button")).toBeFocused();
  await expectRowInView(page, "same.txt");
});

test("narrow, in another folder: Back goes to the row, then to the old folder", async ({
  page,
}) => {
  await open(page, NARROW, storedZip([["a.txt", 3], ...twice("sub/same.txt")]));
  await expect(labels(page).first()).toHaveText("sub/");
  const before = await steps(page);
  await link(page).click();
  await expect(title(page)).toHaveText("same.txt");
  await expect(page.locator("#preview-back")).toBeFocused();
  expect(await steps(page)).toBe(before + 2);
  await page.locator("#preview-back").click();
  await expect(page.locator("#preview-pane")).toHaveCount(0);
  await expect(page.locator("#location")).toContainText("sub");
  await expectRowInView(page, "same.txt");
  await page.goBack();
  await expect(labels(page).first()).toHaveText("sub/");
});

const LARGE: [string, number][] = [
  ...Array.from({ length: 3000 }, (_, index): [string, number] => [
    `big/f${String(index).padStart(5, "0")}.txt`,
    5000 - index,
  ]),
  // In the middle of the default sort, and at the end of the archive.
  ...twice("big/same.txt", 3500),
];

for (const [name, width] of [
  ["wide", WIDE],
  ["narrow", NARROW],
] as const) {
  test(`${name}: a row far away in a large folder comes into view`, async ({ page }) => {
    await open(page, width, storedZip(LARGE));
    await link(page).click();
    await expect(title(page)).toHaveText("same.txt");
    if (width === NARROW) await page.locator("#preview-back").click();
    await expectRowInView(page, "same.txt");
  });

  test(`${name}: the health list leaves the row in view, in a short window`, async ({ page }) => {
    const hidden = Array.from({ length: 9 }, (_, index): [string, number] => [
      `big/x${index}‮txt`,
      1,
    ]);
    await open(page, width, storedZip([...LARGE, ...hidden, ["a\\b.txt", 1]]), 480);
    await expect(page.locator("#health-panel")).toBeVisible();
    await link(page).click();
    await expect(title(page)).not.toHaveText("");
    if (width === NARROW) await page.locator("#preview-back").click();
    await expect(page.locator("#health-panel")).toBeVisible();
    await expect(selected(page)).toHaveCount(1);
    const label = await selected(page).locator('[data-part="label"]').textContent();
    await expectRowInView(page, label!);
  });
}

test("a search that is active ends, and Back goes to it", async ({ page }) => {
  await open(page, WIDE, storedZip([["a.txt", 3], ["b/c.txt", 1], ...twice("sub/same.txt")]));
  await page.locator("#search-input").fill("c.txt");
  await expect(labels(page)).toHaveText(["b/c.txt"]);
  const before = await steps(page);
  await link(page).click();
  await expect(title(page)).toHaveText("same.txt");
  await expect(page.locator("#search-input")).toHaveValue("");
  await expectRowInView(page, "same.txt");
  expect(await steps(page)).toBe(before + 1);
  await page.goBack();
  await expect(page.locator("#search-input")).toHaveValue("c.txt");
  await expect(labels(page)).toHaveText(["b/c.txt"]);
  await expect(page.locator("#preview-pane")).toHaveCount(0);
});

test("a search from the same folder ends with the row, also with a chosen sort", async ({
  page,
}) => {
  await open(page, WIDE, storedZip([["a.txt", 3], ["b.txt", 2], ...twice("same.txt")]));
  const size = page.locator("#list-viewport [role=columnheader][data-column=size]");
  await size.getByRole("button").click();
  await expect(size).toHaveAttribute("aria-sort", "ascending");
  await page.locator("#search-input").fill("a.txt");
  await expect(labels(page)).toHaveText(["a.txt"]);
  await link(page).click();
  await expect(title(page)).toHaveText("same.txt");
  await expect(page.locator("#search-input")).toHaveValue("");
  await expectRowInView(page, "same.txt");
  await expect(size).toHaveAttribute("aria-sort", "ascending");
});

test("a sort that is active stays, and the row is selected at its place", async ({ page }) => {
  await open(page, WIDE, storedZip(LARGE));
  const name = nameSort(page);
  await name.getByRole("button").click();
  await expect(name).toHaveAttribute("aria-sort", /.+/);
  const sort = await name.getAttribute("aria-sort");
  await link(page).click();
  await expect(title(page)).toHaveText("same.txt");
  await expect(name).toHaveAttribute("aria-sort", sort!);
  await expectRowInView(page, "same.txt");
});

test("a sort that still runs lands first, and the row is selected at its place", async ({
  page,
}) => {
  await holdableWorkers(page);
  await open(page, WIDE, storedZip([["a.txt", 3], ["b.txt", 2], ...twice("same.txt")]));
  // The reply of the sort waits, so the sort still runs for the link.
  await holdWorkers(page);
  await nameSort(page).getByRole("button").click();
  await expect.poll(() => heldWorkers(page)).toBeGreaterThan(0);
  await link(page).click();
  // Two frames: the link has had its chance to act.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await expect(page.locator("#preview-pane")).toHaveCount(0);
  await releaseWorkers(page);
  await expect(title(page)).toHaveText("same.txt");
  await expectRowInView(page, "same.txt");
  await expect(nameSort(page)).toHaveAttribute("aria-sort", /.+/);
});

test("a search that starts while the link waits for a sort stays", async ({ page }) => {
  await holdableWorkers(page);
  await open(page, WIDE, storedZip([["a.txt", 3], ["b/c.txt", 1], ...twice("sub/same.txt")]));
  const before = await steps(page);
  await holdWorkers(page);
  await nameSort(page).getByRole("button").click();
  await expect.poll(() => heldWorkers(page)).toBeGreaterThan(0);
  await link(page).click();
  await page.locator("#search-input").fill("c.txt");
  await releaseWorkers(page);
  await expect(labels(page)).toHaveText(["b/c.txt"]);
  await expect(page.locator("#search-input")).toHaveValue("c.txt");
  await expect(page.locator("#search-input")).toBeFocused();
  await expect(page.locator("#preview-pane")).toHaveCount(0);
  expect(await steps(page)).toBe(before);
});

test("Back to the door before the folder of the row comes keeps the door and Return", async ({
  page,
}) => {
  await holdableWorkers(page);
  await open(page, WIDE, storedZip([["a.txt", 3], ...twice("sub/same.txt")]));
  const before = await steps(page);
  await holdWorkers(page);
  await link(page).click();
  await page.goBack();
  const back = page.getByRole("button", { name: "Return to show-entry.zip" });
  await expect(back).toBeVisible();
  await releaseWorkers(page);
  await expect.poll(() => heldWorkers(page)).toBe(0);
  // One more frame would show a late push or a late preview.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
  expect(await steps(page)).toBe(before);
  expect(await page.evaluate(() => history.state)).toMatchObject({ session: "", preview: false });
  await back.click();
  await expect(labels(page).first()).toHaveText("sub/");
  await link(page).click();
  await expect(title(page)).toHaveText("same.txt");
  await expectRowInView(page, "same.txt");
});

test("Back before the listing shows ends the wait of the row, also for a later visit", async ({
  page,
}) => {
  await holdableLists(page);
  const files = Array.from({ length: 300 }, (_, index): [string, number] => [
    `big/f${String(index).padStart(3, "0")}.txt`,
    600 - index,
  ]);
  await open(page, WIDE, storedZip([["e.txt", 1], ...files, ...twice("big/same.txt", 2)]));
  await holdLists(page);
  await link(page).click();
  await expect(title(page)).toHaveText("same.txt");
  await page.goBack();
  await expect(page.locator("#preview-pane")).toHaveCount(0);
  await releaseLists(page);
  await expect(page.locator(LISTING_ROWS).filter({ hasText: "e.txt" })).toBeVisible();
  await page.locator(LISTING_ROWS).filter({ hasText: "e.txt" }).click();
  await page.keyboard.press(" ");
  await expect(title(page)).toHaveText("e.txt");
  await page.locator(LISTING_ROWS).filter({ hasText: "big/" }).dblclick();
  await expect(page.locator("#location")).toContainText("big");
  await expect(labels(page).first()).toHaveText("f000.txt");
  await expect(title(page)).toHaveText("e.txt");
  // The grid has the keyboard focus, so the first row is the cursor.
  await expect(selected(page).locator('[data-part="label"]')).toHaveText("f000.txt");
  expect(await page.locator("#list-viewport").evaluate((view) => view.scrollTop)).toBe(0);
});

test("a keyboard Enter on the link selects the row and not the first row", async ({ page }) => {
  await open(page, WIDE, storedZip([["a.txt", 3], ...twice("same.txt")]));
  await link(page).focus();
  await page.keyboard.press("Enter");
  await expect(title(page)).toHaveText("same.txt");
  await expectRowInView(page, "same.txt");
});

test("a popup that is open shows the entry, and the pane stays closed", async ({
  page,
  context,
}) => {
  await open(page, WIDE, storedZip([["a.txt", 3], ...twice("same.txt")]));
  await page.locator(LISTING_ROWS).filter({ hasText: "a.txt" }).click();
  await page.keyboard.press(" ");
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    page.locator("#preview-popout").click(),
  ]);
  await expect(popup.locator('#preview-meta [data-field="path"]')).toHaveText("a.txt");
  await link(page).click();
  await expect(popup.locator('#preview-meta [data-field="path"]')).toHaveText("same.txt");
  await expect(page.locator("#preview-pane")).toHaveCount(0);
  await expectRowInView(page, "same.txt");
});

/** Opens an archive of more than one batch and stops the parse when the
 *  finding of a name with a control character shows. */
async function openDuringParse(page: Page): Promise<void> {
  await pauseBetweenBatches(page);
  await page.setViewportSize({ width: WIDE, height: 800 });
  const file = test.info().outputPath("show-entry.zip");
  const count = 200_000;
  writeFileSync(
    file,
    storedZip(
      [
        ["a.txt", 3],
        [`sub/x${"\u202E"}y.txt`, 1],
        ...Array.from({ length: count }, (_, index): [string, number] => [`f${index}`, 0]),
      ],
      BigInt(count + 2),
    ),
  );
  await page.goto("/");
  // Only the preloaded parse worker has the gate.
  await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "true");
  await openArchive(page, file);
  await expect.poll(() => gate(page)).toBeGreaterThan(0);
  // The bound only stops a loop that does not go forward.
  for (let step = 0; step < 64 && !(await page.locator("#health-toggle").isVisible()); step++) {
    const waits = await gate(page, true);
    await expect.poll(() => gate(page)).toBeGreaterThan(waits);
  }
  await expect(page.locator("#status")).not.toContainText("Listed in");
  await page.locator("#health-toggle").click();
}

test("during a parse, the row is selected when the listing has it", async ({ page }) => {
  await openDuringParse(page);
  await link(page).click();
  await expect(page.locator('#preview-meta [data-field="path"]')).toContainText("sub/x");
  await expect(selected(page)).toHaveCount(1);
  await openGate(page);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  await expect(selected(page)).toHaveCount(1);
  await expect(page.locator('#preview-meta [data-field="path"]')).toContainText("sub/x");
});

test("after Cancel, the link goes to a row of the partial listing", async ({ page }) => {
  await openDuringParse(page);
  await page.locator("#cancel-button").click();
  await openGate(page);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("cancelled");
  await link(page).click();
  await expect(page.locator('#preview-meta [data-field="path"]')).toContainText("sub/x");
  await expect(selected(page)).toHaveCount(1);
});

for (const [kind, fields, reason] of [
  ["encrypted", { flags: 0x801 }, "This entry is encrypted"],
  ["unknown method", { method: 77 }, "77"],
] as [string, Partial<HostileEntry>, string][]) {
  test(`an entry with an ${kind} body says why it does not show`, async ({ page }) => {
    const entry = { name: "sub/same.bin", body: Buffer.from("secret"), ...fields };
    await open(page, WIDE, hostileZip([{ name: "a.txt", body: Buffer.from("a") }, entry, entry]));
    await link(page).click();
    await expect(title(page)).toHaveText("same.bin");
    await expectRowInView(page, "same.bin");
    await expect(page.locator("#entry-preview")).toContainText(reason);
  });
}

test("the example of a folder entry selects its folder row", async ({ page }) => {
  await open(
    page,
    WIDE,
    storedZip([
      ["a.txt", 3],
      ["sub/d/", 0],
      ["sub/d/", 0],
      ["sub/e.txt", 1],
    ]),
  );
  await link(page).click();
  await expect(selected(page).locator('[data-part="label"]')).toHaveText("d/");
  await expect(title(page)).toHaveText("d");
  await expect(page.locator("#entry-preview")).not.toBeEmpty();
});
