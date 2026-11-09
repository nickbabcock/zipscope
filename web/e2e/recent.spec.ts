// The recent archives on the front door (Chromium). The origin private file
// system gives file handles with the read permission, so the reopen shows no
// prompt. A stub open picker gives these handles and counts its calls.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { formatSize } from "../src/format.ts";
import { front } from "../src/front/strings.ts";
import { waitForOutcome } from "./listing";
import { storedZip } from "./stored-zip";

const FIRST = storedZip([["a.txt", 10]]);
const SECOND = storedZip([
  ["b.txt", 20],
  ["c.txt", 30],
]);
/** `first.zip` after a new build: the same name, another size. */
const REBUILT = storedZip([
  ["a.txt", 10],
  ["d.txt", 40],
]);

/** Stubs the open picker: it gives the handle of the file in the origin
 *  private file system that `__next` names. */
async function stubOpenPicker(page: Page): Promise<void> {
  await page.context().addInitScript(() => {
    const state = window as unknown as { __opened: number; __next: string };
    state.__opened = 0;
    Object.assign(window, {
      showOpenFilePicker: async () => {
        state.__opened += 1;
        const root = await navigator.storage.getDirectory();
        return [await root.getFileHandle(state.__next)];
      },
    });
  });
}

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

/** Opens `name` with the stub picker and waits for its parse. */
async function pickAndOpen(page: Page, name: string): Promise<void> {
  await page.evaluate((file) => ((window as unknown as { __next: string }).__next = file), name);
  await page.locator("#front-open").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
}

/** Opens the front door in a new tab of the same browser. */
async function newTab(page: Page): Promise<Page> {
  const tab = await page.context().newPage();
  await tab.setViewportSize({ width: 1440, height: 900 });
  await tab.goto("/");
  return tab;
}

const pickerCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __opened: number }).__opened);

test("the front door lists recent archives, reopens one and clears them", async ({
  page: first,
}) => {
  let page = first;
  await stubOpenPicker(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  // A first visit with no kept archive has no list.
  await expect(page.locator("#front-open")).toBeVisible();
  await expect(page.locator("#recent-list")).toHaveCount(0);
  await privateFile(page, "first.zip", FIRST);
  await privateFile(page, "second.zip", SECOND);
  await pickAndOpen(page, "first.zip");
  page = await newTab(page);
  await pickAndOpen(page, "second.zip");

  // The list is for all tabs: a new tab shows it, the newest first.
  page = await newTab(page);
  const rows = page.locator("#recent-list button");
  await expect(rows).toHaveText([
    `second.zip${formatSize(SECOND.length)}`,
    `first.zip${formatSize(FIRST.length)}`,
  ]);
  await expect(page.locator("#recent-note")).toContainText(front.recentNote);
  // The list is directly below the actions, in the first view.
  await expect(page.locator("#recent-heading")).toHaveText(front.recentHeading);
  await expect(page.locator("#recent-list")).toBeInViewport();
  const actions = (await page.locator("#front-open").boundingBox())!;
  const list = (await page.locator("#recent").boundingBox())!;
  expect(list.x).toBe(actions.x);
  expect(list.y).toBeGreaterThan(actions.y + actions.height);

  // A click opens the archive with no picker, and it goes to the top. The
  // file changed its size since the open, so its old row goes.
  await privateFile(page, "first.zip", REBUILT);
  await rows.filter({ hasText: "first.zip" }).click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#archive-name")).toContainText("first.zip");
  expect(await pickerCalls(page)).toBe(0);
  page = await newTab(page);
  await expect(page.locator("#recent-list button")).toHaveText([
    `first.zip${formatSize(REBUILT.length)}`,
    `second.zip${formatSize(SECOND.length)}`,
  ]);

  // A file that is gone: its row goes, and one line says so.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("second.zip");
  });
  await page.locator("#recent-list button", { hasText: "second.zip" }).click();
  await expect(page.locator("#recent-lost")).toHaveText(front.recentLost("second.zip"));
  await expect(page.locator("#recent-list button")).toHaveCount(1);
  await expect(page.locator("#recent-list button")).toBeFocused();
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "first");
  // The store does not keep it: a new tab has one row.
  page = await newTab(page);
  await expect(page.locator("#recent-list button")).toHaveText([
    `first.zip${formatSize(REBUILT.length)}`,
  ]);

  // Clear removes all of them, also for the next visit.
  await page.locator("#recent-clear").click();
  await expect(page.locator("#recent-list")).toHaveCount(0);
  await expect(page.locator("#front-open")).toBeFocused();
  await page.reload();
  await expect(page.locator("#front-open")).toBeVisible();
  await expect(page.locator("#recent-list")).toHaveCount(0);
});
