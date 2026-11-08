// Extraction on Chromium: one entry and a folder, through the
// File System Access pickers (stubbed with the origin private file
// system, so that a test can read the result), and through the fallback
// paths with the pickers removed: a service-worker streamed download, and
// a Blob without a service worker. The tests run on Chromium only (see
// playwright.config.ts), so each path runs here with the APIs of
// Chromium removed or stubbed.
import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { contentZip } from "./content-zip";
import { LINK, text } from "./extract-zip";
import type { ContentEntry } from "./content-zip";
import { openArchive, waitForOutcome } from "./listing";
import { readZip } from "./read-zip";

/** The folder of the folder tests: good files, collisions, a reserved
 *  name and hostile entries. */
const FOLDER: ContentEntry[] = [
  { name: "docs/a.txt", data: text(200_000) },
  { name: "docs/sub/b.txt", data: text(70_000, "zstd "), method: 93 },
  { name: "docs/stored.bin", data: text(5000, "s"), method: 0 },
  { name: "docs/CON.txt", data: Buffer.from("reserved") },
  { name: "docs/Readme.txt", data: Buffer.from("first") },
  { name: "docs/README.txt", data: Buffer.from("second") },
  // The same name in NFC and in NFD, and a right-to-left override.
  { name: "docs/caf\u00e9.txt", data: Buffer.from("nfc") },
  { name: "docs/cafe\u0301.txt", data: Buffer.from("nfd") },
  { name: "docs/x\u202etxt.exe", data: Buffer.from("bidi") },
  { name: "docs/link", data: Buffer.from("/etc/passwd"), method: 0, ...LINK },
  { name: "docs/../evil.txt", data: Buffer.from("evil") },
  { name: "docs/bad-crc.txt", data: Buffer.from("bad crc data"), crc: 0x12345678 },
  // The data decodes to more bytes than the central directory declares,
  // and the CRC-32 of the declared bytes agrees.
  { name: "docs/long.txt", data: text(1000), size: 10, crc: crc32(text(1000).subarray(0, 10)) },
  { name: "other.txt", data: Buffer.from("not in docs") },
];

async function open(page: Page, entries: ContentEntry[], file = "extract.zip") {
  const path = test.info().outputPath(file);
  writeFileSync(path, contentZip(entries));
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openArchive(page, path);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
}

/** Stubs the pickers with the origin private file system: the save
 *  picker gives a new file in it, the folder picker the folder `out`. */
async function stubPickers(page: Page) {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    Object.assign(window, {
      __pickerCalls: calls,
      showSaveFilePicker: async (options: { suggestedName: string }) => {
        calls.push({ kind: "save", ...options });
        const root = await navigator.storage.getDirectory();
        return root.getFileHandle(options.suggestedName, { create: true });
      },
      showDirectoryPicker: async (options: unknown) => {
        calls.push({ kind: "directory", options });
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle("out", { create: true });
      },
    });
  });
}

/** Removes the pickers, as in Firefox and Safari. */
async function removePickers(page: Page, serviceWorker = true) {
  await page.addInitScript((keepWorker) => {
    for (const name of ["showSaveFilePicker", "showDirectoryPicker"]) {
      Object.defineProperty(window, name, { value: undefined, configurable: true });
    }
    if (!keepWorker) {
      Object.defineProperty(Navigator.prototype, "serviceWorker", {
        get: () => undefined,
        configurable: true,
      });
    }
  }, serviceWorker);
}

