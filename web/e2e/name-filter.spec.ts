// Hostile names on the screen. A name and a
// comment come from the archive. A bidi control, a control character or an
// invisible format character shows as a visible mark on each surface, and a
// right-to-left name reads correctly with its extension at the right. The
// true name stays for the search, the copies and the extraction.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { panelZip } from "./archive-zip";
import { contentZip, png } from "./content-zip";
import { dropArchive, openArchive, waitForOutcome } from "./listing";
import { storedZip } from "./stored-zip";

const MARK = "◊";
const RLO = "invoice\u202Efdp.exe";
const ISOLATES = "report\u2067.pdf\u2069.exe";
const LINE = "line\nbreak.txt";
const ZERO_WIDTH = "setup.p\u200Bdf";
/** A decoder with no `ignoreBOM` removes this first character. */
const BOM = "\uFEFFbom.txt";
const ARABIC = "تقرير المبيعات.pdf";
const HEBREW = "דוח שנתי.pdf";
const PERSIAN = "می\u200Cخواهم.pdf";
const NUMBER = "تقرير.7z";
const SPOOF = "م.pdf.م.exe";
const BRACKETS = "דוח (סופי).docx";
const YEAR = "דוח 2024.pdf";
const HOSTILE_FOLDER = "dir\u202Erid";
const ENTRIES = [
  RLO,
  ISOLATES,
  LINE,
  ZERO_WIDTH,
  BOM,
  ARABIC,
  HEBREW,
  PERSIAN,
  NUMBER,
  SPOOF,
  BRACKETS,
  YEAR,
  `${HOSTILE_FOLDER}/inner\u202Etxt.exe`,
  "مجلد/تقرير.pdf",
  "plain.txt",
];
/** The entries with a name that shows a mark. */
const MARKED = 6;
const ARCHIVE_NAME = "arch\u202Epiz.zip";

/** Returns an archive of empty entries, with names as bytes and their flags. */
function rawNameZip(entries: [Buffer, number][]): Buffer {
  const central = entries.map(([name, flags]) => {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(name.length, 28);
    return Buffer.concat([record, name]);
  });
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  return Buffer.concat([directory, end]);
}

const content = (name: string) => ({ name, data: Buffer.from("data") });

async function open(page: Page, width = 1440): Promise<string> {
  await page.setViewportSize({ width, height: 900 });
  const folder = test.info().outputPath("files");
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, ARCHIVE_NAME);
  writeFileSync(file, contentZip(ENTRIES.map(content)));
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  return file;
}

const rows = (page: Page) => page.locator("#list-viewport [data-row]:not([hidden])");
const folderRow = (page: Page, text: string) =>
  page.locator('#list-viewport [data-kind="folder"]:not([hidden])').filter({ hasText: text });
const labelOf = (page: Page, text: string) =>
  rows(page).locator('[data-part="label"]', { hasText: text });

/**
 * Returns each text on the page that has a raw character to mark: text
 * nodes and the attributes that show, and the document title. The only
 * bidi characters that can stay are the isolates of a right-to-left part. A
 * comment keeps its line breaks and tabs.
 */
function rawTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const raw =
      // oxlint-disable-next-line no-control-regex, no-misleading-character-class -- These characters are what the test looks for.
      /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B\u200E\u200F\u2028-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF0-\uFFFB]/;
    const bad = (text: string) => raw.test(text.replace(/\u2067[^\u2067\u2069]*\u2069/g, ""));
    const found: string[] = [];
    const check = (where: string, text: string | null) => {
      if (text !== null && bad(text)) found.push(`${where}: ${JSON.stringify(text)}`);
    };
    check("document title", document.title);
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.currentNode; node !== null; node = walker.nextNode()!) {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement!;
        // The static page has line breaks between its elements.
        if (parent === document.body || parent.closest("style, script") !== null) continue;
        const text = node.textContent ?? "";
        check(
          parent.tagName,
          parent.id === "archive-comment-text" ? text.replace(/[\n\t]/g, "") : text,
        );
      } else {
        const element = node as Element;
        for (const name of ["title", "aria-label", "alt", "placeholder"]) {
          check(`${element.tagName} ${name}`, element.getAttribute(name));
        }
      }
    }
    return found;
  });
}

