// Numbers in the browser locale: the group and
// decimal marks of the locale, Latin digits in all locales, and one fixed
// form in copied text. The config sets en-US. These tests set de-DE and
// ar-EG. ar-EG without Latin digits would show Arabic-Indic digits.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { LISTING_ROWS, openArchive, waitForOutcome } from "./listing";
import { storedZip } from "./stored-zip";

const ENTRIES: [string, number][] = [
  ["a.bin", 1126],
  ["b.bin", 9113],
  ["c.bin", 1_048_000],
  ...Array.from({ length: 1000 }, (_, index): [string, number] => [`many/${index}`, 0]),
];

const LOCALES = [
  {
    locale: "de-DE",
    small: "1,1 KiB",
    other: "8,9 KiB",
    wide: "1023,4 KiB",
    hover: "1.126 bytes",
    ratio: "100,0%",
    folder: "1.000",
    listed: "1.003 entries listed",
  },
  {
    locale: "ar-EG",
    small: "1.1 KiB",
    other: "8.9 KiB",
    wide: "1023.4 KiB",
    hover: "1,126 bytes",
    ratio: "100.0%",
    folder: "1,000",
    listed: "1,003 entries listed",
  },
];

async function open(page: Page) {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { copied: string[] }).copied = copied;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void copied.push(text) },
    });
  });
  const file = test.info().outputPath("numbers.zip");
  writeFileSync(file, storedZip(ENTRIES));
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
}

const row = (page: Page, name: string) => page.locator(LISTING_ROWS).filter({ hasText: name });
const sizeText = (page: Page, name: string) =>
  row(page, name).locator('[data-cell="size"] > span').last();

for (const expected of LOCALES) {
  test.describe(expected.locale, () => {
    test.use({ locale: expected.locale });

    test("the table, the hover and the status bar use the locale with Latin digits", async ({
      page,
    }) => {
      await open(page);
      await expect(sizeText(page, "a.bin")).toHaveText(expected.small);
      await expect(sizeText(page, "b.bin")).toHaveText(expected.other);
      await expect(sizeText(page, "c.bin")).toHaveText(expected.wide);
      await expect(row(page, "a.bin").locator('[data-cell="ratio"]')).toHaveText(expected.ratio);
      await expect(row(page, "many").locator('[data-cell="entries"]')).toHaveText(expected.folder);
      await expect(page.locator("#entries-listed")).toHaveText(expected.listed);
      // The size hover gives the exact byte count.
      await sizeText(page, "a.bin").hover();
      await expect(sizeText(page, "a.bin")).toHaveAttribute("title", expected.hover);
      // No digit that is not Latin.
      const text = await page.locator("#list-viewport").innerText();
      expect(text).not.toMatch(/[٠-٩۰-۹]/);
    });

    test("the size column keeps its tabular width", async ({ page }) => {
      await open(page);
      // The width of the text, not of its grid track.
      const width = (name: string) =>
        sizeText(page, name).evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getBoundingClientRect().width;
        });
      // Tabular digits: two sizes with the same form have the same width.
      const small = await width("a.bin");
      expect(small).toBeGreaterThan(0);
      expect(Math.abs(small - (await width("b.bin")))).toBeLessThan(0.5);
      const numeric = await sizeText(page, "a.bin").evaluate(
        (element) => getComputedStyle(element).fontVariantNumeric,
      );
      expect(numeric).toContain("tabular-nums");
    });

    test("Copy row has the fixed form of the numbers", async ({ page }) => {
      await open(page);
      await row(page, "a.bin").click({ button: "right" });
      await page.keyboard.press("r");
      const copied = () => page.evaluate(() => (window as unknown as { copied: string[] }).copied);
      await expect.poll(copied).toEqual(["a.bin\t1126\t1126\t100.0%\tStored\t"]);
    });
  });
}
