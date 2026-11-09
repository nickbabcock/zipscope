// The installed app: the manifest and its file handler, the app shell cache
// of the service worker, and the update notice. These tests need the
// service worker, which the other specs block.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { lifecycle } from "../src/lifecycle/strings.ts";
import { contentZip } from "./content-zip";
import { openArchive, waitForOutcome } from "./listing";

test.use({ serviceWorkers: "allow" });

const dist = path.resolve(import.meta.dirname, "../dist");
const assets = path.join(dist, "assets");

const TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

/**
 * Serves the build on a new port (a new origin), with the headers of the
 * `/*` rule of `_headers`. The browser checks `sw.js` for an update in its
 * own process, and Playwright cannot change that request. So this server
 * gives `sw.js` with the version that `next()` sets.
 */
async function deployServer() {
  const rule = readFileSync(path.join(dist, "_headers"), "utf8")
    .split(/\n\s*\n/)
    .find((block) => block.trimStart().startsWith("/*\n"));
  const headers = Object.fromEntries(
    (rule ?? "")
      .split("\n")
      .slice(1)
      .map((line) =>
        line
          .trim()
          .split(/:\s*(.*)/s)
          .slice(0, 2),
      ),
  );
  let version: string | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    let body: Buffer;
    try {
      body = readFileSync(path.join(dist, path.normalize(file)));
    } catch {
      response.writeHead(404, headers).end();
      return;
    }
    if (file === "sw.js" && version !== undefined) {
      body = Buffer.from(
        body.toString("utf8").replace(/(\\"version\\":\\")[0-9a-f]+/, `$1${version}`),
      );
    }
    response.writeHead(200, {
      ...headers,
      "Cache-Control": "no-cache",
      "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  return {
    url: `http://localhost:${(server.address() as AddressInfo).port}`,
    /** The next deploy: `sw.js` gets the version `name`. */
    next(name: string) {
      version = name;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Waits until the service worker of the page is active. Its install put
 *  the whole shell in the cache first. */
async function shellReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}

/** The paths in the shell caches, for each cache. */
function cachedPaths(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(async () => {
    const result: Record<string, string[]> = {};
    for (const name of await caches.keys()) {
      const requests = await (await caches.open(name)).keys();
      result[name] = requests.map((request) => new URL(request.url).pathname);
    }
    return result;
  });
}

function writeZip(name: string, text: string): string {
  const file = test.info().outputPath(name);
  writeFileSync(file, contentZip([{ name: "readme.txt", data: Buffer.from(text) }]));
  return file;
}

test("the manifest is installable and has a .zip file handler with one window for each file", async ({
  page,
}) => {
  await page.goto("/");
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  expect(installabilityErrors).toEqual([]);
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.file_handlers).toEqual([
    {
      action: "/?launch",
      accept: { "application/zip": [".zip"] },
      launch_type: "multiple-clients",
    },
  ]);
  expect(manifest.launch_handler).toEqual({ client_mode: "navigate-new" });
  expect(manifest.icons).toEqual([{ src: "/app-icon.svg", sizes: "any", type: "image/svg+xml" }]);
});

test("a launch of two files opens two windows, each straight in the tool", async ({ baseURL }) => {
  // The headless shell has no app install. The full Chromium build in its
  // new headless mode has it, through the PWA domain of the DevTools
  // protocol. An app install needs a profile on disk.
  const context = await chromium.launchPersistentContext(test.info().outputPath("profile"), {
    channel: "chromium",
    headless: true,
    locale: "en-US",
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${baseURL}/`);
    const cdp = await context.newCDPSession(page);
    const manifestId = `${baseURL}/`;
    await cdp.send("PWA.install", { manifestId });
    const opened = await cdp.send("PWA.launchFilesInApp", {
      manifestId,
      files: [writeZip("first.zip", "one\n"), writeZip("second.zip", "two\n")],
    });
    expect(opened.targetIds).toHaveLength(2);
    await expect.poll(() => context.pages().length).toBe(3);
    const names: string[] = [];
    for (const launched of context.pages().slice(1)) {
      await expect(launched.locator("#archive-name")).toHaveText(/^(first|second)\.zip$/);
      names.push((await launched.locator("#archive-name").textContent()) ?? "");
      // The window opened the action URL of the file handler. The next
      // test shows that its mark hides the front door before the first
      // paint. The mark is gone now, so a reload shows the front door.
      const opened = await launched.evaluate(
        () => performance.getEntriesByType("navigation")[0]?.name ?? "",
      );
      expect(new URL(opened).search).toBe("?launch");
      expect(new URL(launched.url()).search).toBe("");
      expect((await waitForOutcome(launched)).outcome).toBe("complete");
    }
    expect(names.sort()).toEqual(["first.zip", "second.zip"]);
  } finally {
    await context.close();
  }
});

test("the launch mark hides the page before the first paint, and with no launch the front door shows", async ({
  page,
}) => {
  // The state of the door at the end of the parse of the HTML, before the
  // app starts.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const door = document.getElementById("door-page");
      (window as unknown as { firstDoor: string }).firstDoor =
        `${document.documentElement.dataset.door} ${door === null ? "" : getComputedStyle(door).display}`;
    });
  });
  await page.goto("/?launch");
  expect(await page.evaluate(() => (window as unknown as { firstDoor: string }).firstDoor)).toBe(
    "resume none",
  );
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "receiving");
  await expect(page.locator("#receiving-text")).toHaveText(lifecycle.launching);
  // After `LAUNCH_WAIT_MS` (5 s).
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "first", {
    timeout: 10_000,
  });
  expect(new URL(page.url()).search).toBe("");
});

test("offline, the page and every file of the build come from the cache, cross-origin isolated", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await shellReady(page);
  const cached = Object.entries(await cachedPaths(page));
  expect(cached).toHaveLength(1);
  const [name, paths] = cached[0]!;
  expect(name).toMatch(/^zipscope-shell-[0-9a-f]{16}$/);
  // The lazy chunks and all wasm too, so Extract and the zstd copy work
  // offline the first time.
  for (const file of readdirSync(assets)) expect(paths).toContain(`/assets/${file}`);
  for (const file of [
    "/",
    "/app-icon.svg",
    "/door-boot.js",
    "/favicon.svg",
    "/manifest.webmanifest",
  ]) {
    expect(paths).toContain(file);
  }

  await context.setOffline(true);
  const response = await page.reload();
  expect(response?.fromServiceWorker()).toBe(true);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect(page.locator("#cross-origin-isolated")).toHaveText("true");
  // The cached page keeps the headers of `_headers`.
  const headers = await page.evaluate(async () =>
    Object.fromEntries((await fetch("/")).headers.entries()),
  );
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(headers["content-security-policy"]).toContain("script-src 'self' 'wasm-unsafe-eval'");

  await openArchive(page, writeZip("offline.zip", "offline\n"));
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  await page
    .locator('#list-viewport [data-part="label"]', { hasText: "readme.txt" })
    .first()
    .dblclick();
  await expect(page.locator("#preview-text")).toHaveText("offline\n");

  // The action URL of the file handler, with its query, comes from the
  // cache too, so a file launch works offline.
  expect((await page.goto("/?launch"))?.fromServiceWorker()).toBe(true);
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "receiving");
});

test("a new version shows the update notice, and only Reload reloads, only its own tab", async ({
  page,
  context,
}) => {
  const deploy = await deployServer();
  try {
    await page.goto(`${deploy.url}/`);
    await shellReady(page);
    // The first page came from the network. A reload is under the worker.
    await page.reload();
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    const other = await context.newPage();
    await other.goto(`${deploy.url}/`);
    await openArchive(other, writeZip("kept.zip", "kept\n"));
    expect((await waitForOutcome(other)).outcome).toBe("complete");
    const [oldCache] = Object.keys(await cachedPaths(page));

    const mark = () => {
      (window as unknown as { stays?: boolean }).stays = true;
    };
    await page.evaluate(mark);
    await other.evaluate(mark);
    deploy.next("0123456789abcdef");
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())?.update();
    });
    await expect(page.locator("#update-notice")).toContainText(lifecycle.updateReady);
    await expect(other.locator("#update-notice")).toContainText(lifecycle.updateReady);
    const stays = (tab: Page) =>
      tab.evaluate(() => (window as unknown as { stays?: boolean }).stays === true);
    expect(await stays(page)).toBe(true);
    // The new version waits for the user. Until Reload, both tabs stay
    // under the old version.
    const waits = (tab: Page) =>
      tab.evaluate(
        async () =>
          (await navigator.serviceWorker.getRegistration())?.waiting instanceof ServiceWorker,
      );
    expect(await waits(page)).toBe(true);
    expect(await waits(other)).toBe(true);

    // On a narrow screen the sentence of the notice gets only the free
    // space: the facts of the archive keep their full text, and Reload
    // stays. `scrollWidth` is rounded, so the check compares the width of
    // the text with the width of the field, in fractions of a pixel.
    for (const width of [320, 360]) {
      await other.setViewportSize({ width, height: 640 });
      await expect(other.locator("#update-reload")).toBeVisible();
      for (const id of ["#entries-listed", "#status"]) {
        const [text, field] = await other.locator(id).evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return [range.getBoundingClientRect().width, element.getBoundingClientRect().width];
        });
        expect(text, `${id} at ${width} px`).toBeLessThanOrEqual(field);
      }
    }

    const loaded = page.waitForEvent("load");
    await page.locator("#update-reload").click();
    await loaded;
    expect(await stays(page)).toBe(false);
    await expect(page.locator("#cross-origin-isolated")).toHaveText("true");
    await expect(page.locator("#update-notice")).toHaveCount(0);
    // The other tab keeps its archive. The cache of its version stays, so
    // it can still load the files of its build.
    expect(await stays(other)).toBe(true);
    await expect(other.locator("#archive-name")).toHaveText("kept.zip");
    await expect(other.locator("#update-notice")).toBeVisible();
    expect(Object.keys(await cachedPaths(page)).sort()).toEqual(
      [oldCache, "zipscope-shell-0123456789abcdef"].sort(),
    );
  } finally {
    await deploy.close();
  }
});