test("no surface shows a raw control character", async ({ page, context }) => {
  await open(page);
  await expect(page.locator("#archive-name")).toHaveText(`arch${MARK}piz.zip`);
  await expect(page.locator("#archive-name")).toHaveAttribute("title", "arch[U+202E]piz.zip");
  await expect(page.locator("#archive-name")).toHaveAttribute("dir", "ltr");
  await expect(labelOf(page, `invoice${MARK}fdp.exe`)).toHaveCount(1);
  await expect(labelOf(page, `report${MARK}.pdf${MARK}.exe`)).toHaveCount(1);
  await expect(labelOf(page, `line${MARK}break.txt`)).toHaveCount(1);
  await expect(labelOf(page, `setup.p${MARK}df`)).toHaveCount(1);
  await expect(labelOf(page, `${MARK}bom.txt`)).toHaveCount(1);
  expect(await rawTexts(page)).toEqual([]);

  // The tree and the breadcrumb.
  await expect(
    page.locator("#tree-viewport [role=treeitem]").filter({ hasText: `dir${MARK}rid` }),
  ).toHaveCount(1);
  await folderRow(page, `dir${MARK}rid`).dblclick();
  await expect(page.locator('nav[aria-label="Location"]')).toContainText(`dir${MARK}rid`);
  expect(await rawTexts(page)).toEqual([]);
  await page.goBack();

  // The health list and its link.
  await page.locator("#health-toggle").click();
  const finding = page.locator('[data-finding="control-names"]');
  await expect(finding).toContainText(`${MARKED} entries have names with hidden or control`);
  await expect(finding).toHaveAttribute("data-severity", "warning");
  await expect(finding.locator('[data-action="show-entry"]')).toHaveAttribute(
    "aria-label",
    `Show entry invoice${MARK}fdp.exe`,
  );
  expect(await rawTexts(page)).toEqual([]);

  // The preview title and its facts, and the popup with its title.
  await finding.locator('[data-action="show-entry"]').click();
  // The link goes to the entry: the history entry has its true name.
  await expect
    .poll(() => page.evaluate(() => (history.state as { entry?: string }).entry))
    .toBe(RLO);
  const pane = page.locator("#preview-pane");
  await expect(pane.locator("span[title]").first()).toHaveText(`invoice${MARK}fdp.exe`);
  await expect(pane.locator('[data-field="path"]')).toHaveText(`invoice${MARK}fdp.exe`);
  expect(await rawTexts(page)).toEqual([]);
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    page.locator("#preview-popout").click(),
  ]);
  await expect(popup.locator("#popup-title")).toHaveText(`invoice${MARK}fdp.exe`);
  await expect(popup).toHaveTitle(`invoice${MARK}fdp.exe · Zipscope`);
  expect(await rawTexts(popup)).toEqual([]);
  await popup.close();
});

test("an image preview has the mark in its alternative text", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const file = test.info().outputPath("image.zip");
  writeFileSync(file, contentZip([{ name: "pic\u202Egnp.png", data: png(4, 4) }]));
  await page.goto("/");
  await openArchive(page, file);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await labelOf(page, `pic${MARK}gnp.png`).click();
  await page.keyboard.press(" ");
  await expect(page.locator("#preview-pane img")).toHaveAttribute("alt", `pic${MARK}gnp.png`);
  expect(await rawTexts(page)).toEqual([]);
});

test("a Mac icon file keeps its mark and gives no warning", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const file = test.info().outputPath("icon.zip");
  writeFileSync(
    file,
    storedZip([
      ["Pictures/Icon\r", 1],
      ["__MACOSX/Pictures/._Icon\r", 1],
      ["Icon\r", 1],
      ["top.txt", 1],
    ]),
  );
  await page.goto("/");
  await openArchive(page, file);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  const label = labelOf(page, `Icon${MARK}`).first();
  await expect(label).toBeVisible();
  await expect(
    label.locator('xpath=ancestor::*[@role="row"]').locator('[data-part="mark"]'),
  ).toBeHidden();
  await expect(page.locator("#health-strip")).toHaveCount(0);
  expect(await rawTexts(page)).toEqual([]);
});

