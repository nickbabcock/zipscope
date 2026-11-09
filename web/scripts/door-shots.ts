// Makes the pictures of the front door in `public/door/`: the tool on the
// sample archive, at desktop and phone widths, and the preview of the
// picture of the sample, in the light and the night theme. Each picture is a capture of the real tool in
// headless Chromium, so it is true for the current build. Run it after a
// change to the look of the tool:
//
//   mise run gen:door-shots
//
// It serves `dist/` (build first), writes PNG captures to a temporary
// directory, and converts them to AVIF with ImageMagick (`magick`). The sizes
// come from `SHOTS` in `src/front/door-static.ts`. Each file has two times as
// many pixels as its CSS size.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { preview } from "vite";
import { SHOTS } from "../src/front/door-static.ts";
import { SAMPLE_PICTURE, SAMPLE_ROOT } from "../src/front/sample-names.ts";

const out = new URL("../public/door/", import.meta.url).pathname;
const work = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "door-shots-"));
const port = Number(process.env.ZIPSCOPE_PORT ?? 4393);

/** Waits until the sample archive is listed and the fonts are ready. */
async function settle(page: Page): Promise<void> {
  await page.locator("#status-bar, footer").first().waitFor();
  await page.waitForFunction(() => document.querySelector("#list-viewport [role=row]") !== null);
  await page.evaluate(() => document.fonts.ready);
  // The listing and the preview fill in over a few frames.
  await page.waitForTimeout(1500);
}

/** Converts a PNG capture to AVIF in `public/door/`. */
function avif(png: string, name: string): void {
  const file = path.join(out, `${name}.avif`);
  execFileSync("magick", [png, "-strip", "-quality", "62", file]);
  console.log(`wrote ${file}`);
}

async function desktop(browser: Browser, url: string, scheme: "light" | "dark"): Promise<void> {
  const page = await browser.newPage({
    viewport: { width: SHOTS.tool.width, height: SHOTS.tool.height },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await page.goto(url);
  // The capture shows the space hog in the largest files, with its preview.
  await page.locator("#door-shot-button").click();
  await settle(page);
  await page
    .locator('#list-viewport [role=row] [data-part="label"]', { hasText: "debug/demo-app.debug" })
    .first()
    .click();
  await page.keyboard.press("Enter");
  await page.locator("#preview-pane").waitFor();
  await page.waitForTimeout(1000);
  // The capture has no focus ring: the selected row shows the selection.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(200);
  const tool = path.join(work, `tool-${scheme}.png`);
  await page.screenshot({ path: tool });
  avif(tool, `tool-${scheme}`);
  await page.close();
}

async function previewShot(browser: Browser, url: string, scheme: "light" | "dark"): Promise<void> {
  const page = await browser.newPage({
    viewport: { width: SHOTS.preview.width, height: SHOTS.preview.height },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await page.goto(url);
  await page.locator("#door-shot-button").click();
  await settle(page);
  // Go down the folders to the picture of the sample. A folder row can
  // name a chain of folders ("icons/hicolor/").
  const rows = page.locator("#list-viewport [role=row]");
  const label = '[data-part="label"]';
  let rest = SAMPLE_PICTURE.slice(SAMPLE_ROOT.length + 1);
  while (rest.includes("/")) {
    const labels = await rows.locator(label).allTextContents();
    const folder = labels.find((name) => name.endsWith("/") && rest.startsWith(name));
    if (folder === undefined) throw new Error(`no folder row for ${rest}`);
    await rows
      .filter({ has: page.locator(label, { hasText: folder }) })
      .first()
      .dblclick();
    rest = rest.slice(folder.length);
    await rows
      .locator(label, { hasText: rest.split("/")[0] })
      .first()
      .waitFor();
  }
  await rows
    .filter({ has: page.locator(label, { hasText: rest }) })
    .first()
    .click();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector<HTMLImageElement>("#preview-pane img")?.complete === true,
  );
  await page.waitForTimeout(500);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const file = path.join(work, `preview-${scheme}.png`);
  await page.screenshot({ path: file });
  avif(file, `preview-${scheme}`);
  await page.close();
}

async function phone(browser: Browser, url: string, scheme: "light" | "dark"): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: SHOTS.mobile.width, height: SHOTS.mobile.height },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.locator("#door-shot-button").click();
  await settle(page);
  const file = path.join(work, `mobile-${scheme}.png`);
  await page.screenshot({ path: file });
  avif(file, `mobile-${scheme}`);
  await context.close();
}

const server = await preview({ preview: { port, strictPort: true } });
const browser = await chromium.launch();
try {
  const url = `http://localhost:${port}/`;
  for (const scheme of ["light", "dark"] as const) {
    await desktop(browser, url, scheme);
    await previewShot(browser, url, scheme);
    await phone(browser, url, scheme);
  }
} finally {
  await browser.close();
  await server.close();
  rmSync(work, { recursive: true, force: true });
}
