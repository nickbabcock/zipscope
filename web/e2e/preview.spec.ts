// Read module and preview: text, images, hex, "Load more", the
// local header check and the popup window. `node/preview.test.ts` checks more
// reads of entries with the real workers and wasm.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { hexDump } from "../src/preview/sniff.ts";
import { contentZip, png } from "./content-zip";
import type { ContentEntry } from "./content-zip";
import { holdableWorkers, holdWorkers, releaseWorkers } from "./hold";
import { openArchive, waitForOutcome } from "./listing";

/** Sets a small memory budget before the app loads (see health.spec.ts). */
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

/** The memory in the status bar, in bytes. */
async function storeMemory(page: Page): Promise<number> {
  const text = (await page.locator("#store-memory").textContent()) ?? "";
  // A no-break space joins a number and its unit.
  const match = /Store ([\d.]+)\s(B|KiB|MiB|GiB)/.exec(text);
  if (match === null) throw new Error(`No store memory in "${text}"`);
  const units = { B: 1, KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30 } as const;
  return Number(match[1]) * units[match[2] as keyof typeof units];
}

async function open(page: Page, entries: ContentEntry[], file = "preview.zip") {
  const path = test.info().outputPath(file);
  writeFileSync(path, contentZip(entries));
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openArchive(page, path);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
}

/** Double-clicks the table row of an entry, which opens its preview. A
 *  click only selects it (the Quick Look model). */
async function preview(page: Page, label: string) {
  await page.locator('#list-viewport [data-part="label"]', { hasText: label }).first().dblclick();
}

const text = (page: Page) => page.locator("#preview-text");

test("previews text with its metadata", async ({ page }) => {
  const body = "first line\nsecond line\n";
  await open(page, [{ name: "notes/readme.txt", data: Buffer.from(body) }]);
  await preview(page, "readme.txt");
  await expect(text(page)).toHaveText(body);
  const meta = page.locator("#preview-meta");
  await expect(meta.locator('[data-field="size"]')).toHaveText("23 B");
  await expect(meta.locator('[data-field="compressed"]')).toContainText("Deflate");
  await expect(meta.locator('[data-field="path"]')).toHaveText("notes/readme.txt");
  await expect(meta.locator('[data-field="crc32"]')).toHaveText(/^[0-9A-F]{8}$/);
  await expect(meta.locator('[data-field="modified"]')).toContainText("2026-10-28 09:13");
  // The facts have the result,
  // and the footer does not repeat it.
  await expect(page.locator("#preview-crc-result")).toHaveText("verified");
  await expect(page.locator("#preview-footer")).not.toContainText("CRC-32");
  await expect(page.locator("#preview-extract")).toBeVisible();
  await expect(page.locator("#preview-copy-path")).toBeVisible();
  await expect(page.locator("#preview-encoding")).toHaveCount(0);
});

test("decodes text that is not UTF-8 as Windows-1252 with a note", async ({ page }) => {
  await open(page, [{ name: "fr.txt", data: Buffer.from("caf\xe9 \x80", "latin1") }]);
  await preview(page, "fr.txt");
  await expect(text(page)).toHaveText("café €");
  await expect(page.locator("#preview-encoding")).toContainText("Windows-1252");
});

test("shows HTML as text and never renders it", async ({ page }) => {
  const html = '<h1 id="injected">Hi</h1><img src=x onerror="window.__pwned=1">';
  await open(page, [{ name: "index.html", data: Buffer.from(html) }]);
  await preview(page, "index.html");
  await expect(text(page)).toHaveText(html);
  await expect(page.locator("#injected")).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
});

test("shows images and SVG only through img from a Blob URL", async ({ page }) => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><script>window.__svg=1</script><rect width="20" height="10"/></svg>';
  await open(page, [
    { name: "red.png", data: png(3, 2), method: 0 },
    { name: "logo.svg", data: Buffer.from(svg) },
  ]);
  const image = page.locator("#preview-image");
  await preview(page, "red.png");
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(3);

  await preview(page, "logo.svg");
  await expect(image).toHaveAttribute("alt", "logo.svg");
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(20);
  // The SVG is not in the document, and its script did not run.
  await expect(page.locator("#preview-content svg")).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __svg?: number }).__svg)).toBeUndefined();
});