test("a line break does not draw over the next row", async ({ page }) => {
  await open(page);
  const label = labelOf(page, `line${MARK}break.txt`);
  const box = await label.boundingBox();
  const plain = await labelOf(page, "plain.txt").boundingBox();
  expect(box!.height).toBe(plain!.height);
  // The row of the name holds its label.
  const row = await label.locator('xpath=ancestor::*[@role="row"]').boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(row!.y);
  expect(box!.y + box!.height).toBeLessThanOrEqual(row!.y + row!.height);
});

/** The left and right edge of a part of the text of a label, on the screen. */
function edgesOf(page: Page, title: string, part: string) {
  return page.evaluate(
    ({ title: wanted, part: text }) => {
      const label = [
        ...document.querySelectorAll<HTMLElement>('#list-viewport [data-part="label"]'),
      ].find((item) => item.title === wanted)!;
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.textContent!.lastIndexOf(text);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        const rects = [...range.getClientRects()];
        return {
          left: Math.min(...rects.map((r) => r.left)),
          right: Math.max(...rects.map((r) => r.right)),
        };
      }
      throw new Error(`no ${text} in ${wanted}`);
    },
    { title, part },
  );
}

test("a right-to-left name keeps its extension at the right, in its order", async ({ page }) => {
  await open(page);
  for (const [name, base, extension] of [
    [ARABIC, "المبيعات", ".pdf"],
    [HEBREW, "שנתי", ".pdf"],
    [PERSIAN, "خواهم", ".pdf"],
    [NUMBER, "تقرير", ".7z"],
    [SPOOF, "م", ".exe"],
  ] as const) {
    const left = await edgesOf(page, name, base);
    const right = await edgesOf(page, name, extension);
    expect(right.left, name).toBeGreaterThanOrEqual(left.right - 1);
  }
  // The right-to-left part reads from right to left: the first word is at
  // the right of the second word.
  const first = await edgesOf(page, ARABIC, "تقرير");
  const second = await edgesOf(page, ARABIC, "المبيعات");
  expect(first.left).toBeGreaterThanOrEqual(second.right - 1);
  // A pair of brackets stays whole, in the right-to-left part. From the left:
  // the logical close bracket, the second word, the logical open bracket, the
  // first word, then the extension.
  const closing = await edgesOf(page, BRACKETS, ")");
  const word = await edgesOf(page, BRACKETS, "סופי");
  const opening = await edgesOf(page, BRACKETS, "(");
  const start = await edgesOf(page, BRACKETS, "דוח");
  const end = await edgesOf(page, BRACKETS, ".docx");
  expect(word.left).toBeGreaterThanOrEqual(closing.right - 1);
  expect(opening.left).toBeGreaterThanOrEqual(word.right - 1);
  expect(start.left).toBeGreaterThanOrEqual(opening.right - 1);
  expect(end.left).toBeGreaterThanOrEqual(start.right - 1);
  // A number at the end reads after the word, from the right.
  const year = await edgesOf(page, YEAR, "2024");
  const report = await edgesOf(page, YEAR, "דוח");
  const extension = await edgesOf(page, YEAR, ".pdf");
  expect(report.left).toBeGreaterThanOrEqual(year.right - 1);
  expect(extension.left).toBeGreaterThanOrEqual(report.right - 1);
  // A real name has no mark and no finding of its own.
  for (const name of [ARABIC, HEBREW, PERSIAN, NUMBER, SPOOF, BRACKETS, YEAR]) {
    const label = page.locator(`#list-viewport [data-part="label"][title="${name}"]`);
    await expect(label).toHaveCount(1);
    expect(await label.textContent()).not.toContain(MARK);
    await expect(
      label.locator('xpath=ancestor::*[@role="row"]').locator('[data-part="mark"]'),
    ).toBeHidden();
  }
});

