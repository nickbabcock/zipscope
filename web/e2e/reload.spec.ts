// Reload on Chromium: the front door offers to reopen the file
// and shows the remembered location. A kept file handle reopens the file
// with no picker (the origin private file system gives handles with the
// read permission, so the test sees no prompt). A matching archive gets
// its location back; a different file starts at its root. Without the
// File System Access picker (as in Firefox and Safari), the reopen action
// opens the file input.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { front } from "../src/front/strings.ts";
import { waitForOutcome, LISTING_ROWS } from "./listing";
import { storedZip } from "./stored-zip";

const ENTRIES: [string, number][] = [
  ["app/src/main/a.rs", 10],
  ["app/README.md", 1],
  ["docs/guide.md", 2],
  ["top.txt", 3],
];

const tableRows = (page: Page) => page.locator(LISTING_ROWS);
const labels = (page: Page) => tableRows(page).locator('[data-part="label"]').allTextContents();
const crumbs = (page: Page) => page.locator("#location li").allTextContents();
/** The state of the history entry, which a reload keeps. */
const entry = (page: Page) =>
  page.evaluate(() => history.state as { sort: unknown; query: string });
const folderRow = (page: Page, label: string) =>
  tableRows(page).filter({ has: page.locator('[data-part="label"]', { hasText: label }) });

/** Puts `bytes` in the origin private file system as `name`. */
async function privateFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  await page.evaluate(
    async ({ file, data }) => {
      const root = await navigator.storage.getDirectory();
      const writable = await (await root.getFileHandle(file, { create: true })).createWritable();
      await writable.write(new Uint8Array(data));
      await writable.close();
    },
    { file: name, data: [...bytes] },
  );
}

/** Stubs the open picker: it gives the handle of `nav.zip` in the origin
 *  private file system, and counts its calls. */
async function stubOpenPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as unknown as { __opened: number };
    state.__opened = 0;
    Object.assign(window, {
      showOpenFilePicker: async () => {
        state.__opened += 1;
        const root = await navigator.storage.getDirectory();
        return [await root.getFileHandle("nav.zip")];
      },
    });
  });
}

const pickerCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __opened: number }).__opened);

/** Opens `nav.zip` with the stubbed picker and goes to `app/src/main`
 *  (a compact chain). */
async function openAndNavigate(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");
  await privateFile(page, "nav.zip", storedZip(ENTRIES));
  await page.locator("#front-open").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await folderRow(page, "app/").click();
  await folderRow(page, "src/").click();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app", "/src/main"]);
}

test("a kept handle reopens the file with no picker and restores the folder", async ({ page }) => {
  await stubOpenPicker(page);
  await openAndNavigate(page);
  expect(await pickerCalls(page)).toBe(1);
  await page.reload();
  const door = page.locator("#front-door");
  await expect(door).toHaveAttribute("data-state", "reopen");
  await expect(page.locator("#reopen-text")).toHaveText(front.reopen);
  await expect(page.locator("#reopen-button")).toHaveText("nav.zip");
  await expect(page.locator("#reopen-path")).toHaveText(front.reopenPath("app/src/main"));
  await page.locator("#reopen-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app", "/src/main"]);
  await expect.poll(() => labels(page)).toEqual(["a.rs"]);
  // The handle gave the file: the picker did not open again.
  expect(await pickerCalls(page)).toBe(0);
});

