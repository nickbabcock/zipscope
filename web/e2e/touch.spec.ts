// The layout for a coarse primary pointer (a touch screen): 36 px rows, a
// chevron over the full row height, and larger targets. A fine pointer
// keeps the dense layout.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openArchive, waitForOutcome } from "./listing";
import { gate, openGate, pauseBetweenBatches } from "./parse-gate";
import { storedZip } from "./stored-zip";

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const tableRow = (page: Page, text: string) =>
  page.locator("#list-viewport [data-row]:not([hidden])", { hasText: text }).first();
const treeRow = (page: Page, name: string) =>
  page
    .locator("#tree-viewport [role=treeitem]:not([hidden])")
    .filter({ has: page.getByText(name, { exact: true }) })
    .first();
/** The box of an element, to 0.01 px: a transform can give a width such
 *  as 16.000002. */
const box = async (locator: Locator) => {
  const { x, y, width, height } = (await locator.boundingBox())!;
  const round = (value: number) => Math.round(value * 100) / 100;
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
};
/** The heights of the shown items of the row menu. */
const menuItems = (page: Page) =>
  page
    .locator("#row-menu [role=menuitem]")
    .evaluateAll((items) =>
      items
        .filter((item) => item.checkVisibility())
        .map((item) => item.getBoundingClientRect().height),
    );

/** Returns true when each point hits the element or a part of it. A hit on
 *  the `::after` hit area of the element is a hit on the element. */
const hitsAll = (locator: Locator, points: [number, number][]) =>
  locator.evaluate(
    (element, list) => list.every(([x, y]) => element.contains(document.elementFromPoint(x, y))),
    points,
  );

async function openStored(page: Page, entries: [string, number][]) {
  const file = test.info().outputPath("touch.zip");
  writeFileSync(file, storedZip(entries));
  await page.goto("/");
  await openArchive(page, file);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
}

async function openSample(page: Page) {
  await page.goto("/");
  await page.locator("#sample-button").click();
  await waitForOutcome(page);
}

/** Opens the sample and lists a deep folder, so the breadcrumb has its "…". */
async function openDeep(page: Page) {
  await openSample(page);
  for (const name of ["share/", "demo-app/", "web/", "static/", "js/"]) {
    await tableRow(page, name).click();
    await expect(page.locator("#location")).toContainText(name.slice(0, -1));
  }
  await expect(page.locator("#location-more")).toBeVisible();
}