test("each path segment has its own direction in the results of a search", async ({ page }) => {
  await open(page);
  await page.getByLabel("Search names").fill("تقرير.pdf");
  await expect(rows(page)).toHaveCount(1);
  const name = "مجلد/تقرير.pdf";
  const folder = await edgesOf(page, name, "مجلد");
  const base = await edgesOf(page, name, "تقرير");
  const extension = await edgesOf(page, name, ".pdf");
  // The folder comes first, the base after it, and the extension last.
  expect(base.left).toBeGreaterThanOrEqual(folder.right - 1);
  expect(extension.left).toBeGreaterThanOrEqual(base.right - 1);
});

test("the search uses the true name", async ({ page }) => {
  await open(page);
  const search = page.getByLabel("Search names");
  // The name reads as `invoiceexe.pdf` with no filter: that text is not in
  // the true name, so the search does not find it.
  await search.fill("invoiceexe.pdf");
  await expect(rows(page)).toHaveCount(0);
  await search.fill("fdp.exe");
  await expect(labelOf(page, `invoice${MARK}fdp.exe`)).toHaveCount(1);
  // The character itself finds the name that has it.
  await search.fill("\u202E");
  await expect(labelOf(page, `invoice${MARK}fdp.exe`)).toHaveCount(1);
  // A mark is not a part of a name.
  await search.fill(`invoice${MARK}fdp`);
  await expect(rows(page)).toHaveCount(0);
  // A name with a zero-width character does not match the text that it
  // looks like, and its label shows why.
  await search.fill("setup.pdf");
  await expect(rows(page)).toHaveCount(0);
  await search.fill("setup");
  await expect(labelOf(page, `setup.p${MARK}df`)).toHaveCount(1);
});

test("the copies and the title of a name", async ({ page }) => {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { copied: string[] }).copied = copied;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void copied.push(text) },
    });
  });
  await open(page);
  const label = labelOf(page, `invoice${MARK}fdp.exe`);
  await expect(label).toHaveAttribute("title", "invoice[U+202E]fdp.exe");
  await expect(labelOf(page, `line${MARK}break.txt`)).toHaveAttribute(
    "title",
    "line[U+000A]break.txt",
  );
  await expect(page.locator(`#list-viewport [data-part="label"][title="${ARABIC}"]`)).toHaveCount(
    1,
  );
  const copied = () => page.evaluate(() => (window as unknown as { copied: string[] }).copied);
  await label.click({ button: "right" });
  await page.locator('#row-menu [data-action="copy-path"]').click();
  await expect.poll(copied).toEqual([RLO]);
  await label.click({ button: "right" });
  await page.locator('#row-menu [data-action="copy-row"]').click();
  await expect.poll(async () => (await copied())[1]?.split("\t")[0]).toBe(RLO);
  // The preview copies the true name too.
  await label.click();
  await page.keyboard.press(" ");
  await page.locator('[aria-label="Copy path"]').click();
  await expect.poll(async () => (await copied())[2]).toBe(RLO);
});

test("the archive comment keeps its lines and shows the other characters", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const file = test.info().outputPath("comment.zip");
  const comment = "One \u202Etxt.exe\nTwo\r\nThree\rFour\tfive\x07 end\nتعليق عربي";
  writeFileSync(
    file,
    panelZip({
      entries: [{ name: "a.txt", data: Buffer.from("a") }],
      comment: Buffer.from(comment),
    }).bytes,
  );
  await page.goto("/");
  await openArchive(page, file);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
  const text = page.locator("#archive-comment-text");
  await expect(text).toBeVisible();
  expect(await text.textContent()).toBe(
    `One ${MARK}txt.exe\nTwo\nThree\nFour\tfive${MARK} end\nتعليق عربي`,
  );
  // Six lines: the breaks are real.
  const box = await text.boundingBox();
  const lineHeight = await text.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).lineHeight),
  );
  expect(Math.round(box!.height / lineHeight)).toBe(5);
  expect(await rawTexts(page)).toEqual([]);
});

