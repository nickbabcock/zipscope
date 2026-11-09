// The offline line of the front door: "Load this page, disconnect, then
// open a file. Zipscope still works." The front door preloads the parse worker, the
// core wasm, the read worker with its wasm, and the sample generator in
// idle time. After that, the page can lose the network and still open a
// file, preview an entry, open the sample and open a second file.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { front } from "../src/front/strings.ts";
import { contentZip } from "./content-zip";
import { openArchive, waitForOutcome } from "./listing";

test("after the preload, a file opens and previews without the network", async ({
  page,
  context,
}) => {
  const first = test.info().outputPath("first.zip");
  const second = test.info().outputPath("second.zip");
  writeFileSync(first, contentZip([{ name: "docs/readme.txt", data: Buffer.from("offline\n") }]));
  writeFileSync(second, contentZip([{ name: "other.txt", data: Buffer.from("again\n") }]));

  await page.goto("/");
  await expect(page.locator("#front-test")).toHaveText(front.test);
  await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "true");
  await context.setOffline(true);
  await expect(page.locator("#status")).toHaveText(front.offline);

  await openArchive(page, first);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  await page
    .locator('#list-viewport [data-part="label"]', { hasText: "readme.txt" })
    .first()
    .dblclick();
  await expect(page.locator("#preview-text")).toHaveText("offline\n");

  // A second file needs new workers. The HTTP cache has their modules.
  await openArchive(page, second);
  await expect(page.locator("#archive-name")).toHaveText("second.zip");
  expect((await waitForOutcome(page)).outcome).toBe("complete");
});

test("after the preload, the sample opens without the network", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "true");
  await context.setOffline(true);
  await page.locator("#sample-button").click();
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  await expect(page.locator("#demo-label")).toHaveText(front.demo);
});

test("the offline line shows only after the preload", async ({ page }) => {
  const gate = Promise.withResolvers<void>();
  await page.route("**/assets/zipscope_core_bg-*.wasm", async (route) => {
    await gate.promise;
    await route.continue();
  });
  await page.goto("/");
  const door = page.locator("#front-door");
  await expect(page.locator("#door-bands")).toBeVisible();
  await expect(door).toHaveAttribute("data-preloaded", "pending");
  await expect(page.locator("#front-test")).toBeHidden();
  gate.resolve();
  await expect(door).toHaveAttribute("data-preloaded", "true");
  await expect(page.locator("#front-test")).toBeVisible();
});

test("the map margin says only that the device is offline until the preload ends", async ({
  page,
  context,
}) => {
  const gate = Promise.withResolvers<void>();
  await page.route("**/assets/zipscope_core_bg-*.wasm", async (route) => {
    await gate.promise;
    await route.continue();
  });
  await page.goto("/");
  await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "pending");
  await context.setOffline(true);
  await expect(page.locator("#status")).toHaveText(front.offlineOnly);
  // The first test of this file checks the full sentence after the preload.
  gate.resolve();
});

test("a disconnect during the preload keeps the offline line hidden until a retry", async ({
  page,
  context,
}) => {
  const gate = Promise.withResolvers<void>();
  let held = true;
  await page.route("**/assets/zipscope_core_bg-*.wasm", async (route) => {
    if (held) {
      await gate.promise;
      await route.abort("internetdisconnected");
    } else {
      await route.continue();
    }
  });
  await page.goto("/");
  const door = page.locator("#front-door");
  await expect(door).toHaveAttribute("data-preloaded", "pending");
  await context.setOffline(true);
  gate.resolve();
  await expect(door).toHaveAttribute("data-preloaded", "false");
  await expect(page.locator("#front-test")).toBeHidden();
  // When the network comes back, the preload runs again.
  held = false;
  await context.setOffline(false);
  await expect(door).toHaveAttribute("data-preloaded", "true");
  await expect(page.locator("#front-test")).toBeVisible();
  // Then the line is true.
  await context.setOffline(true);
  const path = test.info().outputPath("retry.zip");
  writeFileSync(path, contentZip([{ name: "a.txt", data: Buffer.from("a\n") }]));
  await openArchive(page, path);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
});

