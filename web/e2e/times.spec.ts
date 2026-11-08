// The "no time zone" mark of DOS times. A DOS time has no
// time zone. The table marks each DOS time only when the archive mixes
// DOS times and times with a time zone. When all times are DOS times, the
// column header notes it once and the cells have no mark.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { crc32 } from "./archive-zip";
import { openArchive, waitForOutcome } from "./listing";

const NOTE = "No time zone: these are DOS times as written";

/** A stored archive. Each entry has the DOS time 2024-05-01 09:13; with
 *  `zoned`, it also has an extended timestamp (UT) of that time in UTC. */
function timesZip(entries: { name: string; zoned: boolean }[]): Buffer {
  const dosDate = ((2024 - 1980) << 9) | (5 << 5) | 1;
  const dosTime = (9 << 11) | (13 << 5);
  const unix = Date.UTC(2024, 4, 1, 9, 13) / 1000;
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(`${entry.name}\n`);
    const extra = Buffer.alloc(entry.zoned ? 9 : 0);
    if (entry.zoned) {
      extra.writeUInt16LE(0x5455, 0);
      extra.writeUInt16LE(5, 2);
      extra.writeUInt8(1, 4);
      extra.writeUInt32LE(unix, 5);
    }
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name, extra);
    const part = Buffer.concat([local, name, extra, data]);
    parts.push(part);
    offset += part.length;
  }
  const records = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(records.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, records, end]);
}

async function open(page: Page, entries: { name: string; zoned: boolean }[]) {
  const file = test.info().outputPath("times.zip");
  writeFileSync(file, timesZip(entries));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
}

/** The modified cells of the entry rows, with their mark. */
function cells(page: Page) {
  return page
    .locator('#list-viewport [data-row]:not([hidden])[data-kind="entry"] [data-cell="modified"]')
    .evaluateAll((list) =>
      list.map((cell) => ({
        text: cell.textContent ?? "",
        marked: getComputedStyle(cell).textDecorationStyle === "dotted",
      })),
    );
}

const header = (page: Page) =>
  page.locator("#list-viewport [role=columnheader][data-column=modified]").getByRole("button");

test("all DOS times: the header notes it once and no cell has the mark", async ({ page }) => {
  await open(page, [
    { name: "a.txt", zoned: false },
    { name: "b.txt", zoned: false },
    { name: "c.txt", zoned: false },
  ]);
  const list = await cells(page);
  expect(list).toHaveLength(3);
  expect(list.every((cell) => cell.text === "2024-05-01 09:13" && !cell.marked)).toBe(true);
  // The note was only a title, which a sighted keyboard user does not see. It is now a
  // card that shows on hover and on focus, and the description of the
  // button.
  await expect(header(page)).not.toHaveAttribute("title");
  await expect(header(page)).toHaveAccessibleDescription(NOTE);
  const card = page.locator("#dos-note");
  await expect(card).toBeHidden();
  await header(page).focus();
  await expect(card).toBeVisible();
  await expect(card).toHaveText(NOTE);
  await expect(card).toHaveAttribute("role", "tooltip");
  // Escape hides it, and the focus stays.
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(header(page)).toBeFocused();
  await page.locator("#list-viewport").focus();
  // The pointer shows it too, and it stays while the pointer is on it.
  await header(page).hover();
  await expect(card).toBeVisible();
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(card).toBeVisible();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 200);
  await expect(card).toBeHidden();
  // The header label has the dotted mark, once.
  expect(
    await header(page)
      .locator("span")
      .first()
      .evaluate((label) => getComputedStyle(label).textDecorationStyle),
  ).toBe("dotted");
  // Each cell keeps its exact time on hover.
  await expect(
    page.locator('#list-viewport [data-kind="entry"] [data-cell="modified"]').first(),
  ).toHaveAttribute("title", /^No time zone: DOS time as written, 2024-05-01 09:13:00$/);
});

test("the DOS note stays while the button has the focus, and follows the button", async ({
  page,
}) => {
  await open(page, [
    { name: "a.txt", zoned: false },
    { name: "b.txt", zoned: false },
  ]);
  const card = page.locator("#dos-note");
  // The pointer goes away while the button keeps the focus: the card
  // stays.
  await header(page).focus();
  await header(page).hover();
  await page.mouse.move(10, 800);
  await expect(card).toBeVisible();
  await expect(header(page)).toBeFocused();
  /** The gap below the button and the distance between the right edges. */
  const offsets = async () => {
    const button = (await header(page).boundingBox())!;
    const box = (await card.boundingBox())!;
    return {
      top: Math.round(box.y - (button.y + button.height)),
      right: Math.round(box.x + box.width - (button.x + button.width)),
    };
  };
  // Near the right edge, the card aligns its right edge with the button.
  expect(await offsets()).toEqual({ top: 0, right: 0 });
  // Anchor positioning keeps the card below the button when the window
  // changes size.
  await page.setViewportSize({ width: 1300, height: 900 });
  await expect.poll(offsets).toEqual({ top: 0, right: 0 });
  await page.locator("#list-viewport").focus();
  await expect(card).toBeHidden();
});

test("mixed DOS and zoned times: each DOS time has the mark", async ({ page }) => {
  await open(page, [
    { name: "a.txt", zoned: false },
    { name: "b.txt", zoned: true },
    { name: "c.txt", zoned: false },
  ]);
  const list = await cells(page);
  expect(list.map((cell) => cell.marked)).toEqual([true, false, true]);
  await expect(header(page)).not.toHaveAttribute("title");
  await header(page).focus();
  await expect(page.locator("#dos-note")).toBeHidden();
  await expect(header(page)).toHaveAccessibleDescription("");
  expect(
    await header(page)
      .locator("span")
      .first()
      .evaluate((label) => getComputedStyle(label).textDecorationStyle),
  ).not.toBe("dotted");
});

test("zoned times only: no mark and no header note", async ({ page }) => {
  await open(page, [
    { name: "a.txt", zoned: true },
    { name: "b.txt", zoned: true },
  ]);
  const list = await cells(page);
  expect(list.map((cell) => cell.marked)).toEqual([false, false]);
  await expect(header(page)).not.toHaveAttribute("title");
});