test.describe("reports", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.assign(window, {
        showSaveFilePicker: async (options: { suggestedName: string }) => {
          const root = await navigator.storage.getDirectory();
          return root.getFileHandle(options.suggestedName.replace(/[^a-z.]/g, "_"), {
            create: true,
          });
        },
        showDirectoryPicker: async () => {
          const root = await navigator.storage.getDirectory();
          return root.getDirectoryHandle("out", { create: true });
        },
      });
    });
  });

  test("the extraction dialog and its report show marks, and the copy has the true name", async ({
    page,
  }) => {
    const copied: string[] = [];
    await page.exposeFunction("recordCopy", (text: string) => void copied.push(text));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text: string) =>
            (window as unknown as { recordCopy(t: string): void }).recordCopy(text),
        },
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    const folder = test.info().outputPath("files");
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, ARCHIVE_NAME);
    writeFileSync(
      file,
      contentZip([
        content(`${HOSTILE_FOLDER}/in\u202Etxt.exe`),
        content(`${HOSTILE_FOLDER}/z\u200Bw.txt`),
        content("top.txt"),
      ]),
    );
    await page.goto("/");
    await openArchive(page, file);
    expect((await waitForOutcome(page)).outcome).toBe("complete");
    await folderRow(page, `dir${MARK}rid`).click({ button: "right" });
    await page.locator('#row-menu [data-action="extract"]').click();
    await expect(page.locator("#extract-title")).toHaveText(`Extract “dir${MARK}rid”`);
    expect(await rawTexts(page)).toEqual([]);
    await page.locator("#extract-confirm").click();
    const report = page.locator("#extract-report tbody tr[data-row]");
    await expect(report.first()).toBeVisible();
    await expect(page.locator("#extract-report")).toContainText(`dir${MARK}rid/in${MARK}txt.exe`);
    expect(await rawTexts(page)).toEqual([]);
    await page.locator("#extract-copy").click();
    await expect.poll(() => copied.length).toBeGreaterThan(0);
    expect(copied[0]).toContain(`${HOSTILE_FOLDER}/in\u202Etxt.exe`);
    expect(copied[0]).not.toContain(MARK);
  });

  test("the zstd copy dialog and its report show marks", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const folder = test.info().outputPath("files");
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, ARCHIVE_NAME);
    writeFileSync(
      file,
      contentZip([content("good.txt"), { ...content(`bad\u202Etxt.exe`), crc: 0x12345678 }]),
    );
    await page.goto("/");
    await openArchive(page, file);
    expect((await waitForOutcome(page)).outcome).toBe("complete");
    await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
    await page.locator("#archive-remux #remux-button").click();
    await expect(page.locator("#remux-title")).toContainText(`arch${MARK}piz.zip`);
    expect(await rawTexts(page)).toEqual([]);
    await page.locator("#remux-confirm").click();
    await expect(page.locator("#remux-dialog, #remux-card").first()).toContainText(
      `bad${MARK}txt.exe`,
    );
    expect(await rawTexts(page)).toEqual([]);
  });
});

test("the choice for a second file and the door show marks", async ({ page }) => {
  const first = await open(page);
  // A second file: the choice names both files.
  const second = path.join(path.dirname(first), "sec\u202Etxt.zip");
  writeFileSync(second, storedZip([["a.txt", 1]]));
  await dropArchive(page, second);
  await expect(page.locator("#open-choice-title")).toHaveText(`Open “sec${MARK}txt.zip”`);
  await expect(page.locator("#open-choice-text")).toContainText(`“arch${MARK}piz.zip”`);
  expect(await rawTexts(page)).toEqual([]);
});

test("after a reload, the door shows marks for the file, the folder and the search", async ({
  page,
}) => {
  await open(page);
  await folderRow(page, `dir${MARK}rid`).dblclick();
  await expect(page.locator('nav[aria-label="Location"]')).toContainText(`dir${MARK}rid`);
  await page.getByLabel("Search names").fill("\u202E");
  await expect(page.locator('nav[aria-label="Location"]')).toContainText("Search results");
  // The history entry gets the query after a short wait (see reload.spec.ts).
  await expect
    .poll(() => page.evaluate(() => (history.state as { query: string }).query))
    .toBe("\u202E");
  await page.reload();
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "reopen");
  await expect(page.locator("#reopen-button")).toHaveText(`arch${MARK}piz.zip`);
  await expect(page.locator("#reopen-button")).toHaveAttribute(
    "aria-label",
    `Reopen arch${MARK}piz.zip`,
  );
  await expect(page.locator("#reopen-search")).toContainText(`“${MARK}”`);
  await expect(page.locator("#reopen-path")).toContainText(`dir${MARK}rid`);
  expect(await rawTexts(page)).toEqual([]);
});