test("a failed preload keeps the offline line hidden and a file still opens", async ({ page }) => {
  // The read worker module cannot load.
  let fail = true;
  await page.route("**/assets/zipscope_read_bg-*.wasm", async (route) => {
    if (fail) await route.abort("failed");
    else await route.continue();
  });
  await page.goto("/");
  const door = page.locator("#front-door");
  await expect(door).toHaveAttribute("data-preloaded", "false");
  await expect(page.locator("#front-test")).toBeHidden();
  fail = false;
  // The archive does not get the worker that did not load.
  const path = test.info().outputPath("after-failure.zip");
  writeFileSync(path, contentZip([{ name: "b.txt", data: Buffer.from("bee\n") }]));
  await openArchive(page, path);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await page.locator('#list-viewport [data-part="label"]', { hasText: "b.txt" }).first().dblclick();
  await expect(page.locator("#preview-text")).toHaveText("bee\n");
});

const assets = path.resolve(import.meta.dirname, "../dist/assets");

/** Returns the file name of the worker module that loads this wasm. */
function workerAsset(wasm: "zipscope_core_bg-" | "zipscope_read_bg-"): string {
  const name = readdirSync(assets).find(
    (file) =>
      file.startsWith("worker-") && readFileSync(path.join(assets, file), "utf8").includes(wasm),
  );
  if (name === undefined) throw new Error(`no worker loads ${wasm}`);
  return name;
}

/** Counts the `error` events of the workers of the page. */
async function countWorkerErrors(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { errors: 0 };
    Object.assign(window, { workerErrors: state });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("error", () => state.errors++);
      }
    };
  });
}

const workerErrors = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { workerErrors: { errors: number } }).workerErrors.errors,
  );

test("a parse worker that did not load is not given to an archive while the read preload waits", async ({
  page,
}) => {
  await countWorkerErrors(page);
  // The first request for the parse worker module fails. The read wasm
  // waits, so the preload does not complete.
  let failParse = true;
  await page.route(`**/assets/${workerAsset("zipscope_core_bg-")}`, async (route) => {
    if (failParse) {
      failParse = false;
      await route.abort("internetdisconnected");
    } else {
      await route.continue();
    }
  });
  const gate = Promise.withResolvers<void>();
  await page.route("**/assets/zipscope_read_bg-*.wasm", async (route) => {
    await gate.promise;
    await route.continue();
  });
  await page.goto("/");
  await expect.poll(() => workerErrors(page)).toBe(1);
  await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "pending");
  const file = test.info().outputPath("parse-failed.zip");
  writeFileSync(file, contentZip([{ name: "a.txt", data: Buffer.from("a\n") }]));
  await openArchive(page, file);
  const result = await waitForOutcome(page, 15_000);
  expect(result.outcome, result.status).toBe("complete");
  gate.resolve();
});

test("a read worker that did not load is not given to an archive while the parse preload waits", async ({
  page,
}) => {
  await countWorkerErrors(page);
  let failRead = true;
  await page.route(`**/assets/${workerAsset("zipscope_read_bg-")}`, async (route) => {
    if (failRead) {
      failRead = false;
      await route.abort("internetdisconnected");
    } else {
      await route.continue();
    }
  });
  // The core wasm of the preload waits. The wasm of a later parse worker
  // loads.
  const gate = Promise.withResolvers<void>();
  let held = true;
  await page.route("**/assets/zipscope_core_bg-*.wasm", async (route) => {
    if (held) {
      held = false;
      await gate.promise;
    }
    await route.continue();
  });
  await page.goto("/");
  await expect.poll(() => workerErrors(page)).toBe(1);
  await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "pending");
  const file = test.info().outputPath("read-failed.zip");
  writeFileSync(file, contentZip([{ name: "b.txt", data: Buffer.from("bee\n") }]));
  await openArchive(page, file);
  const result = await waitForOutcome(page, 15_000);
  expect(result.outcome, result.status).toBe("complete");
  await page.locator('#list-viewport [data-part="label"]', { hasText: "b.txt" }).first().dblclick();
  await expect(page.locator("#preview-text")).toHaveText("bee\n");
  gate.resolve();
});

test("a sample generator that did not load during the preload loads again", async ({ page }) => {
  let failSample = true;
  await page.route("**/assets/sample-*.js", async (route) => {
    if (failSample) {
      failSample = false;
      await route.abort("internetdisconnected");
    } else {
      await route.continue();
    }
  });
  await page.goto("/");
  await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "false");
  await page.locator("#sample-button").click();
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  await expect(page.locator("#demo-label")).toHaveText(front.demo);
});