test("shows binary data as hex", async ({ page }) => {
  const data = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
  await open(page, [{ name: "blob.bin", data }]);
  await preview(page, "blob.bin");
  // The offsets are a column of their own
  // in ink muted, so the bytes follow them in the second column.
  const hex = page.locator("#preview-pane [data-kind=hex]:visible");
  const columns = hex.locator(":scope > div");
  await expect(columns.first()).toContainText("00000000");
  await expect(columns.first()).toContainText("00000ff0");
  await expect(columns.nth(1)).toContainText("00 01 02 03 04 05 06 07  08 09 0a 0b");
});

test("decodes only the start of a large entry, with Load more", async ({ page }) => {
  const line = "0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstu\n";
  const data = Buffer.alloc(3 * 1024 * 1024, line);
  await open(page, [{ name: "big.log", data }]);
  await preview(page, "big.log");
  const footer = page.locator("#preview-footer");
  await expect(footer).toContainText("First 1.0 MiB of 3.0 MiB");
  await page.locator("#preview-more").click();
  await expect(footer).toContainText("First 2.0 MiB of 3.0 MiB");
  await page.locator("#preview-more").click();
  await expect(page.locator("#preview-crc-result")).toHaveText("verified");
  await expect(footer).toHaveText("3.0 MiB");
  await expect(page.locator("#preview-more")).toHaveCount(0);
});

test("flags a local header that names another file", async ({ page }) => {
  await open(page, [
    { name: "invoice.pdf", localName: "setup.exe", data: Buffer.from("not a pdf") },
    { name: "ok.txt", data: Buffer.from("fine") },
  ]);
  await preview(page, "invoice.pdf");
  await expect(page.locator("#preview-mismatch")).toContainText("setup.exe");
  // The health strip lists it.
  await expect(page.getByText(/local header that does not agree/).first()).toBeVisible();
  await preview(page, "ok.txt");
  await expect(text(page)).toHaveText("fine");
  await expect(page.locator("#preview-mismatch")).toHaveCount(0);
});

test("shows the data of a CRC-32 failure with a warning, and lists it", async ({ page }) => {
  const body = "this crc lies ".repeat(100);
  await open(page, [
    { name: "bad-crc.txt", data: Buffer.from(body), crc: 0xdeadbeef },
    { name: "ok.txt", data: Buffer.from("fine") },
  ]);
  await expect(page.locator("#health-strip")).toHaveCount(0);
  await preview(page, "bad-crc.txt");
  await expect(text(page)).toHaveText(body);
  await expect(page.locator("#preview-error")).toHaveText(
    /^Not verified: The CRC-32 of the data is [0-9A-F]{8}, but the central directory gives DEADBEEF\. The data below can have errors\.$/,
  );
  await expect(page.locator("#preview-footer")).toHaveText("1.4 KiB of 1.4 KiB");
  await expect(page.locator("#preview-crc-result")).toHaveText("not verified");
  // The health strip lists it, as a local header that does not agree.
  await expect(page.locator("#health-toggle")).toContainText("1 finding");
  await page.locator("#health-toggle").click();
  await expect(page.locator('[data-finding="crc-failure"]')).toContainText(
    "1 previewed entry has data that does not agree with its CRC-32.",
  );
  // A second preview of the same entry does not count it again.
  await preview(page, "ok.txt");
  await expect(text(page)).toHaveText("fine");
  await expect(page.locator("#preview-error")).toHaveCount(0);
  await preview(page, "bad-crc.txt");
  await expect(text(page)).toHaveText(body);
  await expect(page.locator('[data-finding="crc-failure"]')).toContainText("1 previewed entry");
});