/** The files below a folder of the origin private file system, by path. */
async function privateFiles(page: Page, folder?: string): Promise<Record<string, string>> {
  return page.evaluate(async (start) => {
    const out: Record<string, string> = {};
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      for await (const [name, handle] of (
        dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
      ).entries()) {
        if (handle.kind === "directory") {
          await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`);
        } else {
          const file = await (handle as FileSystemFileHandle).getFile();
          out[`${prefix}${name}`] = await file.text();
        }
      }
    };
    let root = await navigator.storage.getDirectory();
    if (start !== undefined) root = await root.getDirectoryHandle(start);
    await walk(root, "");
    return out;
  }, folder);
}

const rows = (page: Page) => page.locator("#list-viewport [data-row]:not([hidden])");

async function extractFromMenu(page: Page, label: string) {
  await rows(page).filter({ hasText: label }).first().click({ button: "right" });
  await page.locator('#row-menu [data-action="extract"]').click();
}

test.describe("native pickers", () => {
  test.beforeEach(async ({ page }) => stubPickers(page));

  test("one entry goes to the file of the save picker and verifies", async ({ page }) => {
    await open(page, [{ name: "a.txt", data: text(300_000) }]);
    await rows(page).filter({ hasText: "a.txt" }).first().dblclick();
    await page.locator("#preview-extract").click();
    await expect(page.locator("#extract-status")).toHaveText(
      "Saved “a.txt”. Its size and CRC-32 verified.",
    );
    const calls = await page.evaluate(
      () => (window as unknown as { __pickerCalls: unknown[] }).__pickerCalls,
    );
    expect(calls).toEqual([{ kind: "save", suggestedName: "a.txt" }]);
    expect((await privateFiles(page))["a.txt"]).toBe(text(300_000).toString());
  });

  test("an entry with a bad CRC-32 leaves no file", async ({ page }) => {
    await open(page, [{ name: "bad.txt", data: text(5000), crc: 1 }]);
    await rows(page).filter({ hasText: "bad.txt" }).first().dblclick();
    await page.locator("#preview-extract").click();
    await expect(page.locator("#extract-title")).toContainText("failed");
    await expect(page.locator("#extract-summary")).toContainText("did not extract");
    await expect(page.locator("#extract-summary")).toHaveAttribute("data-tone", "crit");
    await expect(page.locator("#extract-report")).toContainText("CRC-32");
    expect((await privateFiles(page))["bad.txt"] ?? "").toBe("");
  });

  test("a folder goes to a new folder, and the report lists each rename and skip", async ({
    page,
  }) => {
    await open(page, FOLDER);
    await extractFromMenu(page, "docs");
    const dialog = page.locator("#extract-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.locator("#extract-facts")).toContainText("in 1 folder");
    await expect(page.locator("#extract-where")).toContainText("makes the folder “docs”");
    // No risk: the confirm button is the primary button and has the focus.
    await expect(page.locator("#extract-confirm")).toBeFocused();
    await page.locator("#extract-confirm").click();
    // 11 planned files (the link and the “..” path are not files of the
    // plan); 2 of them did not verify.
    await expect(page.locator("#extract-summary")).toHaveText(
      /^Extracted 9 of 11 files \(.+\) to “docs”\. Each written file verified\.$/,
    );
    // Two files did not verify: the complete job shows the warn tone.
    await expect(page.locator("#extract-summary")).toHaveAttribute("data-tone", "warn");
    const files = await privateFiles(page, "out");
    expect(files).toEqual({
      "docs/a.txt": text(200_000).toString(),
      "docs/sub/b.txt": text(70_000, "zstd ").toString(),
      "docs/stored.bin": text(5000, "s").toString(),
      "docs/CON_.txt": "reserved",
      "docs/Readme.txt": "first",
      "docs/README (2).txt": "second",
      "docs/caf\u00e9.txt": "nfc",
      // Output names come from the NFC form.
      "docs/caf\u00e9 (2).txt": "nfd",
      "docs/x_txt.exe": "bidi",
    });
    // Each group has a label row, so the
    // items are the rows with `data-row`.
    const report = page.locator("#extract-report tbody tr[data-row]");
    const lines = await report.allTextContents();
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^docs\/link.*symbolic link/),
        expect.stringMatching(/^docs\/\.\.\/evil\.txt.*“\.\.” segment/),
        expect.stringMatching(/^docs\/CON\.txt.*Renamed to CON_\.txt.*reserved/),
        expect.stringMatching(/^docs\/README\.txt.*Renamed to README \(2\)\.txt.*case/),
        expect.stringMatching(/^docs\/bad-crc\.txt.*did not verify.*CRC-32/),
        expect.stringMatching(/^docs\/long\.txt.*did not verify.*longer/),
        expect.stringMatching(/^docs\/cafe\u0301\.txt.*Renamed to caf\u00e9 \(2\)\.txt/),
        // The report shows the mark of
        // the override, not the override itself.
        expect.stringMatching(/^docs\/x\u25CAtxt\.exe.*Renamed to x_txt\.exe.*characters/),
      ]),
    );
    expect(lines).toHaveLength(8);
    // A second extraction does not write into the first folder.
    await page.locator("#extract-close").click();
    await extractFromMenu(page, "docs");
    await page.locator("#extract-confirm").click();
    await expect(page.locator("#extract-summary")).toContainText("to “docs (2)”");
  });
});

test.describe("fallback without pickers", () => {
  // The download streams through the service worker.
  test.use({ serviceWorkers: "allow" });

  test("one entry streams through the service worker", async ({ page }) => {
    await removePickers(page);
    const body = text(9 * 1024 * 1024 + 17);
    await open(page, [{ name: "data.txt", data: body }]);
    await rows(page).filter({ hasText: "data.txt" }).first().dblclick();
    const download = page.waitForEvent("download");
    await page.locator("#preview-extract").click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("data.txt");
    const path = await file.path();
    expect(readFileSync(path).equals(body)).toBe(true);
    await expect(page.locator("#extract-status")).toHaveText(
      "Saved “data.txt”. Its size and CRC-32 verified.",
    );
  });

  test("a folder downloads one zip that the read worker builds", async ({ page }) => {
    await removePickers(page);
    await open(page, FOLDER);
    await extractFromMenu(page, "docs");
    await expect(page.locator("#extract-where")).toHaveText(
      "The browser downloads one zip file, docs.zip.",
    );
    const download = page.waitForEvent("download");
    await page.locator("#extract-confirm").click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("docs.zip");
    await expect(page.locator("#extract-summary")).toContainText("Extracted 9 of 11 files");
    const entries = readZip(readFileSync(await file.path()));
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
    expect(Object.keys(byName).sort()).toEqual(
      [
        "sub/",
        "a.txt",
        "sub/b.txt",
        "stored.bin",
        "CON_.txt",
        "Readme.txt",
        "README (2).txt",
        "caf\u00e9.txt",
        "caf\u00e9 (2).txt",
        "x_txt.exe",
      ].sort(),
    );
    expect(entries.every((entry) => entry.verified)).toBe(true);
    // Deflate and stored data pass through; Zstandard is stored decoded.
    expect(byName["a.txt"]!.method).toBe(8);
    expect(byName["stored.bin"]!.method).toBe(0);
    expect(byName["sub/b.txt"]!.method).toBe(0);
    expect(byName["a.txt"]!.data.equals(text(200_000))).toBe(true);
    expect(byName["sub/b.txt"]!.data.equals(text(70_000, "zstd "))).toBe(true);
    // The passed-through bytes are the bytes of the archive.
    const original = contentZip(FOLDER);
    expect(original.includes(deflateRawSync(text(200_000)))).toBe(true);
  });

  test("without a service worker, a Blob download asks first", async ({ page }) => {
    await removePickers(page, false);
    await open(page, [{ name: "c.txt", data: text(4000) }]);
    await rows(page).filter({ hasText: "c.txt" }).first().dblclick();
    await page.locator("#preview-extract").click();
    await expect(page.locator("#extract-memory")).toContainText("keeps c.txt in memory");
    const download = page.waitForEvent("download");
    await page.locator("#extract-confirm").click();
    const file = await download;
    expect(readFileSync(await file.path()).equals(text(4000))).toBe(true);
  });
});

test.describe("confirmation", () => {
  test.beforeEach(async ({ page }) => stubPickers(page));

  test("a ratio above 100× needs confirmation, and Cancel writes nothing", async ({ page }) => {
    // The ratio rule needs a file of at least 16 MiB.
    await open(page, [{ name: "bomb.bin", data: Buffer.alloc(20 * 1024 * 1024) }]);
    await rows(page).filter({ hasText: "bomb.bin" }).first().dblclick();
    await page.locator("#preview-extract").click();
    await expect(page.locator("#extract-warnings")).toContainText("100 times larger");
    // The safeguard belongs to the risk, so
    // it is the last line of the band.
    await expect(page.locator("#extract-warnings")).toContainText(
      "An extraction can write all of the declared bytes.",
    );
    await expect(page.locator("#extract-safeguard")).toHaveText(
      "Zipscope stops a file when its data is longer than its declared size.",
    );
    await expect(page.locator("#extract-confirm")).toHaveText("Extract anyway");
    // Cancel has the focus, and "Extract anyway" is a plain button: it has
    // the same fill as Cancel.
    await expect(page.locator("#extract-cancel")).toBeFocused();
    const fill = (id: string) =>
      page.locator(id).evaluate((button) => getComputedStyle(button).backgroundColor);
    expect(await fill("#extract-confirm")).toBe(await fill("#extract-cancel"));
    // Enter on the focused Cancel closes the dialog.
    await page.keyboard.press("Enter");
    await expect(page.locator("#extract-dialog")).toHaveCount(0);
    const calls = await page.evaluate(
      () => (window as unknown as { __pickerCalls: unknown[] }).__pickerCalls,
    );
    expect(calls).toEqual([]);
  });

  test("a folder of small text files with high ratios needs no confirmation", async ({ page }) => {
    // A 9.1 KiB docs folder (more than 100 times its
    // compressed size) is not a zip bomb. The ratio rule needs 16 MiB.
    await open(page, [
      { name: "docs/readme.txt", data: Buffer.from("hello zipscope ".repeat(400)) },
      { name: "docs/notes.txt", data: Buffer.from("note ".repeat(640)) },
      { name: "top.txt", data: text(10) },
    ]);
    await extractFromMenu(page, "docs");
    await expect(page.locator("#extract-dialog")).toBeVisible();
    await expect(page.locator("#extract-warnings")).toHaveCount(0);
    // No risk: the confirm button is the primary button and has the focus.
    await expect(page.locator("#extract-confirm")).toHaveText("Choose folder…");
    await expect(page.locator("#extract-confirm")).toBeFocused();
  });
});
