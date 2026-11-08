// An archive over 4 GiB with no Zip64.
//
// What is real: Chromium, the workers, the wasm, the file reads and a file of
// more than 4 GiB on the disk of the test machine. What is not real: a test
// writes the file, not an old zip tool, and the rows that cannot be read are
// holes. The file is sparse, so it uses some kilobytes of disk, and the test
// checks that.
//
// These page tests check the strip, the panel, the preview, the mark of a
// row and the dialog of the zstd copy. `node/wrapped-offset.test.ts` and
// `node/remux.test.ts` check the findings, the facts, the extraction and the
// zstd copy of each shape with the real workers and wasm.
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openArchive, root, waitForOutcome } from "./listing";
import { DIRECTORY, GIB, theShape, writeWrappedZip } from "./wrapped-zip";
import type { WrappedRow } from "./wrapped-zip";

// CI uploads `web/test-results` after a failure, and an upload reads all bytes
// of a sparse file. So the file goes in a folder of its own below `target`,
// also if a killed worker cannot remove it. Each test removes it.
let folder: string | undefined;
test.afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

/** Writes a sparse zip with stored rows at exact places and no Zip64. */
function writeZip(rows: WrappedRow[], directory: number): string {
  folder = mkdtempSync(path.join(root, "target", "wrapped-offset-"));
  const file = path.join(folder, "wrapped.zip");
  writeWrappedZip(file, rows, directory);
  return file;
}

const REASON =
  "This entry cannot be read here. The archive is over 4 GiB and was written without Zip64, the format that large archives need, so its central directory does not give the true place of this entry";

async function open(page: Page, file: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
}

async function findingIds(page: Page): Promise<(string | null)[]> {
  await page.locator("#health-toggle").click();
  const panel = page.locator("#health-panel");
  await expect(panel).toBeVisible();
  const ids = await panel
    .locator("[data-finding]")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-finding")));
  return ids;
}

async function preview(page: Page, name: string): Promise<void> {
  await page
    .locator('#list-viewport [data-part="label"]')
    .filter({ hasText: name })
    .first()
    .dblclick();
}

test("the shape has one true finding, a reason on each row and a true byte map", async ({
  page,
}) => {
  await open(page, writeZip(theShape(), DIRECTORY));
  const strip = page.locator("#health-strip");
  await expect(strip).toHaveAttribute("data-severity", "warning");
  expect(await findingIds(page)).toEqual(["wrapped-offsets"]);
  const finding = page.locator('#health-panel [data-finding="wrapped-offsets"]');
  await expect(finding).toContainText(
    "This archive is over 4 GiB and was written without Zip64, the format that large archives need. 2 entries cannot be read here.",
  );
  await page.locator("#health-toggle").click();

  // The rows that cannot be read say why, and the row that can be read reads.
  await preview(page, "a.bin");
  await expect(page.locator("#preview-error")).toHaveText(REASON);
  await preview(page, "b.bin");
  await expect(page.locator("#preview-error")).toHaveText(REASON);
  await preview(page, "c.txt");
  await expect(page.locator("#preview-text")).toContainText("The last row can be read.");
  await expect(page.locator("#preview-error")).toHaveCount(0);

  // The mark of a row names it.
  const mark = page
    .locator("#list-viewport [data-row]:not([hidden])")
    .filter({ hasText: "a.bin" })
    .first()
    .locator('[aria-label^="Health:"]');
  await expect(mark).toHaveAttribute("aria-label", /cannot be read here/);

  // The panel has no false prelude and no false Zip64 rows.
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
  const panel = page.locator("#archive-panel");
  await expect(panel).toBeVisible();
  await expect(page.locator('[data-fact="zip64"] dd')).toHaveText("No");
  const offsets = page.locator('[data-fact="wrapped-offsets"] dd');
  await expect(offsets).toContainText("its offsets wrapped at 4 GiB");
  await expect(offsets).toHaveAttribute("data-level", "warning");
  await expect(page.locator('#byte-map-regions tbody[data-kind="entries"]').first()).toBeVisible();
  await expect(page.locator('#byte-map-regions tbody[data-kind="prelude"]')).toHaveCount(0);
  await expect(panel).not.toContainText("Prelude");
});

/** The save picker of a test: the copy goes to the private storage of the page. */
async function saveToStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async (options?: { suggestedName?: string }) => {
        const root = await navigator.storage.getDirectory();
        return root.getFileHandle(options?.suggestedName ?? "copy.zip", { create: true });
      },
    });
  });
}

test("a zstd copy gives no size outside the entries when a row has the mark", async ({ page }) => {
  await saveToStorage(page);
  // The true size of a.bin is 5 GiB, and its size field holds the low 32 bits. The list thus
  // shows 4 GiB of its bytes as a gap. These bytes are in an entry.
  const rows: WrappedRow[] = [
    { name: "a.bin", at: 0, size: GIB },
    { name: "c.txt", at: 5 * GIB + 100, body: "The last row can be read.\n" },
  ];
  await open(page, writeZip(rows, 5 * GIB + 300));
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
  await expect(page.locator("#archive-map")).toContainText(/2 gaps hold 4\.00\sGiB\./);
  await page.getByRole("button", { name: /Save zstd copy/ }).click();
  await expect(page.getByText("1 file cannot be read here. The copy leaves it out.")).toBeVisible();
  await expect(page.locator("#remux-hint")).toHaveText(
    "26 B of this archive (less than 0.1%) is stored or barely compressed, not counting the entries left out.",
  );
  await page.getByRole("button", { name: "Save zstd copy", exact: true }).last().click();
  const summary = page.locator("#remux-summary");
  await expect(summary).toContainText("1 entry left out.");
  await expect(summary).not.toContainText("outside the entries");
});