test("the popup follows the selection and closes with the archive", async ({ page }) => {
  await open(page, [
    { name: "a.txt", data: Buffer.from("alpha") },
    { name: "b.txt", data: Buffer.from("bravo") },
  ]);
  await preview(page, "a.txt");
  await expect(text(page)).toHaveText("alpha");
  const popupEvent = page.waitForEvent("popup");
  await page.locator("#preview-popout").click();
  const popup = await popupEvent;
  await expect(popup.locator("#preview-text")).toHaveText("alpha");
  await expect(popup.locator("#popup-title")).toHaveText("a.txt");
  // The pane preview collapses while the popup is open.
  await expect(page.locator("#preview-pane")).toHaveCount(0);
  // The selection moves in the app window; the popup follows it.
  await page.locator("#list-viewport").focus();
  await page.keyboard.press("ArrowDown");
  await expect(popup.locator("#preview-text")).toHaveText("bravo");
  await expect(popup.locator("#popup-title")).toHaveText("b.txt");
  // A new archive closes the popup.
  const closed = popup.waitForEvent("close");
  const path = test.info().outputPath("other.zip");
  writeFileSync(path, contentZip([{ name: "c.txt", data: Buffer.from("charlie") }]));
  await openArchive(page, path);
  await closed;
  expect(popup.isClosed()).toBe(true);
});

for (const stop of ["soft", "hard"] as const) {
  test(`previews a listed entry after a stop at the ${stop} memory budget`, async ({ page }) => {
    // The first page and name chunk with their mirrors take about 16.5
    // MiB, and the batch estimate counts them, so a soft budget of 20 MiB
    // comes after more rows than the first. The hard stop of 32 MiB keeps 8 MiB
    // for the read worker. Below the other 24 MiB, the first batches fit
    // and later batches do not.
    await lowBudget(
      page,
      stop === "soft" ? 20 * 2 ** 20 : 2 ** 31,
      stop === "hard" ? 32 * 2 ** 20 : 2 ** 31,
    );
    const entries = Array.from({ length: 100_000 }, (_, index) => ({
      name: `f${String(index).padStart(5, "0")}.txt`,
      data: Buffer.from(`body ${index}`),
    }));
    const path = test.info().outputPath("budget.zip");
    writeFileSync(path, contentZip(entries));
    await page.goto("/");
    await page.setViewportSize({ width: 1440, height: 900 });
    await openArchive(page, path);
    if (stop === "soft") {
      await expect(page.locator("#budget-prompt")).toBeVisible();
      await page.locator("#budget-stop").click();
    }
    const result = await waitForOutcome(page);
    expect(result.outcome, result.status).toBe(stop === "soft" ? "cancelled" : "failed");
    expect(result.rows).toBeGreaterThan(1);
    expect(result.rows).toBeLessThan(100_000);
    if (stop === "hard") {
      // The store keeps all of the reserve free. Before, the last batch could take up
      // to 3.8 MiB of it.
      expect(await storeMemory(page)).toBeLessThanOrEqual(24 * 2 ** 20);
    }
    await preview(page, "f00001.txt");
    await expect(text(page)).toHaveText("body 1");
    await expect(page.locator("#preview-crc-result")).toHaveText("verified");
    if (stop === "hard") {
      // The preview uses the reserve that the hard stop kept.
      await expect.poll(() => storeMemory(page)).toBeLessThanOrEqual(32 * 2 ** 20);
    }
  });
}

test("a preview after a complete listing stays below the hard stop and shows its memory", async ({
  page,
}) => {
  // A listing that completes near a 40 MiB hard
  // stop. The hard stop keeps 8 MiB for the read worker.
  // 36 MiB, not 40 MiB. After a parse the
  // status bar shows the memory only above half of the limit. The store of this
  // listing ends at 19.8 to 20.2 MiB (measured in 10 runs), so with a limit of
  // 40 MiB the text can be absent.
  const hard = 36 * 2 ** 20;
  await lowBudget(page, 2 ** 31, hard);
  const entries = Array.from({ length: 30_000 }, (_, index) => ({
    name: `f${String(index).padStart(5, "0")}.txt`,
    data: Buffer.from(`body ${index}`),
  }));
  await open(page, entries, "complete.zip");
  const before = await storeMemory(page);
  // The largest rows come first, and equal
  // rows stay in archive order, so f10000.txt is the first row.
  await preview(page, "f10000.txt");
  await expect(text(page)).toHaveText("body 10000");
  // The frame loop has stopped, but the status bar shows the read worker
  // memory.
  await expect.poll(() => storeMemory(page)).toBeGreaterThan(before);
  expect(await storeMemory(page)).toBeLessThanOrEqual(hard);
});

