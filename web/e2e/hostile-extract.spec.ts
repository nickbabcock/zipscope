/*
ASSUMED API
Use the existing #preview-extract button for one entry.
Add #folder-extract to extract the current folder, with all descendants.
Add #extraction-report with data-state="complete"|"failed"|"cancelled".
For each selected entry, add one report element with:
  data-row: the central-directory row number
  data-status: "saved"|"renamed"|"skipped"|"failed"
  data-output-path: the final relative path, for a saved or renamed entry
Show the reason as text for each skipped, failed, or renamed entry.
Show #extraction-blob-warning with the size when Safari uses a Blob.
Keep window.confirm(message: string): boolean for size and ratio approval.
The implementer can rename these selectors. Keep each safety check.
Write a reason before you remove or reduce an expectation.

The real UI contract.
- #folder-extract is the "Extract this folder" button of the table strip.
  It extracts the listed folder with all descendants (the whole archive
  at the root).
- #extraction-report has data-state. It is the report dialog, or the
  card after a clean extraction. Its rows have data-row, data-status and
  data-output-path. The report lists the rows that are renamed, skipped
  or failed, and each renamed folder (data-row="-1", its archive path as
  the text of the first cell). A row that is written under its own path
  has no row in the report: listing each written file would fill the
  report of a large folder (MAX_REPORT_ITEMS) before its skips.
- The confirmation is a dialog of the page, not window.confirm: the
  tests click #extract-confirm or #extract-cancel (see answer()). A
  folder always shows its plan first.
- The Blob warning is #extract-memory.
*/
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Download, Page } from "@playwright/test";
import { hostileZip } from "./hostile-zip";
import type { HostileEntry } from "./hostile-zip";
import {
  outputRoute,
  outputState,
  recordWorkers,
  releaseWrites,
  setOutput,
} from "./extract-output";
import { openArchive, waitForOutcome } from "./listing";

const body = (name: string, value = name): HostileEntry => ({ name, body: Buffer.from(value) });
const report = (page: Page) => page.locator("#extraction-report");
const item = (page: Page, row: number) => report(page).locator(`[data-row="${row}"]`);

async function open(page: Page, entries: HostileEntry[]) {
  const path = test.info().outputPath("extract.zip");
  const bytes = hostileZip(entries);
  writeFileSync(path, bytes);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openArchive(page, path);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  return bytes;
}

/** Answers the confirmation when the dialog asks; else waits for the
 *  report. In place of window.confirm. */
async function answer(page: Page, accept = true) {
  const ask = page.locator("#extract-confirm");
  await expect(ask.or(report(page)).first()).toBeVisible({ timeout: 30_000 });
  if (await ask.isVisible()) {
    await page.locator(accept ? "#extract-confirm" : "#extract-cancel").click();
  }
}

async function selectEntry(page: Page, name: string) {
  await page
    .locator('#list-viewport [data-part="label"]')
    .filter({ hasText: name })
    .first()
    .dblclick();
  await expect(page.locator("#preview-extract")).toBeVisible();
  await recordWorkers(page);
}

async function selectRoot(page: Page) {
  await page.locator('#tree-viewport [data-part="label"]').first().click();
  await expect(page.locator("#folder-extract")).toBeVisible();
  await recordWorkers(page);
}

async function finished(page: Page) {
  await expect(report(page)).toHaveAttribute("data-state", /^(complete|failed|cancelled)$/);
}

async function skipped(page: Page, row: number, reason: RegExp) {
  await expect(item(page, row)).toHaveAttribute("data-status", "skipped");
  await expect(item(page, row)).toContainText(reason);
}

async function folderOutput(page: Page) {
  await page.locator("#folder-extract").click();
  await answer(page);
  await finished(page);
  const state = await outputState(page);
  expect(state.directoryCalls).toBe(1);
  for (const file of state.files) expect(file.opens, file.path).toBe(1);
  return state.files
    .filter((file) => file.closed && !file.aborted)
    .map((file) => ({ name: file.path, body: Buffer.from(file.bytes) }));
}

