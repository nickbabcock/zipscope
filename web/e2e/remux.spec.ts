// The zstd remux on Chromium: the warning and its focus, the
// copy through the save picker (stubbed with the origin private file
// system), the copy through the streamed download without the picker, and a
// cancel that leaves no complete copy. The button is in the
// Archive panel, and the report compares the copy with the archive. The
// dialog says how much of the archive is stored or
// barely compressed. `node/remux.test.ts` checks the hint and the report of
// more archive shapes, and the memory limit, with the real workers and wasm.
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { contentZip } from "./content-zip";
import type { ContentEntry } from "./content-zip";
import { holdableWorkers, holdWorkers, releaseWorkers } from "./hold";
import { openArchive, waitForOutcome } from "./listing";
import { hasEndRecord, noise, OUTSIDE, readCopy, REMUX_ENTRIES, SMALL, text } from "./remux-zip";

async function open(page: Page, entries: ContentEntry[], file = "remux.zip") {
  const path = test.info().outputPath(file);
  writeFileSync(path, contentZip(entries));
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openArchive(page, path);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  return path;
}

/** Opens the Archive panel, and the dialog of the zstd copy from it. */
async function openRemux(page: Page) {
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
  await page.locator("#archive-remux #remux-button").click();
}

/** Stubs the save picker with the origin private file system. */
async function stubPicker(page: Page) {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    Object.assign(window, {
      __pickerCalls: calls,
      showSaveFilePicker: async (options: { suggestedName: string }) => {
        calls.push({ suggestedName: options.suggestedName });
        const root = await navigator.storage.getDirectory();
        return root.getFileHandle(options.suggestedName, { create: true });
      },
    });
  });
}

async function cores(page: Page, count: number) {
  await page.addInitScript((value) => {
    Object.defineProperty(Navigator.prototype, "hardwareConcurrency", {
      get: () => value,
      configurable: true,
    });
  }, count);
}

async function privateFile(page: Page, name: string): Promise<Buffer> {
  const bytes = await page.evaluate(async (file) => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(file);
    return [...new Uint8Array(await (await handle.getFile()).arrayBuffer())];
  }, name);
  return Buffer.from(bytes);
}

/** Checks a copy of `REMUX_ENTRIES`. */
function checkCopy(zip: Buffer) {
  const copy = readCopy(zip);
  // The bad CRC-32 row is left out; the others keep their order.
  expect(copy.entries.map((entry) => entry.name)).toEqual(
    REMUX_ENTRIES.filter((entry) => entry.name !== "bad-crc.txt").map((entry) => entry.name),
  );
  for (const entry of copy.entries) {
    const source = REMUX_ENTRIES.find((item) => item.name === entry.name)!;
    expect(entry.verified, entry.name).toBe(true);
    expect(entry.data.equals(source.data), entry.name).toBe(true);
    // The DOS time of the archive: 2026-10-28 09:13.
    expect([entry.time, entry.date], entry.name).toEqual([
      (9 << 11) | (13 << 5),
      (46 << 9) | (10 << 5) | 28,
    ]);
  }
  const byName = Object.fromEntries(copy.entries.map((entry) => [entry.name, entry]));
  expect(byName["docs/readme.txt"]!.method).toBe(93);
  expect(byName["docs/stored.txt"]!.method).toBe(93);
  // Zstandard already: the bytes of the archive, unchanged.
  expect(byName["docs/already.txt"]!.method).toBe(93);
  // A compressed format and data that does not get smaller are not
  // compressed again.
  expect(byName["img/red.png"]!.method).not.toBe(93);
  expect(byName["bin/noise.bin"]!.method).toBe(0);
  expect(byName["bin/noise.bin"]!.compressed.length).toBe(200_000);
  expect(byName["docs/readme.txt"]!.compressed.length).toBeLessThan(300_000 / 4);
  expect(crc32(byName["tail.txt"]!.data) >>> 0).toBe(crc32(text(10_000, 5)) >>> 0);
}

