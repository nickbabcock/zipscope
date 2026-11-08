// The swap name of Chromium. A folder job lets a plain name overlap the swap files of
// earlier rows, and this rule uses the swap name (see `isPlainName` in
// `src/read/extract.ts` and `FLIGHT_ROWS` there). When a new
// Chromium has another swap name, these tests fail. Then do not change the tests only:
// change the rule, or put `createWritable` in the name turn. The tests see a new Chromium
// only when the Playwright pin moves, so a user's Chrome can have a new swap name first.
//
// One test uses the origin private file system, in the browser of the other tests.
// One test uses a real folder, in the full Chromium, because the headless shell refuses
// the stored grant. These tests check the name only. They do not check that a file
// system joins names: `src/read/extract-flight-wasm.test.ts` has this, with a fake folder.
import { mkdirSync, readdirSync } from "node:fs";
import { chromium, expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { dropFolder, grantFolder } from "./real-folder";

interface Scope {
  __folder: FileSystemDirectoryHandle;
  __open: FileSystemWritableFileStream[];
}

/** Opens one more writable of the file `name`. The writable stays open. */
const openWritable = (page: Page, name: string) =>
  page.evaluate(async (file) => {
    const scope = window as unknown as Scope;
    const handle = await scope.__folder.getFileHandle(file, { create: true });
    (scope.__open ??= []).push(await handle.createWritable());
  }, name);

/** Makes the file `name`, with no writable. */
const makeFile = (page: Page, name: string) =>
  page.evaluate(async (file) => {
    await (window as unknown as Scope).__folder.getFileHandle(file, { create: true });
  }, name);

/** Ends the open writables, with no change to their files. */
const abortAll = (page: Page) =>
  page.evaluate(async () => {
    const scope = window as unknown as Scope;
    for (const writable of scope.__open.splice(0)) await writable.abort();
  });

/** The names in the folder, sorted, as the browser lists them. */
const listed = (page: Page) =>
  page.evaluate(async () => {
    const names: string[] = [];
    for await (const name of (
      (window as unknown as Scope).__folder as unknown as { keys(): AsyncIterable<string> }
    ).keys()) {
      names.push(name);
    }
    return names.sort();
  });

/** The steps of the test. `seen` gives the names in the folder at each step. */
async function expectSwapNames(page: Page, seen: () => Promise<string[]>) {
  await openWritable(page, "a.txt");
  expect(await seen()).toEqual(["a.txt", "a.txt.crswap"]);
  // The first swap name is taken by the other writable of this file.
  await openWritable(page, "a.txt");
  expect(await seen()).toEqual(["a.txt", "a.txt.1.crswap", "a.txt.crswap"]);
  await abortAll(page);
  expect(await seen()).toEqual(["a.txt"]);
  // The first swap name is taken by a file, as with a row that has this name.
  await makeFile(page, "b.txt.crswap");
  await openWritable(page, "b.txt");
  expect(await seen()).toEqual(["a.txt", "b.txt", "b.txt.1.crswap", "b.txt.crswap"]);
  await abortAll(page);
  expect(await seen()).toEqual(["a.txt", "b.txt", "b.txt.crswap"]);
}

test("a writable in the private file system has the swap name that the rule expects", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    (window as unknown as Scope).__folder = await root.getDirectoryHandle("swap-name", {
      create: true,
    });
  });
  await expectSwapNames(page, () => listed(page));
});

test("a writable in a real folder has the swap name that the rule expects", async ({ baseURL }) => {
  const profile = test.info().outputPath("profile");
  const folder = test.info().outputPath("folder");
  mkdirSync(folder, { recursive: true });
  grantFolder(profile, folder, new URL(baseURL!).origin);
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(baseURL!);
    await dropFolder(context, page, folder);
    await page.evaluate(() => {
      const scope = window as unknown as Scope & { __realFolder: FileSystemDirectoryHandle };
      scope.__folder = scope.__realFolder;
    });
    await expectSwapNames(page, async () => {
      const names = await listed(page);
      // The browser and the disk must give the same names.
      expect(readdirSync(folder).sort()).toEqual(names);
      return names;
    });
  } finally {
    await context.close();
  }
});