// `node/extract-hostile.test.ts` checks the extraction rules for each
// hostile archive with the real workers and wasm. The tests here check the
// page: the pickers, the download, the dialog and the report.
for (const route of ["directory", "download"] as const) {
  test.describe(route, () => {
    // The download streams through the service worker.
    test.use({ serviceWorkers: route === "download" ? "allow" : "block" });

    test.beforeEach(async ({ page }) => {
      await outputRoute(page, route);
    });

    test("one entry verifies method 8 and saves exact bytes", async ({ page, browserName }) => {
      const data = Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 251));
      await open(page, [{ name: "one.bin", body: data, method: 8 }]);
      await selectEntry(page, "one.bin");
      if (route === "download") {
        const pending = page.waitForEvent("download");
        await page.locator("#preview-extract").click();
        const download = await pending;
        expect(download.suggestedFilename()).toBe("one.bin");
        expect(await download.failure()).toBeNull();
        expect(readFileSync((await download.path())!)).toEqual(data);
        if (download.url().startsWith("blob:")) {
          expect(browserName).toBe("webkit");
          await expect(page.locator("#extract-memory")).toContainText(/size|bytes|KiB|MiB|GiB/i);
        } else {
          expect(new URL(download.url()).protocol).toMatch(/^https?:$/);
        }
      } else {
        await page.locator("#preview-extract").click();
        await finished(page);
        const state = await outputState(page);
        expect(state.saveCalls).toBe(1);
        expect(state.files).toHaveLength(1);
        expect(state.files[0]).toMatchObject({ closed: true, aborted: false });
        expect(Buffer.from(state.files[0]!.bytes)).toEqual(data);
      }
    });
  });
}