/** Opens the bytes of an archive and the dialog of the zstd copy. */
async function openBytes(page: Page, zip: Buffer, file: string) {
  const path = test.info().outputPath(file);
  writeFileSync(path, zip);
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openArchive(page, path);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  await openRemux(page);
  // The count has ended when the facts have the bytes.
  await expect(page.locator("#remux-facts")).toContainText("uncompressed.");
}

test.describe("save picker", () => {
  test.beforeEach(async ({ page }) => stubPicker(page));

  test("the warning comes first, with Cancel focused and no primary button", async ({ page }) => {
    await open(page, REMUX_ENTRIES);
    await openRemux(page);
    const dialog = page.locator("#remux-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.locator("#remux-warning")).toContainText("Windows Explorer");
    await expect(page.locator("#remux-warning")).toContainText("method 93");
    await expect(page.locator("#remux-facts")).toContainText("8 entries");
    await expect(page.locator("#remux-cancel")).toBeFocused();
    const fill = (id: string) =>
      page.locator(id).evaluate((button) => getComputedStyle(button).backgroundColor);
    expect(await fill("#remux-confirm")).toBe(await fill("#remux-cancel"));
    // Enter on the focused Cancel closes the dialog and saves nothing.
    await page.keyboard.press("Enter");
    await expect(page.locator("#remux-dialog")).toHaveCount(0);
    const calls = await page.evaluate(
      () => (window as unknown as { __pickerCalls: unknown[] }).__pickerCalls,
    );
    expect(calls).toEqual([]);
  });

  test("the button is in the Archive panel, not in the table strip", async ({ page }) => {
    await open(page, REMUX_ENTRIES);
    await expect(page.locator("#remux-button")).toHaveCount(0);
    await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
    await expect(page.locator("#table-pane #remux-button")).toHaveCount(0);
    await expect(page.locator("#archive-remux #remux-button")).toHaveText("Save zstd copy…");
  });

  test("near zero: a small stored part is low, and Cancel has the focus", async ({ page }) => {
    await open(page, [
      // Deflate makes this about half its size: not barely compressed.
      { name: "a.bin", data: Buffer.concat([noise(200_000, 1), text(200_000, 1)]) },
      { name: "small.txt", data: text(2000, 2), method: 0 },
    ]);
    await openRemux(page);
    const hint = page.locator("#remux-hint");
    // A no-break space joins a number and its unit.
    await expect(hint).toHaveText(
      /^Only 2\.0\sKiB of this archive \([\d.]+%\) is stored or barely compressed\. The copy is not likely to be much smaller than the archive\.$/,
    );
    await expect(hint).toHaveAttribute("data-low", "true");
    // The lead of the band is the only bold
    // line, and the conclusion is a line of its own at the weight of the facts.
    expect(await hint.evaluate((node) => getComputedStyle(node).fontWeight)).toBe("400");
    const conclusion = page.locator("#remux-estimate");
    await expect(conclusion).toHaveText(
      "The copy is not likely to be much smaller than the archive.",
    );
    expect(await conclusion.evaluate((node) => getComputedStyle(node).fontWeight)).toBe("400");
    await expect(page.locator("#remux-cancel")).toBeFocused();
  });

  test("a stored row that the copy leaves out: the hint and the report do not count it", async ({
    page,
  }) => {
    // No row has the mark of a wrapped offset here. The list gives both rows as stored.
    await open(
      page,
      [
        { name: "secret.bin", data: noise(400_000), method: 0, flags: 1 },
        { name: "small.txt", data: text(2000, 2), method: 0 },
      ],
      "encrypted.zip",
    );
    await openRemux(page);
    await expect(page.locator("#remux-facts")).toContainText("The copy leaves it out.");
    await expect(page.locator("#remux-hint")).toHaveText(
      /^2\.0\sKiB of this archive \([\d.]+%\) is stored or barely compressed, not counting the entries left out\.$/,
    );
    await page.locator("#remux-confirm").click();
    const summary = page.locator("#remux-summary");
    await expect(summary).toContainText("1 entry left out.");
    await expect(summary).toContainText(/The archive is 392\.\d\sKiB\./);
    await expect(summary).not.toContainText("smaller than");
  });

  test("a prelude with no row left out: the dialog and the report say that the copy does not keep it", async ({
    page,
  }) => {
    await openBytes(page, Buffer.concat([noise(1_000_000), contentZip(SMALL)]), "outside.zip");
    const hint = page.locator("#remux-hint");
    await expect(hint).toHaveText(
      `No entry of this archive is stored or barely compressed. ${OUTSIDE}`,
    );
    await expect(page.locator("#remux-estimate")).toHaveCount(0);
    // The copy still asks the user to accept a risk, so Cancel has the focus.
    await expect(page.locator("#remux-cancel")).toBeFocused();
    await page.locator("#remux-confirm").click();
    const status = page.locator("#remux-status");
    await expect(status).toContainText(/\(100%\) smaller than the archive/);
    await expect(status).toContainText(OUTSIDE);
    const copy = await privateFile(page, "outside-zstd.zip");
    expect(readCopy(copy).entries.map((entry) => entry.name)).toEqual(["a.txt"]);
    expect(copy.length).toBeLessThan(1000);
  });

  test("compressed formats only: they stay as they are, and the report says so", async ({
    page,
  }) => {
    // Stored data that does not compress, with the names of compressed
    // formats: the copy keeps it stored, and each file gets a data
    // descriptor, so the copy is a little larger.
    const entries: ContentEntry[] = [
      { name: "a.jpg", data: noise(300_000, 1), method: 0 },
      { name: "b.mp4", data: noise(200_000, 2), method: 0 },
    ];
    await open(page, entries, "noise.zip");
    await openRemux(page);
    const hint = page.locator("#remux-hint");
    await expect(hint).toHaveText(
      "The stored or barely compressed entries of this archive (488.3 KiB) are images, video or other compressed formats. The copy keeps them as they are. The copy is not likely to be much smaller than the archive.",
    );
    await expect(hint).toHaveAttribute("data-low", "true");
    await expect(page.locator("#remux-cancel")).toBeFocused();
    // The report compares the copy with the archive, and does not say
    // "Saved".
    await page.locator("#remux-confirm").click();
    const summary = page.locator("#remux-summary");
    await expect(summary).toHaveAttribute("data-tone", "warn");
    await expect(summary).toHaveText(
      // The title names the file, so the lead
      // has only the numbers. A difference under 1% has no band.
      /^2 entries in .+\.No entry got smaller with zstd\. Each entry verified\.The copy is 32\sB \(less than 0\.1%\) larger than the archive \(.+\)\.$/,
    );
  });

  test("a failed byte map: the dialog opens with the first sentence only", async ({ page }) => {
    const path = test.info().outputPath("failed.zip");
    writeFileSync(path, Buffer.concat([noise(1_000_000), contentZip(SMALL)]));
    await page.goto("/");
    await page.setViewportSize({ width: 1440, height: 900 });
    await openArchive(page, path);
    const result = await waitForOutcome(page);
    expect(result.outcome, result.status).toBe("complete");
    // After the listing, the browser cannot read a file with a new modified time.
    utimesSync(path, new Date(0), new Date(0));
    await openRemux(page);
    await expect(page.locator("#archive-map")).toContainText("could not be read");
    await expect(page.locator("#remux-dialog")).toBeVisible();
    await expect(page.locator("#remux-hint")).toHaveText(
      "No entry of this archive is stored or barely compressed.",
    );
  });

  test("a byte map that runs: the dialog shows, and the late sentence does not move the focus", async ({
    page,
  }) => {
    await holdableWorkers(page);
    const path = test.info().outputPath("held.zip");
    writeFileSync(path, Buffer.concat([noise(1_000_000), contentZip(SMALL)]));
    await page.goto("/");
    await page.setViewportSize({ width: 1440, height: 900 });
    await openArchive(page, path);
    const result = await waitForOutcome(page);
    expect(result.outcome, result.status).toBe("complete");
    // The panel asks for the map after this, so its answer waits.
    await holdWorkers(page);
    await openRemux(page);
    const hint = page.locator("#remux-hint");
    await expect(page.locator("#remux-dialog")).toBeVisible();
    await expect(hint).toHaveText("No entry of this archive is stored or barely compressed.");
    await expect(page.locator("#remux-cancel")).toBeFocused();
    await page.locator("#remux-confirm").focus();
    await releaseWorkers(page);
    await expect(hint).toHaveText(
      `No entry of this archive is stored or barely compressed. ${OUTSIDE}`,
    );
    await expect(page.locator("#remux-confirm")).toBeFocused();
  });

  test("the copy goes to the file of the picker and round-trips", async ({ page }) => {
    await open(page, REMUX_ENTRIES);
    await openRemux(page);
    await page.locator("#remux-confirm").click();
    await expect(page.locator("#remux-summary")).toContainText("7 entries in");
    await expect(page.locator("#remux-title")).toContainText("Saved “remux-zstd.zip”");
    // The bad CRC-32 row is left out, so the summary gives no saving.
    await expect(page.locator("#remux-summary")).toContainText("The archive is");
    await expect(page.locator("#remux-summary")).not.toContainText("smaller than");
    await expect(page.locator("#remux-summary")).toHaveAttribute("data-tone", "warn");
    await expect(page.locator("#remux-items tbody tr")).toHaveCount(1);
    await expect(page.locator("#remux-items")).toContainText("bad-crc.txt");
    await expect(page.locator("#remux-items")).toContainText("did not verify");
    const calls = await page.evaluate(
      () => (window as unknown as { __pickerCalls: unknown[] }).__pickerCalls,
    );
    expect(calls).toEqual([{ suggestedName: "remux-zstd.zip" }]);
    checkCopy(await privateFile(page, "remux-zstd.zip"));
  });

  test("a cancel aborts the file, so it has no end record", async ({ page }) => {
    await cores(page, 2);
    await open(page, [{ name: "large.bin", data: noise(48 * 1024 * 1024) }], "large.zip");
    await openRemux(page);
    await page.locator("#remux-confirm").click();
    await expect(page.locator("#remux-progress")).toBeVisible();
    await page.locator("#remux-card-close").click();
    await expect(page.locator("#remux-summary")).toContainText("Cancelled");
    // The writable of the picker is aborted, so the file did not change.
    await expect(page.locator("#remux-summary")).toContainText("the file did not change");
    await expect(page.locator("#remux-summary")).toHaveAttribute("data-tone", "crit");
    const bytes = await privateFile(page, "large-zstd.zip");
    expect(hasEndRecord(bytes)).toBe(false);
  });
});

test.describe("fallback without the picker", () => {
  // The download streams through the service worker.
  test.use({ serviceWorkers: "allow" });

  test("the copy streams through the service worker", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    });
    await open(page, REMUX_ENTRIES);
    await openRemux(page);
    await expect(page.locator("#remux-where")).toHaveText(
      "The browser downloads the copy, “remux-zstd.zip”.",
    );
    const download = page.waitForEvent("download");
    await page.locator("#remux-confirm").click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("remux-zstd.zip");
    await expect(page.locator("#remux-summary")).toContainText("7 entries");
    checkCopy(readFileSync(await file.path()));
  });

  test("without a service worker, the dialog says so and keeps nothing in memory", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
      Object.defineProperty(Navigator.prototype, "serviceWorker", {
        get: () => undefined,
        configurable: true,
      });
    });
    await open(page, REMUX_ENTRIES);
    await openRemux(page);
    await page.locator("#remux-confirm").click();
    await expect(page.locator("#remux-error")).toContainText("cannot stream the copy");
  });
});
