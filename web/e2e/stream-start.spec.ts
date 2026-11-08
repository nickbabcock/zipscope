// The limit for the start of a streamed download, on Chromium. The prompt for
// a stream that did not start comes only from a browser that did not ask for
// the first bytes. A job that is slow to make its first chunk does not get it.
//
// A hold stops the worker in a real read, so that the worker gets no turn of
// its event loop. The Playwright clock of the page stands still from the click
// on, so the limit of 10 s takes no real time, and a test crosses it only when
// it runs the clock.
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { contentZip } from "./content-zip";
import type { ContentEntry } from "./content-zip";
import {
  blockReads,
  holdableReads,
  holdWorkerPosts,
  readIsBlocked,
  releaseReads,
  releaseWorkerPosts,
} from "./hold";
import { openArchive, waitForOutcome } from "./listing";
import { readZip } from "./read-zip";
import { readCopy } from "./remux-zip";

// Each download streams through the service worker.
test.use({ serviceWorkers: "allow" });

const LIMIT_MS = 10_000;
const CHECK_MS = 100;

/** A row of stored bytes that do not repeat, from its number. */
function rowData(row: number): Buffer {
  const data = Buffer.alloc(64 * 1024);
  let state = row + 1;
  for (let at = 0; at < data.length; at++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    data[at] = state >>> 24;
  }
  return data;
}

/** The zip of the folder is about 2.6 MiB, so it has more than one chunk. */
const ENTRIES: ContentEntry[] = Array.from({ length: 40 }, (_, row) => ({
  name: `files/row-${String(row).padStart(2, "0")}.bin`,
  data: rowData(row),
  method: 0,
}));

/** Opens the archive without the pickers, as in Firefox and Safari. */
async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const name of ["showSaveFilePicker", "showDirectoryPicker"]) {
      Object.defineProperty(window, name, { value: undefined, configurable: true });
    }
  });
  await page.clock.install();
  await holdableReads(page);
  const path = test.info().outputPath("stream-start.zip");
  writeFileSync(path, contentZip(ENTRIES));
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openArchive(page, path);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
}

/** Stops the clock of the page. A test calls it before the watch of the start
 *  begins, so that the watch sees only the time of `runFor`. */
async function stopClock(page: Page): Promise<void> {
  await page.clock.pauseAt(Date.now() + 1000);
}

/** The frame of a download never loads, so the browser never asks for bytes. */
async function noDownloadFrame(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const append = Element.prototype.append;
    Element.prototype.append = function (...nodes) {
      const kept = nodes.filter(
        (node) => !(node instanceof HTMLIFrameElement && node.dataset.download !== undefined),
      );
      if (kept.length < nodes.length) (window as unknown as { noFrame: boolean }).noFrame = true;
      append.apply(this, kept);
    };
  });
}

/** Waits for the download to begin. The page begins the watch of the start in
 *  the same task as the frame, and only after the service worker is active. */
async function downloadBegan(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { noFrame?: boolean }).noFrame))
    .toBe(true);
}

async function openRemux(page: Page): Promise<void> {
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
  await page.locator("#archive-remux #remux-button").click();
  await page.locator("#remux-confirm").waitFor();
}

function expectEntries(zip: Buffer): void {
  const found = readZip(zip);
  expect(found.map((entry) => entry.name)).toEqual(ENTRIES.map((entry) => entry.name.slice(6)));
  found.forEach((entry, row) => {
    expect(entry.verified).toBe(true);
    expect(entry.data.equals(rowData(row)), entry.name).toBe(true);
  });
}