test.describe(() => {
  // The download streams through the service worker.
  test.use({ serviceWorkers: "allow" });

  test("an extraction goes on while the preview shows the next entry", async ({ page }) => {
    // Without the pickers, the entry streams as a download.
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    });
    await holdableWorkers(page);
    await open(page, [
      { name: "a.txt", data: Buffer.from("alpha") },
      { name: "b.txt", data: Buffer.from("bravo") },
    ]);
    await preview(page, "a.txt");
    await expect(text(page)).toHaveText("alpha");
    const status = page.locator("#extract-status");
    // The extraction of a.txt waits while the next entry opens.
    await holdWorkers(page);
    const download = page.waitForEvent("download");
    await page.locator("#preview-extract").click();
    await expect(status).toHaveText("Checking the entries…");
    await preview(page, "b.txt");
    await expect(page.locator('#preview-meta [data-field="path"]')).toHaveText("b.txt");
    await releaseWorkers(page);
    expect((await download).suggestedFilename()).toBe("a.txt");
    await expect(text(page)).toHaveText("bravo");
    // The result shows in the extraction card, not under the next entry.
    await expect(status).toHaveText("Saved “a.txt”. Its size and CRC-32 verified.");
    await expect(page.locator("#preview-action")).toHaveText("");
    // A new Extract replaces the card of the finished extraction.
    const next = page.waitForEvent("download");
    await page.locator("#preview-extract").click();
    expect((await next).suggestedFilename()).toBe("b.txt");
    await expect(status).toHaveText("Saved “b.txt”. Its size and CRC-32 verified.");
  });
});

for (const length of [2500, 60_000]) {
  test(`a path of ${length} characters leaves the content and Load more in the pane`, async ({
    page,
  }) => {
    const name = `${"long-name-".repeat(Math.ceil(length / 10))}.bin`;
    await open(page, [{ name, data: Buffer.alloc(200_000, 0xfe), method: 0 }]);
    await page.locator('#list-viewport [role=row] [data-part="label"]').first().dblclick();
    const path = page.locator('#preview-meta [data-field="path"]');
    await expect(path).toHaveAttribute("title", name);
    const hex = page.locator("#preview-pane [data-kind=hex]:visible");
    await expect(hex).toBeVisible();
    // The path has at most four lines, and it scrolls.
    const lines = await path.evaluate((element) => ({
      height: element.clientHeight,
      full: element.scrollHeight,
      line: Number.parseFloat(getComputedStyle(element).lineHeight),
    }));
    expect(lines.height).toBeLessThanOrEqual(lines.line * 4 + 1);
    expect(lines.full).toBeGreaterThan(lines.height);
    const area = await hex.locator("..").locator("..").boundingBox();
    expect(area!.height).toBeGreaterThan(200);
    const pane = await page.locator("#preview-pane").boundingBox();
    const more = page.locator("#preview-more");
    await expect(more).toBeVisible();
    const button = await more.boundingBox();
    expect(button!.y + button!.height).toBeLessThanOrEqual(pane!.y + pane!.height);
    await more.click();
    await expect(page.locator("#preview-footer")).toContainText("First 128.0 KiB");
  });
}

test("the hex view has one dump, for the width that shows", async ({ page }) => {
  await open(page, [{ name: "data.bin", data: Buffer.alloc(200_000, 0xfe), method: 0 }]);
  await page.setViewportSize({ width: 1920, height: 900 });
  await preview(page, "data.bin");
  const hex = page.locator("#preview-pane [data-kind=hex]");
  const first = async () => {
    const dump = await hex.locator(":scope > div").nth(1).textContent();
    return dump!.split("\n")[0]!.split(/\s+/).length;
  };
  await expect(hex).toHaveCount(1);
  await expect.poll(first).toBe(8);
  // A wider pane has 16 bytes on each line, with no new request.
  const splitter = page.locator("#preview-splitter");
  await splitter.focus();
  await page.keyboard.press("End");
  await expect(splitter).toHaveAttribute("aria-valuenow", "720");
  await expect.poll(first).toBe(16);
  await expect(hex).toHaveCount(1);
  // Load more keeps the width.
  await page.locator("#preview-more").click();
  await expect(page.locator("#preview-footer")).toContainText("First 128.0 KiB");
  expect(await first()).toBe(16);
  await page.keyboard.press("Home");
  // The popup measures in its own window.
  const popupEvent = page.waitForEvent("popup");
  await page.locator("#preview-popout").click();
  const popup = await popupEvent;
  await expect(popup.locator("[data-kind=hex]")).toHaveCount(1);
  await expect(popup.locator("[data-kind=hex] pre").first()).toContainText("00000000");
});