test("reopen keeps archive order that the user chose, and the default for no choice", async ({
  page,
}) => {
  await stubOpenPicker(page);
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");
  await privateFile(page, "nav.zip", storedZip(ENTRIES));
  await page.locator("#front-open").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  const size = page.locator("#list-viewport [role=columnheader][data-column=size]");
  await expect(size).toHaveAttribute("aria-sort", "descending");
  // With no choice, the entry keeps no sort: the reopen has the default sort.
  expect((await entry(page)).sort).toBeNull();
  await page.reload();
  await page.locator("#reopen-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(size).toHaveAttribute("aria-sort", "descending");
  // Archive order is a value, so it does not turn into the default.
  await size.getByRole("button").click();
  await size.getByRole("button").click();
  await expect(size).not.toHaveAttribute("aria-sort");
  await expect.poll(async () => (await entry(page)).sort).toEqual({ column: 0, descending: false });
  await page.reload();
  await page.locator("#reopen-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(size).not.toHaveAttribute("aria-sort");
});

test("reopen restores the sort", async ({ page }) => {
  await stubOpenPicker(page);
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");
  await privateFile(page, "nav.zip", storedZip(ENTRIES));
  await page.locator("#front-open").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  const name = page.locator("#list-viewport [role=columnheader][data-column=name]");
  await name.getByRole("button").click();
  await name.getByRole("button").click();
  await expect(name).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => labels(page)).toEqual(["docs/", "app/", "top.txt"]);
  // The sort goes to the history entry after REPLACE_INTERVAL.
  await expect.poll(async () => (await entry(page)).sort).toEqual({ column: 1, descending: true });
  await page.reload();
  await page.locator("#reopen-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(name).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => labels(page)).toEqual(["docs/", "app/", "top.txt"]);
});

test("reopen lists a kept name sort with numbers by value", async ({ page }) => {
  await stubOpenPicker(page);
  await page.goto("/");
  await privateFile(
    page,
    "nav.zip",
    storedZip([
      ["file10", 1],
      ["file2", 1],
      ["file01", 1],
      ["File3", 1],
      ["file1", 1],
    ]),
  );
  await page.locator("#front-open").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  const name = page.locator("#list-viewport [role=columnheader][data-column=name]");
  await name.getByRole("button").click();
  const order = ["file01", "file1", "file2", "File3", "file10"];
  await expect.poll(() => labels(page)).toEqual(order);
  // The sort goes to the history entry after REPLACE_INTERVAL.
  await expect.poll(async () => (await entry(page)).sort).toEqual({ column: 1, descending: false });
  await page.reload();
  await page.locator("#reopen-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(name).toHaveAttribute("aria-sort", "ascending");
  await expect.poll(() => labels(page)).toEqual(order);
});

test("a different file with the same name starts at its root", async ({ page }) => {
  await stubOpenPicker(page);
  await openAndNavigate(page);
  await page.reload();
  // The same name, but other entries and another size.
  await privateFile(
    page,
    "nav.zip",
    storedZip([
      ["app/src/other.rs", 10],
      ["new.txt", 4],
    ]),
  );
  await page.locator("#reopen-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect.poll(() => labels(page)).toEqual(["app/src/", "new.txt"]);
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip"]);
});

test("without the picker, reopen opens the file input and restores a match", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
  });
  await page.setViewportSize({ width: 1440, height: 800 });
  const path = test.info().outputPath("nav.zip");
  writeFileSync(path, storedZip(ENTRIES));
  await page.goto("/");
  const first = page.waitForEvent("filechooser");
  await page.locator("#front-open").click();
  await (await first).setFiles(path);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await folderRow(page, "docs/").click();
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/docs"]);
  // A search is part of the location too.
  await page.locator("#search-input").fill("guide");
  await expect(page.locator("#location")).toBeVisible();
  await expect.poll(async () => (await entry(page)).query).toBe("guide");
  await page.reload();
  await expect(page.locator("#reopen-path")).toHaveText(front.reopenPath("docs"));
  await expect(page.locator("#reopen-search")).toHaveText(front.reopenSearch("guide"));
  const again = page.waitForEvent("filechooser");
  await page.locator("#reopen-button").click();
  await (await again).setFiles(path);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#search-input")).toHaveValue("guide");
  await expect.poll(() => labels(page)).toEqual(["docs/guide.md"]);
});

test("a reload with a query has the best match, and a kept choice wins", async ({ page }) => {
  await stubOpenPicker(page);
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");
  await privateFile(
    page,
    "nav.zip",
    storedZip([
      ["big/guide.md.bak", 900],
      ["docs/guide.md", 1],
    ]),
  );
  await page.locator("#front-open").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  const size = page.locator("#list-viewport [role=columnheader][data-column=size]");
  const best = ["docs/guide.md", "big/guide.md.bak"];
  await page.locator("#search-input").fill("guide.md");
  await expect.poll(() => labels(page)).toEqual(best);
  await expect(page.locator("#sort-status")).toHaveText("Best match");
  // The query goes to the history entry after REPLACE_INTERVAL.
  await expect
    .poll(() => page.evaluate(() => (history.state as { query: string }).query))
    .toBe("guide.md");
  await page.reload();
  await page.locator("#reopen-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#search-input")).toHaveValue("guide.md");
  await expect.poll(() => labels(page)).toEqual(best);
  await expect(page.locator("#sort-status")).toHaveText("Best match");
  await expect(size).not.toHaveAttribute("aria-sort");
  // A column that the user chose stays after a reload, also archive order.
  await size.getByRole("button").click();
  await expect(size).toHaveAttribute("aria-sort", "descending");
  await size.getByRole("button").click();
  await size.getByRole("button").click();
  await expect(size).not.toHaveAttribute("aria-sort");
  await expect(page.locator("#sort-status")).toHaveText("");
  await expect.poll(() => labels(page)).toEqual(["big/guide.md.bak", "docs/guide.md"]);
  // The sort goes to the history entry after REPLACE_INTERVAL.
  await expect
    .poll(() => page.evaluate(() => (history.state as { sort: unknown }).sort))
    .toEqual({ column: 0, descending: false });
  await page.reload();
  await page.locator("#reopen-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#search-input")).toHaveValue("guide.md");
  await expect(size).not.toHaveAttribute("aria-sort");
  await expect(page.locator("#sort-status")).toHaveText("");
  await expect.poll(() => labels(page)).toEqual(["big/guide.md.bak", "docs/guide.md"]);
});

