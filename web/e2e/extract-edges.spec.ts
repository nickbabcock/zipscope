// Edge cases of the extraction: a file of the save
// picker keeps its data when an extraction fails or stops; names that are
// the same only after the cut to 255 bytes or NFC keep both payloads; and
// a renamed entry on its own is in the report.
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { hostileZip, readDownload } from "./hostile-zip";
import type { HostileEntry } from "./hostile-zip";
import {
  outputRoute,
  outputState,
  recordWorkers,
  releaseWrites,
  setOutput,
} from "./extract-output";
import { openArchive, waitForOutcome } from "./listing";

const ORIGINAL = "valuable original";

async function open(page: Page, entries: HostileEntry[]) {
  const path = test.info().outputPath("edges.zip");
  writeFileSync(path, hostileZip(entries));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openArchive(page, path);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
}

/** Writes a file of the user in the folder of the save picker stub. */
async function userFile(page: Page, name: string) {
  await page.evaluate(
    async ([file, text]) => {
      const root = await navigator.storage.getDirectory();
      const saved = await root.getDirectoryHandle("saved", { create: true });
      const handle = await saved.getFileHandle(file!, { create: true });
      const writable = await handle.createWritable();
      await writable.write(text!);
      await writable.close();
    },
    [name, ORIGINAL],
  );
}