/** Random bytes from a fixed generator. */
function fixedBytes(length: number): Buffer {
  let seed = 1;
  const data = Buffer.alloc(length);
  for (let index = 0; index < data.length; index++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    data[index] = seed >>> 24;
  }
  return data;
}

/** The left edge and the width of each column of the hex view, the bytes
 *  on a line, and the sideways scroll of the content. */
const hexLayout = (page: Page) =>
  page.locator("#preview-content").evaluate((content) => {
    const columns = [...content.querySelector("#preview-hex")!.children];
    return {
      boxes: columns.map((column) => {
        const box = column.getBoundingClientRect();
        return [box.x, box.width];
      }),
      perLine: columns[1]!.textContent!.split("\n")[0]!.split(/\s+/).length,
      sideways: content.scrollWidth - content.clientWidth,
    };
  });

/** Scrolls the content to the middle, and waits for two frames. */
const scrollMiddle = (page: Page) =>
  page.locator("#preview-content").evaluate(
    (content) =>
      new Promise((resolve) => {
        content.scrollTo(0, content.scrollHeight / 2);
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );

const expectSameBoxes = (actual: number[][], expected: number[][]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((box, index) => {
    expect(box[0]).toBeCloseTo(expected[index]![0]!, 2);
    expect(box[1]).toBeCloseTo(expected[index]![1]!, 2);
  });
};

test("a narrower pane in the middle of the hex view gives the columns of 8 bytes", async ({
  page,
}) => {
  await open(page, [{ name: "data.bin", data: fixedBytes(64 * 1024), method: 0 }]);
  await preview(page, "data.bin");
  const splitter = page.locator("#preview-splitter");
  await splitter.focus();
  /** The widest pane, then 18 steps to 432 px: 8 bytes on a line. */
  const narrow = async () => {
    await page.keyboard.press("End");
    for (let step = 0; step < 18; step++) await page.keyboard.press("ArrowRight");
    await expect(splitter).toHaveAttribute("aria-valuenow", "432");
    await expect.poll(async () => (await hexLayout(page)).perLine).toBe(8);
  };
  await narrow();
  const top = await hexLayout(page);
  expect(top.sideways).toBe(0);
  // The widest pane has 16 bytes on a line. A narrower pane in the middle
  // of the dump gives the same columns as at the top.
  await page.keyboard.press("End");
  await expect.poll(async () => (await hexLayout(page)).perLine).toBe(16);
  await scrollMiddle(page);
  await narrow();
  const middle = await hexLayout(page);
  expectSameBoxes(middle.boxes, top.boxes);
  expect(middle.sideways).toBe(0);
});

test("a narrower window in the middle of the hex view gives the columns of 8 bytes", async ({
  page,
}) => {
  await open(page, [{ name: "data.bin", data: fixedBytes(64 * 1024), method: 0 }]);
  await preview(page, "data.bin");
  const splitter = page.locator("#preview-splitter");
  await splitter.focus();
  await page.keyboard.press("End");
  await page.setViewportSize({ width: 1200, height: 900 });
  await expect.poll(async () => (await hexLayout(page)).perLine).toBe(8);
  const top = await hexLayout(page);
  expect(top.sideways).toBe(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await hexLayout(page)).perLine).toBe(16);
  await scrollMiddle(page);
  await page.setViewportSize({ width: 1200, height: 900 });
  await expect.poll(async () => (await hexLayout(page)).perLine).toBe(8);
  const middle = await hexLayout(page);
  expectSameBoxes(middle.boxes, top.boxes);
  expect(middle.sideways).toBe(0);
});

test("the selection mark of a line end in the hex view goes past the end of the line", async ({
  page,
}) => {
  await open(page, [{ name: "data.bin", data: fixedBytes(64 * 1024), method: 0 }]);
  await preview(page, "data.bin");
  const hex = page.locator("#preview-pane [data-kind=hex]");
  const text = hex.locator(":scope > div").nth(2);
  await expect(text.locator("pre")).not.toHaveCount(1);
  const lines = await text
    .locator("pre")
    .first()
    .evaluate((chunk) => chunk.textContent!.split("\n").length);
  // Lines from before the first chunk edge to after it are selected.
  await page.locator("#preview-content").evaluate((content) => content.scrollTo(0, 4800));
  await text.evaluate((column) => {
    // A line of 8 characters and its two bars, with a line feed: 11.
    const [first, second] = column.children;
    getSelection()!.setBaseAndExtent(first!.firstChild!, 0, second!.firstChild!, 3 * 11);
  });
  const grid = (await hex.boundingBox())!;
  const column = (await text.boundingBox())!;
  /** A strip of 4 px after the end of a line, in the gutter. */
  const strip = (line: number) =>
    page.screenshot({
      clip: { x: column.x + column.width + 1, y: grid.y + 6 + line * 20 + 4, width: 4, height: 12 },
    });
  // The last line of the first chunk, and a line after the selection.
  const edge = await strip(lines - 1);
  const after = await strip(lines + 5);
  expect(edge.equals(after)).toBe(false);
  expect((await strip(lines - 2)).equals(edge)).toBe(true);
});

/** The hex view at 256 KiB, after three clicks of Load more. It records
 *  the chunks that the browser lays out. */
async function hexAt256(page: Page) {
  // Random bytes, so the lines are not the same.
  const data = fixedBytes(256 * 1024);
  await page.addInitScript(() => {
    const drawn = new Set<EventTarget>();
    (globalThis as { __drawn?: Set<EventTarget> }).__drawn = drawn;
    document.addEventListener(
      "contentvisibilityautostatechange",
      (event) => {
        const change = event as Event & { skipped: boolean };
        if (change.skipped) drawn.delete(change.target!);
        else drawn.add(change.target!);
      },
      true,
    );
  });
  await open(page, [{ name: "data.bin", data, method: 0 }]);
  await preview(page, "data.bin");
  const hex = page.locator("#preview-pane [data-kind=hex]");
  const footer = page.locator("#preview-footer");
  for (const kib of [128, 192, 256]) {
    await page.locator("#preview-more").click();
    await expect(footer).toContainText(`${kib}.0`);
  }
  const perLine = await hex
    .locator(":scope > div")
    .nth(1)
    .evaluate((column) => column.textContent!.split("\n")[0]!.split(/\s+/).length);
  const lines = hexDump(data, 0, perLine as 8 | 16).split("\n");
  return { data, hex, lines };
}

/** The chunks that the browser lays out, after two frames: for each one,
 *  its top and bottom in heights of the view, from the top of the view. */
const drawnChunks = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number[][]>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const view = document.querySelector("#preview-content")!.getBoundingClientRect();
            const drawn = (globalThis as { __drawn?: Set<Element> }).__drawn!;
            resolve(
              [...drawn].map((chunk) => {
                const box = chunk.getBoundingClientRect();
                return [(box.top - view.top) / view.height, (box.bottom - view.top) / view.height];
              }),
            );
          }),
        ),
      ),
  );