test.describe("a coarse pointer", () => {
  test.use(PHONE);

  test("gets 36 px rows, and the chevron is the full row height", async ({ page }) => {
    await openStored(page, [
      ["docs/a.txt", 10],
      ["docs/sub/b.txt", 10],
      ["src/c.txt", 10],
    ]);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const docs = tableRow(page, "docs/");
    const row = await box(docs);
    expect(row.height).toBe(36);
    const toggle = await box(docs.locator('[data-part="toggle"]'));
    expect(toggle.width).toBe(32);
    // The full row less its 1 px rule.
    expect(toggle.height).toBe(35);
    expect(
      await hitsAll(docs.locator('[data-part="toggle"]'), [
        [toggle.x + 1, row.y + 1],
        [toggle.x + 31, row.y + 1],
        [toggle.x + 1, row.y + 34],
        [toggle.x + 31, row.y + 34],
      ]),
    ).toBe(true);
    // A tap at a corner of the hit area opens the folder in the table.
    await page.touchscreen.tap(toggle.x + 30, row.y + 2);
    await expect(docs).toHaveAttribute("aria-expanded", "true");
    await expect(tableRow(page, "sub/")).toBeVisible();
    // The open chevron turns, and its hit area stays.
    expect(await box(docs.locator('[data-part="toggle"]'))).toEqual(toggle);

    await page.locator("#drawer-button").click();
    const folder = treeRow(page, "docs");
    await expect(folder).toBeVisible();
    // The drawer moves in. Wait until the row stays in place.
    let last = "";
    await expect
      .poll(async () => {
        const now = JSON.stringify(await box(folder));
        const still = now === last;
        last = now;
        return still;
      })
      .toBe(true);
    const tree = await box(folder);
    expect(tree.height).toBe(36);
    const chevron = await box(folder.locator('[data-part="toggle"]'));
    expect([chevron.width, chevron.height]).toEqual([32, 36]);
    await page.touchscreen.tap(chevron.x + 1, tree.y + 35);
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(await box(folder.locator('[data-part="toggle"]'))).toEqual(chevron);
  });

  test("fits the largest files block with 36 px rows", async ({ page }) => {
    // The root lists two folders. The block needs (2 + 11) × 36 + 8 = 476 px
    // below the column header; with 24 px rows it needs 320 px.
    const entries: [string, number][] = [
      ["app/src/main.rs", 3000],
      ["app/deep/huge.bin", 9000],
      ["other/outside.bin", 20000],
    ];
    const label = page.locator('#list-viewport [data-kind="heading"]:not([hidden])');
    const room = () =>
      page.locator("#list-viewport").evaluate((element) => element.clientHeight - 28);
    await page.setViewportSize({ width: 390, height: 600 });
    await openStored(page, entries);
    await expect(tableRow(page, "other/")).toBeVisible();
    const low = await room();
    expect(low).toBeGreaterThanOrEqual(13 * 24 + 8);
    expect(low).toBeLessThan(13 * 36 + 8);
    await expect(label).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await room()).toBeGreaterThanOrEqual(13 * 36 + 8);
    await expect(label).toHaveCount(1);
  });

  test("maps the scroll position with 36 px rows", async ({ page }) => {
    const names = Array.from({ length: 400 }, (_, index) => `f${String(index).padStart(3, "0")}`);
    await openStored(
      page,
      names.map((name) => [name, 1]),
    );
    await page.locator("#list-viewport [role=columnheader][data-column=name] button").click();
    await expect(tableRow(page, "f000")).toBeVisible();
    const viewport = page.locator("#list-viewport");
    await viewport.evaluate((element) => (element.scrollTop = 100 * 36));
    const top = (await box(viewport)).y + 28;
    await expect
      .poll(async () => {
        const row = page.locator('#list-viewport [data-row="100"]');
        return (await row.isVisible()) ? Math.round((await box(row)).y - top) : undefined;
      })
      .toBe(0);
    await expect(page.locator('#list-viewport [data-row="100"]')).toContainText("f100");
  });

  test("keeps the top row of the tree when the name order lands", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 500 });
    const tree = page.locator("#tree-viewport");
    const names = Array.from(
      { length: 5000 },
      (_, index) => `n${String((index * 7919) % 5000).padStart(4, "0")}/f.txt`,
    );
    await pauseBetweenBatches(page);
    await page.goto("/");
    await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "true");
    await page.locator("#file-input").setInputFiles({
      name: "held.zip",
      mimeType: "application/zip",
      buffer: storedZip(names.map((name) => [name, 1])),
    });
    await expect.poll(() => gate(page)).toBe(1);
    await gate(page, true);
    await expect.poll(() => gate(page)).toBe(2);
    await expect(tree).toHaveAttribute("data-order", "archive");
    const topLabel = () =>
      tree.evaluate((element) => {
        const y = Math.round(element.getBoundingClientRect().top);
        const rows = [...element.querySelectorAll<HTMLElement>("[role=treeitem]:not([hidden])")]
          .sort((a, b) => Number(a.dataset.row) - Number(b.dataset.row))
          .filter((row) => Math.round(row.getBoundingClientRect().top) >= y);
        return [rows[0]?.dataset.row, rows[0]?.querySelector('[data-part="label"]')?.textContent];
      });
    await tree.evaluate((element) => element.scrollTo(0, 36 * 30));
    await expect.poll(async () => (await topLabel())[0]).toBe("30");
    const first = (await topLabel())[1];
    await openGate(page);
    await waitForOutcome(page);
    await expect(tree).toHaveAttribute("data-order", "name");
    await expect.poll(async () => (await topLabel())[1]).toBe(first);
  });

  test("gets larger targets in the menus, the strips and the front door", async ({ page }) => {
    await page.goto("/");
    for (const id of ["front-open", "sample-button"]) {
      expect((await box(page.locator(`#${id}`))).height, id).toBe(44);
    }
    await page.locator("#sample-button").click();
    await waitForOutcome(page);
    expect((await box(page.locator("#drawer-button"))).height).toBe(36);

    await tableRow(page, "share/").click({ button: "right" });
    await expect(page.locator("#row-menu")).toBeVisible();
    expect(Math.min(...(await menuItems(page)))).toBe(40);
    await page.keyboard.press("Escape");

    await page.locator("#health-toggle").click();
    const show = page.locator('[data-action="show-entry"]');
    const link = await box(show);
    const middle = link.y + link.height / 2;
    expect(
      await hitsAll(show, [
        [link.x - 7, middle - 17],
        [link.x + link.width + 7, middle + 17],
      ]),
    ).toBe(true);
    await page.locator("#health-toggle").click();

    for (const name of ["share/", "demo-app/", "web/", "static/", "js/"]) {
      await tableRow(page, name).click();
      await expect(page.locator("#location")).toContainText(name.slice(0, -1));
    }
    const more = page.locator("#location-more");
    expect(await box(more)).toMatchObject({ width: 36, height: 36 });
    await more.click();
    const levels = page.locator("#location-menu button");
    await expect(levels.first()).toBeVisible();
    for (const level of await levels.all()) expect((await box(level)).height).toBe(40);
  });

  for (const width of [390, 768]) {
    test(`keeps the taps of the controls next to the breadcrumb "…" at ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const menu = page.locator("#location-menu");
      const current = page.locator('#location [aria-current="location"]');
      // The control before the "…": the drawer button in the narrow layout,
      // which has no root segment, else the root segment.
      const before = page.locator("#location li:has(+ li #location-more) button");
      const after = page.locator("#location li:has(#location-more) + li button");
      // A tap 2 px inside the edge of a control: the touch point is in
      // whole pixels, and an edge can be at a fraction of a pixel.
      const tapAt = async (x: number, y: number) => {
        await page.touchscreen.tap(x, y);
        await expect(menu).not.toBeVisible();
      };
      const middle = (rect: { y: number; height: number }) => rect.y + rect.height / 2;

      await openDeep(page);
      const drawer = await box(page.locator("#drawer-button"));
      await tapAt(Math.floor(drawer.x + drawer.width) - 2, middle(drawer));
      await expect(page.locator("#drawer-button")).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(page.locator("#drawer-button")).toHaveAttribute("aria-expanded", "false");

      const label = (await after.textContent()) ?? "";
      const next = await box(after);
      await tapAt(Math.ceil(next.x) + 2, middle(next));
      await expect(current).toHaveText(label);

      if (width > 390) {
        for (const name of ["web/", "static/", "js/"]) await tableRow(page, name).click();
        await expect(current).toHaveText("js");
        const root = await box(before);
        await tapAt(Math.floor(root.x + root.width) - 2, middle(root));
        await expect(page.locator("#archive-panel")).toBeVisible();
      } else {
        await expect(before).toHaveCount(0);
      }
    });
  }

  for (const width of [320, 360, 375]) {
    test(`holds the 44 px buttons in the action row of the front door at ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto("/");
      const row = await box(page.locator("#door-row"));
      const action = await box(page.locator("#door-action"));
      const buttons = await box(page.locator("#door-buttons"));
      expect(buttons.height).toBe(44);
      expect(action.y).toBeGreaterThanOrEqual(row.y);
      expect(buttons.y + buttons.height).toBeLessThanOrEqual(row.y + row.height);
    });
  }

  test("gets a 36 px hit area on Load more", async ({ page }) => {
    await openSample(page);
    await tableRow(page, "debug/demo-app.debug").dblclick();
    const more = page.locator("#preview-more");
    await expect(more).toBeVisible();
    // 36 px and the 1 px rule above it.
    expect((await box(page.locator("#preview-footer"))).height).toBe(37);
    const link = await box(more);
    expect(
      await hitsAll(more, [
        [link.x - 7, link.y + link.height / 2 - 17],
        [link.x + link.width + 7, link.y + link.height / 2 + 17],
      ]),
    ).toBe(true);
  });
});

