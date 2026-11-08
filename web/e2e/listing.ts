// Helpers that open an archive in the app and read the listing from the
// row grid. The e2e tests and the benchmark use them.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { TreeListing } from "./test-data.ts";

export { archives, corpus, expectedTree, root } from "./test-data.ts";
export type { TreeListing } from "./test-data.ts";

/** The shown rows of the listing in the table: not the label row and the
 *  rows of the largest files below a short listing. */
export const LISTING_ROWS =
  '#list-viewport [data-row]:not([hidden]):not([data-block]):not([data-kind="heading"])';

export type Outcome = "complete" | "failed" | "cancelled";

/**
 * Opens a file through the file input, as the Open button does. While an
 * archive is open, a chosen file replaces it at once, except while a job
 * writes files: then the app asks, and the test answers.
 */
export async function openArchive(page: Page, file: string): Promise<void> {
  await page.locator("#file-input").setInputFiles(file);
}

/**
 * Drops a file on the page. While an archive is open, the app asks to
 * replace it or to open the file in a new tab, and the test
 * answers.
 */
export async function dropArchive(page: Page, file: string): Promise<void> {
  const bytes = (await readFile(file)).toString("base64");
  await page.evaluate(
    ({ name, base64 }) => {
      const data = new DataTransfer();
      const binary = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      data.items.add(new File([binary], name));
      document
        .querySelector("main")!
        .dispatchEvent(
          new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }),
        );
    },
    { name: path.basename(file), base64: bytes },
  );
}

/**
 * Waits until parsing ends and the listing shows all committed rows. Returns
 * the outcome and the status text.
 */
export async function waitForOutcome(
  page: Page,
  timeout = 30_000,
): Promise<{ outcome: Outcome; status: string; rows: number }> {
  const status = page.locator("#status");
  await status
    .filter({ hasText: /Listed in|Stopped after|Cannot open|Cancelled after/ })
    .waitFor({ timeout });
  const text = (await status.textContent()) ?? "";
  // The outcome comes through Comlink, but the row count changes on the
  // next animation frame. Wait until it shows the final count.
  const final = /after ([\d,]+) entries/.exec(text)?.[1];
  const count = page.locator("#row-count");
  if (final !== undefined) {
    await expect(count).toHaveText(final, { timeout });
  } else if (text.includes("Cannot open")) {
    await expect(count).toHaveText("0", { timeout });
  }
  const rows = Number((await count.textContent())?.replace(/,/g, ""));
  const outcome: Outcome = text.includes("Listed in")
    ? "complete"
    : text.includes("Cancelled")
      ? "cancelled"
      : "failed";
  return { outcome, status: text, rows };
}

/**
 * Puts the listing in archive order, the third step of the header cycle from
 * the default sort. A test whose subject is not the order uses it for a fixed
 * row order. The header button keeps the focus.
 */
export async function useArchiveOrder(page: Page, pointer = false): Promise<void> {
  const size = page.locator("#list-viewport [role=columnheader][data-column=size]");
  const button = size.getByRole("button");
  // An empty listing has no header.
  if (!(await button.isVisible())) return;
  await expect(size).toHaveAttribute("aria-sort", "descending");
  // By default the keys, so a later focus of the grid is a keyboard focus.
  const activate = async () => {
    if (pointer) await button.click();
    else await page.keyboard.press("Enter");
  };
  if (!pointer) await button.focus();
  await activate();
  await expect(size).toHaveAttribute("aria-sort", "ascending");
  await activate();
  await expect(size).not.toHaveAttribute("aria-sort");
  // The header shows the request at once. The entry records the sort when the
  // listing shows it, so a click after this finds the rows in their places.
  await expect
    .poll(() => page.evaluate(() => (history.state as { sort: unknown } | null)?.sort))
    .toEqual({ column: 0, descending: false });
}

/**
 * Expands every tree row, selects each folder in the tree, and reads the
 * entries that the table lists for it. With `maxFolders`, it reads only
 * that many folders. Also returns the label of the row that was selected
 * first (the landing folder). A tall viewport makes this take fewer steps.
 */