test("a refused permission says so, and the next click opens the picker", async ({ page }) => {
  await stubOpenPicker(page);
  await page.addInitScript(() => {
    Object.assign(FileSystemFileHandle.prototype, {
      queryPermission: async () => "prompt",
      requestPermission: async () => "denied",
    });
  });
  await openAndNavigate(page);
  await page.reload();
  await page.locator("#reopen-button").click();
  await expect(page.locator("#reopen-refused")).toHaveText(front.reopenRefused);
  expect(await pickerCalls(page)).toBe(0);
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "reopen");
  // The next click opens the picker, and the match restores the folder.
  await page.locator("#reopen-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  expect(await pickerCalls(page)).toBe(1);
  await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app", "/src/main"]);
});

test("a kept file that is gone says so without a permission text", async ({ page }) => {
  await stubOpenPicker(page);
  await openAndNavigate(page);
  await page.reload();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("nav.zip");
  });
  await page.locator("#reopen-button").click();
  const refused = page.locator("#reopen-refused");
  await expect(refused).toHaveText(front.reopenRefused);
  // The user gave the permission: the file is gone.
  await expect(refused).not.toContainText("permission");
  expect(await pickerCalls(page)).toBe(0);
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "reopen");
});

test("the entry records an open preview at once, for a reload just after it", async ({ page }) => {
  await stubOpenPicker(page);
  await openAndNavigate(page);
  await folderRow(page, "a.rs").click();
  const toggle = () =>
    page.evaluate(() => {
      document
        .getElementById("list-viewport")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
      return (history.state as { preview: boolean }).preview;
    });
  // Each toggle writes the entry with no wait, also within the interval of the
  // writes. A write in `pagehide` does not reach the entry of a reload.
  expect(await toggle()).toBe(true);
  expect(await toggle()).toBe(false);
  expect(await toggle()).toBe(true);
});

// The preview opens on request (the Quick Look model),
// and a reload restores it only when it was open.
for (const opened of [true, false]) {
  test(`reopen restores the preview only when it was open (${opened ? "open" : "closed"})`, async ({
    page,
  }) => {
    await stubOpenPicker(page);
    await openAndNavigate(page);
    // A click on a file only selects it; Space opens the preview.
    await folderRow(page, "a.rs").click();
    await expect(page.locator("#preview-pane")).toHaveCount(0);
    if (opened) {
      await page.keyboard.press(" ");
      await expect(page.locator("#preview-pane")).toBeVisible();
    }
    await page.reload();
    await page.locator("#reopen-button").click();
    expect((await waitForOutcome(page)).outcome).toBe("complete");
    await expect.poll(() => labels(page)).toEqual(["a.rs"]);
    if (opened) {
      await expect(page.locator("#preview-pane")).toContainText("a.rs");
    } else {
      // Wait for the restore of the folder, then check the pane.
      await expect.poll(() => crumbs(page)).toEqual(["nav.zip", "/app", "/src/main"]);
      await expect(page.locator("#preview-pane")).toHaveCount(0);
    }
  });
}