test.describe("hard limits", () => {
  test("the hard stop keeps the marks and counts the kept rows", async ({ page }) => {
    await page.addInitScript(() => {
      (globalThis as { __zipscopeTestBudget?: unknown }).__zipscopeTestBudget = {
        soft: 2 ** 31,
        hard: 32 * 2 ** 20,
      };
    });
    // A larger archive than the limit allows. Every fourth name has the
    // character, so a count of the rows that the listing lost shows.
    const count = 80_000;
    const entries = Array.from(
      { length: count },
      (_, index) =>
        [
          `d${index % 8}/f${String(index).padStart(5, "0")}${index % 4 === 0 ? "\u202E" : ""}.txt`,
          0,
        ] as [string, number],
    );
    const file = test.info().outputPath("stopped.zip");
    writeFileSync(file, storedZip(entries, BigInt(count)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openArchive(page, file);
    const result = await waitForOutcome(page);
    expect(result.outcome, result.status).toBe("failed");
    expect(result.rows).toBeLessThan(count);
    await page.locator("#health-toggle").click();
    const finding = page.locator('[data-finding="control-names"]');
    await expect(finding).toBeVisible();
    // The first report can come before the
    // report of the stop, on main too, so this waits for the last report. The
    // expectation does not change.
    await expect
      .poll(async () => {
        const text = (await finding.textContent()) ?? "";
        return Number(/([\d,]+) entries have names/.exec(text)?.[1]?.replace(/,/g, ""));
      })
      .toBe(Math.ceil(result.rows / 4));
    // The worker refuses view requests, so the link is off, as the others.
    await expect(finding.locator('[data-action="show-entry"]')).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(await rawTexts(page)).toEqual([]);
  });

  test("an invalid UTF-8 name shows its replacement, and a control byte in CP437 shows a mark", async ({
    page,
  }) => {
    // Names as bytes: the UTF-8 flag with a bad byte, and no flag with a byte
    // that is not UTF-8 or a control byte.
    const bytes = rawNameZip([
      [Buffer.from("lossy-\xe9.txt", "latin1"), 0x0800],
      [Buffer.from("cp437-\xe9.txt", "latin1"), 0],
      [Buffer.from("bell-\x07.txt", "latin1"), 0],
    ]);
    const file = test.info().outputPath("bytes.zip");
    writeFileSync(file, bytes);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openArchive(page, file);
    expect((await waitForOutcome(page)).outcome).toBe("complete");
    await expect(labelOf(page, "lossy-�.txt")).toHaveCount(1);
    await expect(labelOf(page, "cp437-Θ.txt")).toHaveCount(1);
    await expect(labelOf(page, `bell-${MARK}.txt`)).toHaveCount(1);
    await expect(labelOf(page, `bell-${MARK}.txt`)).toHaveAttribute("title", "bell-[U+0007].txt");
    await page.locator("#health-toggle").click();
    await expect(page.locator('[data-finding="control-names"]')).toContainText(
      "1 entry has a name",
    );
    expect(await rawTexts(page)).toEqual([]);
  });
});

test("a name of 60,000 characters with marks draws cut, with its extension", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const names = Array.from(
    { length: 20 },
    (_, index) => `${String(index).padStart(2, "0")}\u202E${"x".repeat(60_000)}.exe`,
  );
  const file = test.info().outputPath("long.zip");
  writeFileSync(file, storedZip(names.map((name) => [name, 1] as [string, number])));
  await page.goto("/");
  await openArchive(page, file);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  const labels = rows(page).locator('[data-part="label"]');
  await expect(labels.first()).toBeVisible();
  const texts = await labels.allTextContents();
  expect(texts.length).toBe(20);
  for (const text of texts) {
    expect(text.length).toBeLessThan(400);
    expect(text).toContain(MARK);
    expect(text.endsWith(".exe")).toBe(true);
  }
});