test("a fine pointer keeps the dense layout", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto("/");
  expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true);
  for (const id of ["front-open", "sample-button"]) {
    expect((await box(page.locator(`#${id}`))).height, id).toBe(36);
  }
  await page.locator("#sample-button").click();
  await waitForOutcome(page);
  const share = tableRow(page, "share/");
  expect((await box(share)).height).toBe(24);
  expect(await box(share.locator('[data-part="toggle"]'))).toMatchObject({ width: 16, height: 16 });
  const root = treeRow(page, "demo-app-2.4.0");
  if (!(await root.isVisible())) await page.locator("#drawer-button").click();
  expect((await box(root)).height).toBe(24);
  expect(await box(root.locator('[data-part="toggle"]'))).toMatchObject({ width: 16, height: 16 });
  expect(await root.evaluate((row) => row.style.paddingLeft)).toBe("24px");
  await page.keyboard.press("Escape");

  await share.click({ button: "right" });
  await expect(page.locator("#row-menu")).toBeVisible();
  expect(
    await page
      .locator("#row-menu [role=menuitem]")
      .first()
      .evaluate((item) => getComputedStyle(item).minHeight),
  ).toBe("28px");
  await page.keyboard.press("Escape");

  await page.locator("#health-toggle").click();
  const show = page.locator('[data-action="show-entry"]');
  expect(await show.evaluate((element) => getComputedStyle(element, "::after").content)).toBe(
    "none",
  );
  await page.locator("#health-toggle").click();

  for (const name of ["share/", "demo-app/", "web/", "static/", "js/"]) {
    await tableRow(page, name).click();
    await expect(page.locator("#location")).toContainText(name.slice(0, -1));
  }
  const more = page.locator("#location-more");
  if (await more.isVisible()) {
    expect(await box(more)).toMatchObject({ width: 24, height: 24 });
    expect(await more.evaluate((element) => getComputedStyle(element, "::after").content)).toBe(
      "none",
    );
  }
});