test("the hex view lays out only the chunks of lines near the view", async ({ page }) => {
  const { hex, lines } = await hexAt256(page);
  // Each column has all the lines, in chunks.
  const columnLines = await hex
    .locator(":scope > div")
    .evaluateAll((columns) =>
      columns.map((column) =>
        [...column.children].map((chunk) => chunk.textContent!.split("\n").length),
      ),
    );
  for (const chunks of columnLines) {
    expect(chunks.reduce((sum, count) => sum + count, 0)).toBe(lines.length);
    expect(chunks.length).toBeGreaterThan(10);
  }
  // After Load more, the first chunk of each column has layout. The last
  // chunk always has layout and sends no event. The other chunks have none.
  const atTop = await drawnChunks(page);
  expect(atTop).toHaveLength(3);
  for (const [top] of atTop) expect(top).toBeLessThan(1);
  // A scroll gives layout to the chunks that come near the view.
  await page.locator("#preview-content").evaluate((content) => content.scrollTo(0, 30_000));
  await expect
    .poll(async () => (await drawnChunks(page)).every(([, bottom]) => bottom! > 0))
    .toBe(true);
  const scrolled = await drawnChunks(page);
  expect(scrolled.length).toBeGreaterThanOrEqual(3);
  expect(scrolled.length).toBeLessThanOrEqual(6);
  for (const [top, bottom] of scrolled) {
    expect(top).toBeLessThan(2);
    expect(bottom).toBeGreaterThan(-1);
  }
});