test("folder rejects traversal, roots, drives and NUL without losing safe siblings", async ({
  page,
}) => {
  await outputRoute(page, "directory");
  const unsafe = [
    "../escape",
    "a/../../escape",
    "a/../escape",
    "..\\escape",
    "a\\..\\escape",
    "a/..\\escape",
    "/absolute",
    "\\absolute",
    "//server/share/x",
    "\\\\server\\share\\x",
    "C:/escape",
    "c:\\escape",
    "C:relative",
    "a/C:relative",
    "\\\\?\\C:\\escape",
    "zero\0tail",
    "a/zero\0tail",
    "../",
    "a/../",
    "/",
    "C:",
    `${"d/".repeat(32_000)}../escape`,
    "../<img id=extraction-injected src=x onerror=alert(1)>",
  ];
  const safe = ["ok.txt", ".../ok", "..hidden", "x..y", "deep/a/b.txt"];
  // A segment that ends with a dot gets "_"
  // (renamed, TRAILING), because Windows removes trailing dots and
  // would make "..." the same as an empty segment. Thus ".../ok" is
  // written as "..._/ok". This is stricter, not weaker.
  const output = (name: string) => name.replace(/^\.\.\.\//, "..._/");
  await open(page, [...unsafe.map((name) => body(name)), ...safe.map((name) => body(name))]);
  await selectRoot(page);
  const files = await folderOutput(page);
  expect(files.map((file) => file.name).sort()).toEqual(safe.map(output).sort());
  for (const file of files) expect(output(file.body.toString())).toBe(file.name);
  for (let row = 0; row < unsafe.length; row++) {
    await skipped(page, row, /path|travers|absolute|drive|NUL|invalid|unsafe/i);
  }
  await expect(page.locator("#extraction-injected")).toHaveCount(0);
});

// The download route of a corrupt entry: the stream of the service worker
// must fail, so no download completes.
test("one entry to the download never completes output for a false CRC", async ({ page }) => {
  await outputRoute(page, "download");
  await open(page, [{ ...body("bad.txt", "false CRC"), method: 8, crc: 0xdeadbeef }]);
  await selectEntry(page, "bad.txt");
  const downloads: Download[] = [];
  page.on("download", (download) => downloads.push(download));
  await page.locator("#preview-extract").click();
  await answer(page);
  await finished(page);
  await expect(item(page, 0)).toHaveAttribute("data-status", /^(failed|skipped)$/);
  await expect(item(page, 0)).toContainText(
    /CRC|checksum|size|longer|ended|decod|encrypt|invalid|deflate|method|unsupported/i,
  );
  for (const download of downloads) expect(await download.failure()).not.toBeNull();
  const state = await outputState(page);
  expect(state.files.every((file) => !file.closed || file.aborted)).toBe(true);
});

test("an approved entry streams to the save picker and waits for disk writes", async ({ page }) => {
  await outputRoute(page, "directory");
  const size = 20 * 1024 * 1024;
  await open(page, [{ name: "large.bin", body: Buffer.alloc(size, 0x61), method: 8 }]);
  await selectEntry(page, "large.bin");
  // The writes are in the read worker, so the hold
  // is set there (setOutput).
  await setOutput(page, { holdWrites: true });
  await page.evaluate(() => {
    const counts = { reads: 0, maxBlob: 0 };
    Object.assign(window, { __streamCounts: counts });
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      message: unknown,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      const call = message as { type?: string; path?: string[] } | undefined;
      if (call?.type === "APPLY" && call.path?.at(-1) === "read") counts.reads++;
      return Reflect.apply(post, this, options === undefined ? [message] : [message, options]);
    };
    window.Blob = new Proxy(Blob, {
      construct(target, args: ConstructorParameters<typeof Blob>) {
        const blob = Reflect.construct(target, args) as Blob;
        counts.maxBlob = Math.max(counts.maxBlob, blob.size);
        return blob;
      },
    });
  });
  await page.locator("#preview-extract").click();
  // The 20 MiB of "a" is bomb-like; confirm in the
  // dialog of the page.
  await page.locator("#extract-confirm").click();
  await expect.poll(async () => (await outputState(page)).pendingWrites).toBe(1);
  const blocked = await outputState(page);
  expect(blocked.files[0]!.closed).toBe(false);
  expect(
    await page.evaluate(
      () => (window as unknown as { __streamCounts: { reads: number } }).__streamCounts.reads,
    ),
  ).toBeLessThanOrEqual(2);
  await releaseWrites(page);
  await finished(page);
  const file = (await outputState(page)).files[0]!;
  expect(file.closed).toBe(true);
  expect(file.aborted).toBe(false);
  expect(file.byteLength).toBe(size);
  expect(file.writes).toBeGreaterThan(1);
  expect(file.maxWrite).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(
    await page.evaluate(
      () => (window as unknown as { __streamCounts: { maxBlob: number } }).__streamCounts.maxBlob,
    ),
  ).toBeLessThanOrEqual(16 * 1024 * 1024);
});

test.describe("Safari Blob fallback", () => {
  test.use({ serviceWorkers: "block" });
  test("a failed stream gives a size warning and an exact Blob download", async ({
    page,
    browserName,
  }) => {
    // The tests run on Chromium only. With the service worker blocked, Chromium takes
    // the same Blob path, so the test runs there.
    expect(browserName).toBe("chromium");
    await outputRoute(page, "download");
    const data = Buffer.from("Safari fallback data\n".repeat(100));
    await open(page, [{ name: "fallback.txt", body: data, method: 8 }]);
    await selectEntry(page, "fallback.txt");
    const pending = page.waitForEvent("download");
    await page.locator("#preview-extract").click();
    // The size warning (#extract-memory) asks before
    // the Blob and goes when the user confirms, so it is checked first.
    await expect(page.locator("#extract-memory")).toContainText(/size|bytes|KiB|MiB|GiB/i);
    await page.locator("#extract-confirm").click();
    const download = await pending;
    expect(download.url()).toMatch(/^blob:/);
    expect(await download.failure()).toBeNull();
    expect(readFileSync((await download.path())!)).toEqual(data);
  });
});
