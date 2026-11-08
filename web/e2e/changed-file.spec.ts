// A file that changes on disk after it opened, on Chromium with a real file.
// The browser refuses each later read of the file, and it tells of the change
// only when a read goes to the file. A preview and a single entry read the file
// for each row, so the next row finds the change. A folder job reads the file at
// each 256 rows, so it finds the change when at most 255 more rows have started,
// and these rows have the bytes of the file that the user listed. The lead of a
// zstd copy reads the file with the same rule, and the copy then fails.
import { appendFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { contentZip } from "./content-zip";
import { openArchive, waitForOutcome } from "./listing";

const ROWS = 1500;
const REFUSED = "The central-directory record cannot be read";

/** A row name in the folder of the test. */
const rowName = (row: number) => `files/row-${String(row).padStart(4, "0")}.txt`;

/** A row body of about 5 KiB. The first rows are the largest, so they are the
 *  first in the table. */
const rowBody = (row: number) =>
  `row ${row}\n${randomBytes(2048).toString("hex")}${"-".repeat(ROWS - row)}`;

/** The rows are about 7.5 MiB in all: the first window of 4 MiB holds the first
 *  800 rows, and it does not hold the central directory. */
async function open(page: Page): Promise<{ path: string; bodies: string[] }> {
  const bodies = Array.from({ length: ROWS }, (_, row) => rowBody(row));
  const entries = bodies.map((body, row) => ({
    name: rowName(row),
    data: Buffer.from(body),
    method: 0 as const,
  }));
  const path = test.info().outputPath("changed.zip");
  writeFileSync(path, contentZip(entries));
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openArchive(page, path);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  return { path, bodies };
}

async function preview(page: Page, row: number) {
  await page
    .locator('#list-viewport [data-part="label"]', { hasText: rowName(row).slice(6) })
    .first()
    .dblclick();
}

/** The pickers give files and folders of the origin private file system. */
async function stubPickers(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, {
      showDirectoryPicker: async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle("out", { create: true });
      },
      showSaveFilePicker: async (options: { suggestedName: string }) => {
        const root = await navigator.storage.getDirectory();
        return root.getFileHandle(options.suggestedName, { create: true });
      },
    });
  });
}

/** The files below the folder `out`, by name. */
async function written(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const out: Record<string, string> = {};
    const walk = async (folder: FileSystemDirectoryHandle) => {
      for await (const [name, handle] of (
        folder as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
      ).entries()) {
        if (handle.kind === "directory") {
          await walk(handle as FileSystemDirectoryHandle);
        } else {
          out[name] = await (await (handle as FileSystemFileHandle).getFile()).text();
        }
      }
    };
    await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle("out"));
    return out;
  });
}

test("the next preview fails, although the window holds its bytes", async ({ page }) => {
  const { path } = await open(page);
  await preview(page, 0);
  await expect(page.locator("#preview-text")).toContainText("row 0");
  appendFileSync(path, "changed");
  await preview(page, 1);
  await expect(page.locator("#preview-error")).toContainText(REFUSED);
  await expect(page.locator("#preview-text")).toHaveCount(0);
});

test("the next single entry fails, although the window holds its bytes", async ({ page }) => {
  await stubPickers(page);
  const { path } = await open(page);
  await preview(page, 0);
  await expect(page.locator("#preview-text")).toContainText("row 0");
  await page.locator("#preview-extract").click();
  await expect(page.locator("#extract-status")).toContainText("Saved");
  await page.locator("#extract-card-close").click();
  await preview(page, 1);
  await expect(page.locator("#preview-text")).toContainText("row 1");
  appendFileSync(path, "changed");
  await page.locator("#preview-extract").click();
  await expect(page.locator("#extract-report")).toContainText(REFUSED);
  const names = await page.evaluate(async () => {
    const found: string[] = [];
    const root = await navigator.storage.getDirectory();
    for await (const [name] of (
      root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
    ).entries()) {
      found.push(name);
    }
    return found;
  });
  expect(names.sort()).toEqual([rowName(0).slice(6), rowName(1).slice(6)]);
  const second = await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    return (await (await root.getFileHandle(name)).getFile()).size;
  }, rowName(1).slice(6));
  // The dialog of the failed entry keeps the file as it was.
  expect(second).toBe(0);
});

test("a folder job after the change writes no file", async ({ page }) => {
  await stubPickers(page);
  const { path } = await open(page);
  await preview(page, 0);
  await expect(page.locator("#preview-text")).toContainText("row 0");
  await page.locator("#folder-extract").click();
  await page.locator("#extract-confirm").waitFor();
  appendFileSync(path, "changed");
  await page.locator("#extract-confirm").click();
  await expect(page.locator("#extract-summary")).toHaveText("Zipscope wrote no files to “files”.");
  await expect(page.locator("#extract-report")).toContainText(REFUSED);
  expect(await written(page)).toEqual({});
});