test("a selection over chunks of the hex view copies the lines of the columns", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const { hex, lines } = await hexAt256(page);
  const bytes = lines.map((line) => line.slice(10, line.indexOf("|")).trimEnd());
  const text = lines.map((line) => line.slice(line.indexOf("|")));
  /** Selects from a point in a column to a point in a column, and copies. */
  const copy = async (from: number[], to: number[]) => {
    await hex.evaluate(
      (grid, [start, end]) => {
        // The text node and offset of a line and a character in a column.
        const point = ([column, line, char]: number[]) => {
          const chunks = grid.children[column!]!.children;
          let at = 0;
          for (const chunk of chunks) {
            const parts = chunk.textContent!.split("\n");
            if (line! < at + parts.length) {
              const before = parts.slice(0, line! - at).join("\n").length;
              return [chunk.firstChild!, before + (line! > at ? 1 : 0) + char!] as const;
            }
            at += parts.length;
          }
          throw new Error(`No line ${line}`);
        };
        const [startNode, startOffset] = point(start!);
        const [endNode, endOffset] = point(end!);
        getSelection()!.setBaseAndExtent(startNode, startOffset, endNode, endOffset);
      },
      [from, to],
    );
    await page.keyboard.press("ControlOrMeta+c");
    return page.evaluate(() => navigator.clipboard.readText());
  };
  // In the bytes column, over two chunk edges, with a chunk between them
  // that has no layout.
  const far = bytes.slice(250, 600).join("\n");
  expect(await copy([1, 250, 3], [1, 599, 5])).toBe(
    far.slice(3, far.length - bytes[599]!.length + 5),
  );
  // From the bytes to the characters: the rest of the bytes column comes
  // first, as in one block of text for each column.
  const across = `${bytes.slice(250).join("\n")}\n${text.slice(0, 3).join("\n")}`;
  expect(await copy([1, 250, 3], [2, 2, 4])).toBe(
    across.slice(3, across.length - text[2]!.length + 4),
  );
});

test("find on the page reaches a line of the hex view that has no layout", async ({ page }) => {
  const { hex, lines } = await hexAt256(page);
  const bytes = lines.map((line) => line.slice(10, line.indexOf("|")).trimEnd());
  // A line far from the view, with a text that occurs once in the bytes.
  const counts = new Map<string, number>();
  for (const value of bytes) counts.set(value, (counts.get(value) ?? 0) + 1);
  const line = bytes.findIndex((value, index) => index > 2000 && counts.get(value) === 1);
  expect(line).toBeGreaterThan(2000);
  const found = await hex.evaluate(
    (grid, [needle, index]) => {
      // The chunk of the line has no layout before the search.
      let at = 0;
      const chunk = [...grid.children[1]!.children].find((element) => {
        at += element.textContent!.split("\n").length;
        return at > index;
      })!;
      const drawn = (globalThis as { __drawn?: Set<Element> }).__drawn!;
      const before = drawn.has(chunk) || chunk === chunk.parentElement!.lastElementChild;
      const ok = (window as unknown as { find: (text: string) => boolean }).find(needle);
      return {
        before,
        text: ok ? getSelection()!.toString() : undefined,
        inChunk: getSelection()!.anchorNode?.parentElement === chunk,
      };
    },
    [bytes[line]!, line] as const,
  );
  expect(found).toEqual({ before: false, text: bytes[line], inChunk: true });
});