export async function collectTree(
  page: Page,
  maxFolders = Number.POSITIVE_INFINITY,
): Promise<{ landing: string; folders: TreeListing }> {
  const size = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 4000 });
  try {
    return await page.evaluate(async (limit) => {
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const until = async (done: () => boolean, what: string) => {
        for (let wait = 0; wait < 600; wait++) {
          if (done()) {
            return;
          }
          await frame();
        }
        throw new Error(`timeout: ${what}`);
      };
      // ROW_HEIGHT in src/grid/row-pool.ts.
      const rowHeight = 24;
      const tree = document.getElementById("tree-viewport")!;
      const table = document.getElementById("list-viewport")!;
      const shown = (root: HTMLElement) =>
        [...root.querySelectorAll<HTMLElement>("[data-row]")].filter((row) => !row.hidden);
      // Scrolls so that row `index` shows and returns its element.
      const rowAt = async (root: HTMLElement, index: number) => {
        root.scrollTop = Math.max(0, index * rowHeight - rowHeight);
        let found: HTMLElement | undefined;
        await until(() => {
          found = shown(root).find((row) => Number(row.dataset.row) === index);
          return found !== undefined && found.dataset.kind !== "pending";
        }, `row ${index}`);
        return found!;
      };
      // Reads all rows of a pool, by index.
      const readAll = async <T>(
        root: HTMLElement,
        count: number,
        read: (row: HTMLElement) => T,
      ) => {
        const rows: T[] = [];
        const step = Math.max(rowHeight, Math.floor(root.clientHeight / rowHeight) * rowHeight);
        for (let top = 0; top < Math.max(1, count) * rowHeight; top += step) {
          root.scrollTop = top;
          const first = Math.floor(root.scrollTop / rowHeight);
          const needed = Math.min(count - first, Math.ceil(root.clientHeight / rowHeight));
          await until(() => {
            const rendered = new Map(shown(root).map((row) => [Number(row.dataset.row), row]));
            return Array.from({ length: needed }, (_, i) => rendered.get(first + i)).every(
              (row) =>
                row !== undefined && row.dataset.kind !== "pending" && row.textContent !== "",
            );
          }, `rows from ${first}`);
          for (const row of shown(root)) {
            rows[Number(row.dataset.row)] = read(row);
          }
        }
        return rows.slice(0, count);
      };
      const treeRows = () => Number(tree.dataset.rows);
      // The title, because a long compact chain can be cut in the row.
      const label = (row: HTMLElement) => {
        const part = row.querySelector<HTMLElement>('[data-part="label"]');
        return part?.title || (part?.textContent ?? "");
      };
      const readTree = () =>
        readAll(tree, treeRows(), (row) => ({
          folder: row.dataset.folder!,
          level: Number(row.getAttribute("aria-level")) - 1,
          name: label(row),
          expandable: row.getAttribute("aria-expanded") === "false",
          selected: row.getAttribute("aria-selected") === "true",
        }));

      let rows = await readTree();
      const landing = rows.find((row) => row.selected)?.name ?? "";
      // Expand every row. Go from the last row up, so the indexes above
      // the expanded row do not move.
      for (let pass = 0; pass < 10_000; pass++) {
        const closed = rows.flatMap((row, index) => (row.expandable ? [index] : [])).reverse();
        if (closed.length === 0) {
          break;
        }
        for (const index of closed) {
          const element = await rowAt(tree, index);
          element.querySelector<HTMLElement>('[data-part="toggle"]')!.click();
          await until(
            () =>
              shown(tree)
                .find((row) => Number(row.dataset.row) === index)
                ?.getAttribute("aria-expanded") === "true",
            `expand row ${index}`,
          );
        }
        rows = await readTree();
      }

      const paths: string[] = [];
      const folders: Record<string, string[]> = {};
      for (const [index, row] of rows.entries()) {
        const path =
          row.level === 0 ? "" : row.level === 1 ? row.name : `${paths[row.level - 1]}/${row.name}`;
        paths[row.level] = path;
        if (index >= limit) {
          continue;
        }
        const element = await rowAt(tree, index);
        element.querySelector<HTMLElement>('[data-part="label"]')!.click();
        await until(() => table.dataset.listingFolder === row.folder, `list ${path}`);
        const count = Number(table.getAttribute("aria-rowcount")) - 1;
        const items = await readAll(table, count, (item) => ({
          kind: item.dataset.kind,
          // The largest files below a short listing are not
          // rows of the folder.
          block: item.dataset.block === "true",
          name: item.querySelector<HTMLElement>('[data-part="label"]')?.title ?? "",
        }));
        const entries = items
          .filter((item) => item.kind === "entry" && !item.block)
          .map((item) => item.name);
        if (entries.length > 0) {
          folders[path] = entries.sort();
        }
      }
      return { landing, folders };
    }, maxFolders);
  } finally {
    if (size !== null) {
      await page.setViewportSize(size);
    }
  }
}