async function savedText(page: Page, name: string): Promise<string | undefined> {
  return page.evaluate(async (file) => {
    const root = await navigator.storage.getDirectory();
    const saved = await root.getDirectoryHandle("saved", { create: true });
    try {
      return await (await (await saved.getFileHandle(file)).getFile()).text();
    } catch {
      return undefined;
    }
  }, name);
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

const report = (page: Page) => page.locator("#extraction-report");

test("a failed extraction keeps the data of a file that the save picker gave", async ({ page }) => {
  await outputRoute(page, "directory");
  await open(page, [{ name: "bad.txt", body: Buffer.from("bad data"), method: 8, crc: 0x1234 }]);
  await userFile(page, "bad.txt");
  await selectEntry(page, "bad.txt");
  await page.locator("#preview-extract").click();
  await expect(report(page)).toHaveAttribute("data-state", "failed");
  await expect(report(page).locator('[data-row="0"]')).toContainText("CRC-32");
  expect(await savedText(page, "bad.txt")).toBe(ORIGINAL);
});

test("a cancelled extraction keeps the data of a file that the save picker gave", async ({
  page,
}) => {
  await outputRoute(page, "directory");
  const data = Buffer.from(Array.from({ length: 12 * 1024 * 1024 }, (_, i) => (i * 7) % 251));
  await open(page, [{ name: "big.bin", body: data, method: 0 }]);
  await userFile(page, "big.bin");
  await selectEntry(page, "big.bin");
  await setOutput(page, { holdWrites: true });
  await page.locator("#preview-extract").click();
  await expect.poll(async () => (await outputState(page)).pendingWrites).toBe(1);
  await page.locator("#extract-card-close").click();
  await releaseWrites(page);
  await expect.poll(async () => (await outputState(page)).files[0]?.aborted).toBe(true);
  expect(await savedText(page, "big.bin")).toBe(ORIGINAL);
});

test("a renamed entry on its own is in the report with both names", async ({ page }) => {
  await outputRoute(page, "directory");
  await open(page, [
    { name: "dir/CON.txt", body: Buffer.from("device") },
    { name: "top.txt", body: Buffer.from("t") },
  ]);
  await page
    .locator('#list-viewport [data-part="label"]')
    .filter({ hasText: "dir" })
    .first()
    .dblclick();
  await selectEntry(page, "CON.txt");
  await page.locator("#preview-extract").click();
  const row = report(page).locator('[data-row="0"]');
  await expect(row).toHaveAttribute("data-status", "renamed");
  await expect(row).toHaveAttribute("data-output-path", "CON_.txt");
  await expect(row).toContainText("dir/CON.txt");
  await expect(row).toContainText("Renamed to CON_.txt (a Windows reserved name)");
  expect(await savedText(page, "CON_.txt")).toBe("device");
});

/** Names that are the same only after the cut or NFC. */
const LONG: HostileEntry[] = [
  { name: `u/${"a".repeat(253)}é`, body: Buffer.from("acute 253") },
  { name: `u/${"a".repeat(253)}è`, body: Buffer.from("grave 253") },
  { name: `u/${"a".repeat(254)}é`, body: Buffer.from("acute 254") },
  { name: `u/${"a".repeat(254)}è`, body: Buffer.from("grave 254") },
  { name: `u/${"a".repeat(254)}é`, body: Buffer.from("nfc 254") },
  { name: "top.txt", body: Buffer.from("t") },
];

for (const route of ["directory", "download"] as const) {
  test.describe(() => {
    // The download streams through the service worker.
    test.use({ serviceWorkers: route === "download" ? "allow" : "block" });

    test(`names that collide after the cut or NFC keep each payload (${route})`, async ({
      page,
    }) => {
      await outputRoute(page, route);
      await open(page, LONG);
      await page
        .locator("#list-viewport [data-row]:not([hidden])")
        .filter({ hasText: "u/" })
        .first()
        .click({ button: "right" });
      await recordWorkers(page);
      const pending = route === "download" ? page.waitForEvent("download") : undefined;
      await page.locator('#row-menu [data-action="extract"]').click();
      await page.locator("#extract-confirm").click();
      await expect(report(page)).toHaveAttribute("data-state", "complete");
      await expect(page.locator("#extract-summary")).toContainText("Extracted 5 of 5 files");
      let files: { name: string; body: string }[];
      if (pending !== undefined) {
        const download = await pending;
        files = readDownload(readFileSync((await download.path())!))
          .filter((entry) => !entry.name.endsWith("/"))
          .map((entry) => ({ name: entry.name, body: entry.body.toString() }));
      } else {
        files = (await outputState(page)).files
          .filter((file) => file.closed && !file.aborted)
          .map((file) => ({ name: file.path, body: Buffer.from(file.bytes).toString() }));
      }
      expect(files.map((file) => file.body).sort()).toEqual(
        LONG.slice(0, 5)
          .map((entry) => entry.body.toString())
          .sort(),
      );
      const names = files.map((file) => file.name.normalize("NFC").toLowerCase());
      expect(new Set(names).size).toBe(names.length);
      for (const file of files) expect(Buffer.byteLength(file.name)).toBeLessThanOrEqual(255);
    });
  });
}

/** Pairs that APFS and NTFS treat as one name. */
const FOLDS: HostileEntry[] = [
  ["µ", "μ"],
  ["ς", "σ"],
  ["ſ", "s"],
  ["ϐ", "β"],
  ["ß", "ss"],
  ["ı", "i"],
  // The dotted capital I, and folds that differ only in
  // composition (the read wasm takes NFD from JavaScript).
  ["\u0130", "i\u0307"],
  ["\u0390", "\u03aa\u0301"],
]
  .flatMap(([first, second]) => [
    { name: `k/${first}.txt`, body: Buffer.from(`first ${first}`) },
    { name: `k/${second}.txt`, body: Buffer.from(`second ${second}`) },
  ])
  .concat([
    // A folder pair of the same kind: the second folder gets a suffix.
    { name: "k/\u03b0/a.txt", body: Buffer.from("folder one") },
    { name: "k/\u03ab\u0301/b.txt", body: Buffer.from("folder two") },
    { name: "top.txt", body: Buffer.from("t") },
  ]);

test("names that one case fold joins get a suffix and keep each payload", async ({ page }) => {
  await outputRoute(page, "directory");
  await open(page, FOLDS);
  await page
    .locator("#list-viewport [data-row]:not([hidden])")
    .filter({ hasText: "k/" })
    .first()
    .click({ button: "right" });
  await recordWorkers(page);
  await page.locator('#row-menu [data-action="extract"]').click();
  await page.locator("#extract-confirm").click();
  await expect(report(page)).toHaveAttribute("data-state", "complete");
  await expect(page.locator("#extract-summary")).toHaveText(
    /^Extracted 18 of 18 files \(.*\) to “k”\. Each file verified\.$/,
  );
  // Only renames: the neutral tone.
  await expect(page.locator("#extract-summary")).toHaveAttribute("data-tone", "info");
  // Each second name of a pair is renamed with a suffix: 8 files and the
  // second folder, which the report names with its real output path.
  await expect(report(page).locator('[data-status="renamed"]')).toHaveCount(9);
  await expect(report(page).locator('[data-row="-1"]')).toHaveAttribute(
    "data-output-path",
    "\u03ab\u0301 (2)/",
  );
  const files = (await outputState(page)).files.filter((file) => file.closed && !file.aborted);
  expect(files.map((file) => Buffer.from(file.bytes).toString()).sort()).toEqual(
    FOLDS.slice(0, 18)
      .map((entry) => entry.body.toString())
      .sort(),
  );
});
