// The served build has the headers from `public/_headers`, and the page is
// cross-origin isolated. A broken isolation setup fails here.
import { readdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const assets = readdirSync(path.resolve(import.meta.dirname, "../dist/assets"));
const asset = (pattern: RegExp) => {
  const name = assets.find((file) => pattern.test(file));
  if (name === undefined) {
    throw new Error(`no asset matches ${pattern}`);
  }
  return `/assets/${name}`;
};

const isolation = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

test.describe("headers", () => {
  // The server sends the same headers to each browser.
  test.skip(({ browserName }) => browserName !== "chromium");

  const paths = [
    { path: "/", cache: "no-cache" },
    { path: "/sw.js", cache: "no-cache" },
    { path: "/door-boot.js", cache: "no-cache" },
    { path: "/manifest.webmanifest", cache: "no-cache" },
    { path: asset(/^index-.*\.js$/), cache: "public, max-age=31536000, immutable" },
    { path: asset(/^worker-.*\.js$/), cache: "public, max-age=31536000, immutable" },
    { path: asset(/\.wasm$/), cache: "public, max-age=31536000, immutable" },
    { path: asset(/\.css$/), cache: "public, max-age=31536000, immutable" },
  ];
  for (const { path: url, cache } of paths) {
    test(`${url} has the _headers rules`, async ({ request }) => {
      const response = await request.get(url);
      expect(response.status()).toBe(200);
      const headers = response.headers();
      for (const [name, value] of Object.entries(isolation)) {
        expect(headers[name], name).toBe(value);
      }
      const csp = headers["content-security-policy"] ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
      expect(csp).toContain("worker-src 'self' blob:");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("unsafe-inline");
      expect(headers["cache-control"]).toBe(cache);
    });
  }

  test("the wasm has its media type", async ({ request }) => {
    const response = await request.get(asset(/\.wasm$/));
    expect(response.headers()["content-type"]).toBe("application/wasm");
  });

  test("deploy files are not served", async ({ request }) => {
    for (const url of ["/_headers", "/wrangler.json"]) {
      expect((await request.get(url)).status(), url).toBe(404);
    }
  });
});

test("the page is cross-origin isolated", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  await page.goto("/");
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  // Online, the map margin of the front door is empty.
  await expect(page.locator("#status")).toBeEmpty();
  expect(errors).toEqual([]);
});

test("without the isolation headers the app says so", async ({ page }) => {
  await page.route("/", async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    delete headers["cross-origin-opener-policy"];
    delete headers["cross-origin-embedder-policy"];
    await route.fulfill({ response, headers });
  });
  await page.goto("/");
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(false);
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "unsupported");
  // A typographic apostrophe.
  await expect(page.locator("#unsupported-heading")).toHaveText("This browser can’t run Zipscope");
  await expect(page.locator("#unsupported-reason")).toContainText("not cross-origin isolated");
  // The explainer stays below.
  await expect(page.locator("#explainer")).toHaveCount(1);
});