test.describe("a slow job is not a stream that did not start", () => {
  test("a zip job whose first read waits past the limit gets no prompt, and it ends", async ({
    page,
  }) => {
    await open(page);
    await page.locator("#folder-extract").click();
    await page.locator("#extract-confirm").waitFor();
    await blockReads(page, /worker-/);
    await stopClock(page);
    const download = page.waitForEvent("download");
    await page.locator("#extract-confirm").click();
    await readIsBlocked(page);
    // The worker waits and has made no chunk, and the page knows of the start.
    await expect(page.locator("#extract-status")).toHaveText(/^Extracting/);
    await page.clock.runFor(LIMIT_MS + 2 * CHECK_MS);
    await expect(page.locator("#extract-memory")).toHaveCount(0);
    await expect(page.locator("#extract-status")).toHaveText(/^Extracting/);
    await releaseReads(page);
    await page.clock.resume();
    const file = await download;
    await expect(page.locator("#extraction-report, #extract-summary").first()).toContainText(
      "Extracted 40 of 40 files",
    );
    expectEntries(readFileSync(await file.path()));
  });

  test("one entry whose first read waits past the limit gets no prompt, and it ends", async ({
    page,
  }) => {
    await open(page);
    await page
      .locator('#list-viewport [data-part="label"]', { hasText: "row-07.bin" })
      .first()
      .dblclick();
    await page.locator("#preview-extract").waitFor();
    await blockReads(page, /worker-/);
    await stopClock(page);
    const download = page.waitForEvent("download");
    await page.locator("#preview-extract").click();
    await readIsBlocked(page);
    await expect(page.locator("#extract-status")).toHaveText(/^Extracting/);
    await page.clock.runFor(LIMIT_MS + 2 * CHECK_MS);
    await expect(page.locator("#extract-memory")).toHaveCount(0);
    await releaseReads(page);
    await page.clock.resume();
    const file = await download;
    expect(readFileSync(await file.path()).equals(rowData(7))).toBe(true);
    await expect(page.locator("#extract-status")).toContainText("Its size and CRC-32 verified");
  });

  test("a copy whose first lead read waits past the limit does not fail, and it ends", async ({
    page,
  }) => {
    await open(page);
    await openRemux(page);
    await holdWorkerPosts(page);
    await stopClock(page);
    const download = page.waitForEvent("download");
    await page.locator("#remux-confirm").click();
    await expect.poll(() => page.workers().some((one) => /lead-/.test(one.url()))).toBe(true);
    await blockReads(page, /lead-/);
    await releaseWorkerPosts(page);
    await readIsBlocked(page);
    await expect(page.locator("#remux-status")).toHaveText(/^Saving the zstd copy/);
    await page.clock.runFor(LIMIT_MS + 2 * CHECK_MS);
    await expect(page.locator("#remux-error")).toHaveCount(0);
    await releaseReads(page);
    await page.clock.resume();
    const file = await download;
    await expect(page.locator("#remux-summary")).toContainText("40 entries");
    const copy = readCopy(readFileSync(await file.path()));
    expect(copy.entries).toHaveLength(ENTRIES.length);
    copy.entries.forEach((entry, row) => {
      expect(entry.verified, entry.name).toBe(true);
      expect(entry.data.equals(rowData(row)), entry.name).toBe(true);
    });
  });

  test("without the start port, the job ends and its zip is right", async ({ page }) => {
    // A service worker of an older version takes only the first port, and so
    // does the service worker of this version when an older page sends one.
    await page.addInitScript(() => {
      const post = ServiceWorker.prototype.postMessage as (
        message: unknown,
        transfer: Transferable[],
      ) => void;
      ServiceWorker.prototype.postMessage = function (this: ServiceWorker, ...args: unknown[]) {
        const [message, transfer] = args as [unknown, Transferable[] | undefined];
        post.call(this, message, (transfer ?? []).slice(0, 1));
      };
    });
    await open(page);
    await page.locator("#folder-extract").click();
    await page.locator("#extract-confirm").waitFor();
    const download = page.waitForEvent("download");
    await page.locator("#extract-confirm").click();
    const file = await download;
    await expect(page.locator("#extraction-report, #extract-summary").first()).toContainText(
      "Extracted 40 of 40 files",
    );
    await expect(page.locator("#extract-memory")).toHaveCount(0);
    expectEntries(readFileSync(await file.path()));
  });
});

test.describe("a stream that does not start", () => {
  test("a zip job gets the prompt at the limit, not before, and the memory path works", async ({
    page,
  }) => {
    await noDownloadFrame(page);
    await open(page);
    await page.locator("#folder-extract").click();
    await page.locator("#extract-confirm").waitFor();
    await stopClock(page);
    await page.locator("#extract-confirm").click();
    await downloadBegan(page);
    await expect(page.locator("#extract-status")).toHaveText("Starting the download…");
    await page.clock.runFor(LIMIT_MS - 2 * CHECK_MS);
    await expect(page.locator("#extract-status")).toHaveText("Starting the download…");
    await expect(page.locator("#extract-memory")).toHaveCount(0);
    await page.clock.runFor(2 * CHECK_MS);
    await expect(page.locator("#extract-memory")).toContainText("keeps files.zip in memory");
    await page.clock.resume();
    const download = page.waitForEvent("download");
    await page.locator("#extract-confirm").click();
    const file = await download;
    expectEntries(readFileSync(await file.path()));
  });

  test("a copy fails at the limit, not before", async ({ page }) => {
    await noDownloadFrame(page);
    await open(page);
    await openRemux(page);
    await stopClock(page);
    await page.locator("#remux-confirm").click();
    await downloadBegan(page);
    await expect(page.locator("#remux-status")).toHaveText("Starting the download…");
    await page.clock.runFor(LIMIT_MS - 2 * CHECK_MS);
    await expect(page.locator("#remux-status")).toHaveText("Starting the download…");
    await expect(page.locator("#remux-error")).toHaveCount(0);
    await page.clock.runFor(2 * CHECK_MS);
    await expect(page.locator("#remux-error")).toContainText(
      "The browser did not start the download",
    );
  });
});