/**
 * Stops the job in the worker when the row `held` opens its output file. At
 * this time, the row has read its record, its local header and its data.
 */
function holdRow(held: number) {
  const state = { files: 0, holding: false, release: () => {} };
  Object.assign(self, { __hold: state });
  const create = FileSystemFileHandle.prototype.createWritable;
  FileSystemFileHandle.prototype.createWritable = async function (options) {
    if (state.files++ === held) {
      state.holding = true;
      await new Promise<void>((resolve) => (state.release = resolve));
    }
    return create.call(this, options);
  };
}

test("a folder job finds the change at the next check, and the rows before it are true", async ({
  page,
}) => {
  await stubPickers(page);
  const { path, bodies } = await open(page);
  // The preview starts the read worker, so the test can reach it.
  await preview(page, 0);
  await expect(page.locator("#preview-text")).toContainText("row 0");
  const before = page.workers();
  await Promise.all(before.map((worker) => worker.evaluate(holdRow, 256).catch(() => {})));
  await page.locator("#folder-extract").click();
  await page.locator("#extract-confirm").click();
  // Row 256 has passed its check: this is the worst case.
  await expect
    .poll(async () => {
      const held = await Promise.all(
        page
          .workers()
          .map((worker) =>
            worker
              .evaluate(
                () => (self as unknown as { __hold?: { holding: boolean } }).__hold?.holding,
              )
              .catch(() => false),
          ),
      );
      return held.includes(true);
    })
    .toBe(true);
  appendFileSync(path, "changed");
  await Promise.all(
    page
      .workers()
      .map((worker) =>
        worker
          .evaluate(() => (self as unknown as { __hold?: { release(): void } }).__hold?.release())
          .catch(() => {}),
      ),
  );
  // The rows 257 to 511 start after the change: 255 rows. Row 512 is refused.
  await expect(page.locator("#extract-summary")).toContainText(
    `Extracted 512 of ${ROWS.toLocaleString("en")} files`,
    { timeout: 30_000 },
  );
  await expect(page.locator("#extract-report")).toContainText(REFUSED);
  const files = await written(page);
  expect(Object.keys(files)).toHaveLength(512);
  bodies.slice(0, 512).forEach((body, row) => {
    expect(files[rowName(row).slice(6)] === body, rowName(row)).toBe(true);
  });
});

test.describe("a zstd copy", () => {
  /** Opens the rows of `open` after a first row of 48 MiB that does not
   *  compress. With one encoder, the copy is on this row for some time. */
  async function openLarge(page: Page): Promise<string> {
    const entries = [
      { name: "large.bin", data: randomBytes(48 * 1024 * 1024), method: 0 as const },
      ...Array.from({ length: ROWS }, (_, row) => ({
        name: rowName(row),
        data: Buffer.from(rowBody(row)),
        method: 0 as const,
      })),
    ];
    const path = test.info().outputPath("changed.zip");
    writeFileSync(path, contentZip(entries));
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "hardwareConcurrency", {
        get: () => 2,
        configurable: true,
      });
    });
    await page.goto("/");
    await page.setViewportSize({ width: 1440, height: 900 });
    await openArchive(page, path);
    const result = await waitForOutcome(page);
    expect(result.outcome, result.status).toBe("complete");
    await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
    await page.locator("#archive-remux #remux-button").click();
    return path;
  }

  /** The size of the file of the picker. */
  const copySize = (page: Page) =>
    page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      return (await (await root.getFileHandle("changed-zstd.zip")).getFile()).size;
    });

  test("a copy after the change fails, and the file of the picker does not change", async ({
    page,
  }) => {
    await stubPickers(page);
    const path = await openLarge(page);
    appendFileSync(path, "changed");
    await page.locator("#remux-confirm").click();
    await expect(page.locator("#remux-summary")).toContainText("Zipscope did not save");
    await expect(page.locator("#remux-summary")).toContainText("could not be read");
    expect(await copySize(page)).toBe(0);
  });

  test("a change during the copy fails the copy, and the file of the picker does not change", async ({
    page,
  }) => {
    await stubPickers(page);
    const path = await openLarge(page);
    await page.locator("#remux-confirm").click();
    await expect(page.locator("#remux-progress")).toBeVisible();
    appendFileSync(path, "changed");
    // A fill of a window or the next check of the lead finds the change: at
    // most 255 rows start after it.
    await expect(page.locator("#remux-summary")).toContainText("Zipscope did not save", {
      timeout: 30_000,
    });
    await expect(page.locator("#remux-summary")).toContainText("could not be read");
    expect(await copySize(page)).toBe(0);
  });
});
