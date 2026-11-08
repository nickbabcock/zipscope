// Takes the fixed screenshot set of the design.
// Each run uses the same set: the same surfaces, archives,
// widths and themes. This script is a development tool. It is not part of
// the product.
//
// Usage, from the repository root:
//
//   mise run build && mise run gen:corpus && mise run gen:archive 2000
//   node web/scripts/design-shots.ts <output folder> [surface ...]
//
// The script serves web/dist with `vite preview` on ZIPSCOPE_PORT (default
// 4310) and uses Playwright Chromium. It writes `<surface>-<width>-<theme>.png`
// and `manifest.md` to the output folder. With surface names, it takes only
// those surfaces (for a quick check), and it does not write the manifest.
// ImageMagick (`magick`) must be on the PATH: it makes each PNG smaller.
//
// Things that can change between runs are fixed:
// - The viewport (1440 x 900 and 390 x 844), a device scale factor of 1,
//   the locale (en-US) and the time zone (UTC).
// - The fonts: the system fonts of this machine, with no hinting and no
//   LCD text.
// - Motion: reduced motion is off. The screenshot sets each CSS animation
//   and transition to its end state, so the picture does not catch a frame
//   in the middle.
// - The parse time: the status bar shows "Listed in 48 ms" in each picture.
// - The colors: the PNGs keep all colors, with no palette.
// - The archives: the in-app sample, the test corpus, and archives that this
//   script writes with the e2e generators. Each generator gives the same
//   bytes each time.
// - Service workers are blocked, and each surface gets a new browser
//   context, so no state goes from one surface to the next.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { preview } from "vite";
import { contentZip } from "../e2e/content-zip.ts";
import type { ContentEntry } from "../e2e/content-zip.ts";
import { dropArchive, openArchive, waitForOutcome } from "../e2e/listing.ts";
import { storedZip } from "../e2e/stored-zip.ts";

const web = new URL("..", import.meta.url).pathname;
const root = path.resolve(web, "..");
const port = Number(process.env.ZIPSCOPE_PORT ?? 4310);
const outDir = process.argv[2];
const only = new Set(process.argv.slice(3));
if (outDir === undefined) {
  console.error("usage: node web/scripts/design-shots.ts <output folder> [surface ...]");
  process.exit(2);
}

/** The archives of the set. */
const work = path.join(root, "target/design");
const files = {
  hostile: path.join(root, "target/corpus/generated/hostile.zip"),
  budget: path.join(root, "target/archives/2000.zip"),
  stopped: path.join(work, "stopped.zip"),
  empty: path.join(work, "empty.zip"),
  emptyFolder: path.join(work, "assets.zip"),
  second: path.join(work, "photos-2026.zip"),
  reopen: path.join(work, "site-build.zip"),
};

/** Writes the archives that this script makes. Each one has the same bytes
 *  on each run. */
function writeArchives(): void {
  for (const [name, file] of Object.entries(files)) {
    if (file.startsWith(work)) continue;
    if (!existsSync(file)) {
      throw new Error(
        `${name}: ${file} is missing. Run "mise run gen:corpus" and "mise run gen:archive 2000".`,
      );
    }
  }
  mkdirSync(work, { recursive: true });
  // The archive of the hard stop: the same shape as e2e/view-refused.spec.ts.
  const stopped = Array.from(
    { length: 80_000 },
    (_, index) => [`d${index % 8}/f${String(index).padStart(5, "0")}.txt`, 0] as [string, number],
  );
  writeFileSync(files.stopped, storedZip(stopped, 80_000n));
  writeFileSync(files.empty, storedZip([]));
  // The only entry is one folder, so the archive opens in that folder.
  writeFileSync(files.emptyFolder, storedZip([["assets/", 0]]));
  writeFileSync(
    files.second,
    storedZip([
      ["photos-2026/january/IMG_0001.jpg", 2_400_000],
      ["photos-2026/january/IMG_0002.jpg", 2_100_000],
      ["photos-2026/february/IMG_0101.jpg", 2_800_000],
    ]),
  );
  const text = (value: string) => Buffer.from(value);
  const site: ContentEntry[] = [
    { name: "site-build/index.html", data: text("<!doctype html>\n<title>Home</title>\n") },
    { name: "site-build/about/index.html", data: text("<!doctype html>\n<title>About</title>\n") },
    { name: "site-build/assets/css/main.css", data: text("body { margin: 0; }\n".repeat(400)) },
    { name: "site-build/assets/js/app.js", data: text("console.log('app');\n".repeat(900)) },
    { name: "site-build/assets/js/vendor.js", data: text("export {};\n".repeat(3000)) },
    { name: "site-build/assets/img/logo.svg", data: text("<svg></svg>\n") },
    { name: "site-build/robots.txt", data: text("User-agent: *\n") },
  ];
  writeFileSync(files.reopen, contentZip(site));
}

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

/** One run of a surface: the page is open at the width and theme. */
type Shot = {
  page: Page;
  context: BrowserContext;
  width: number;
  url: string;
  /** Takes the picture. A surface can take more than one: the suffix
   *  names the next ones. */
  take: (suffix?: string) => Promise<void>;
};

type Surface = {
  name: string;
  /** What the picture shows, for the manifest. */
  shows: string;
  archive: string;
  /** The widths where the surface does not exist, with the reason. */
  skip?: Partial<Record<number, string>>;
  /** Init scripts to add before the page loads. */
  init?: (context: BrowserContext) => Promise<void>;
  /** More pictures of the surface, with the suffix and what each shows. */
  more?: { suffix: string; shows: string }[];
  run: (shot: Shot) => Promise<void>;
};

const tree = (page: Page) => page.locator("#tree-viewport [role=treeitem]:not([hidden])");
const listed = (page: Page) =>
  page.locator(
    '#list-viewport [data-row]:not([hidden]):not([data-block]):not([data-kind="heading"])',
  );
/** The listed rows with this label. The narrow layout cuts a long label in
 *  the middle, and then the full label is in its title. */
const named = (page: Page, label: string) =>
  listed(page).filter({
    has: page
      .locator('[data-part="label"]', { hasText: label })
      .or(page.locator(`[data-part="label"][title="${label}"]`)),
  });

async function sample(page: Page): Promise<void> {
  await page.locator("#sample-button").click();
  const result = await waitForOutcome(page);
  if (result.outcome !== "complete") throw new Error(`sample: ${result.status}`);
  await page.locator("#health-strip").waitFor();
}

async function openFile(page: Page, file: string): Promise<void> {
  await openArchive(page, file);
  await waitForOutcome(page);
}

/** Opens the tree: in the wide layout it is a pane, else a drawer. */
async function showTree(page: Page, width: number): Promise<void> {
  if (width < 1200) {
    await page.locator("#drawer-button").click();
    await tree(page).first().waitFor();
  }
}

/** Opens the Archive panel from the root row of the tree. */
async function archivePanel(page: Page, width: number): Promise<void> {
  await showTree(page, width);
  await tree(page).first().click();
  await page.locator("#archive-panel").waitFor();
  // The settled state, so that a set of pictures is the same in each run.
  await page.locator("#archive-map:not([aria-busy])").waitFor();
  await page.locator("#archive-methods").waitFor();
}

/** Stubs the pickers with the origin private file system, as the e2e tests
 *  do, so that an extraction or a copy writes no file to the disk. */
async function stubPickers(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.assign(window, {
      showSaveFilePicker: async (options: { suggestedName: string }) => {
        const root = await navigator.storage.getDirectory();
        return root.getFileHandle(options.suggestedName, { create: true });
      },
      showDirectoryPicker: async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle("out", { create: true });
      },
    });
  });
}

const SAMPLE = "in-app sample (demo-app-2.4.0-release.zip)";
const HOSTILE = "target/corpus/generated/hostile.zip (mise run gen:corpus)";

const surfaces: Surface[] = [
  {
    name: "front-door",
    shows: "The front door, first visit, online: the first viewport.",
    archive: "none",
    more: [
      {
        suffix: "below",
        shows: "The front door below the first view: the reference answers.",
      },
      {
        suffix: "end",
        shows: "The front door at the end: the close above the sticky row.",
      },
    ],
    run: async ({ page, take }) => {
      await page.locator('#front-door[data-preloaded="true"]').waitFor();
      await take();
      await page.locator("#explainer").evaluate((element) => element.scrollIntoView());
      await take("below");
      await page.locator("#door-close").evaluate((element) => element.scrollIntoView());
      await take("end");
    },
  },
  {
    name: "offline",
    shows:
      'The front door while the device is offline: "Offline. Zipscope still works." in the map margin.',
    archive: "none",
    run: async ({ page, context, take }) => {
      // The preload ends when the workers and the wasm are ready. Only then
      // can the device open a file offline.
      await page.locator('#front-door[data-preloaded="true"]').waitFor();
      await context.setOffline(true);
      await page.locator("footer", { hasText: "Offline" }).waitFor();
      await take();
    },
  },
  {
    name: "tool",
    shows: "The tool just after the sample opens: the default landing view.",
    archive: SAMPLE,
    run: async ({ page, take }) => {
      await sample(page);
      await take();
    },
  },
  {
    name: "tree",
    shows:
      "The folder tree, open down to share/demo-app/icons/hicolor/256x256/actions (at 390 px, the tree drawer).",
    archive: SAMPLE,
    run: async ({ page, width, take }) => {
      await sample(page);
      for (const label of ["share/", "demo-app/", "icons/hicolor/", "256x256/actions/"]) {
        await named(page, label).first().click();
        await page.locator("#location", { hasText: label.split("/")[0]! }).waitFor();
      }
      await showTree(page, width);
      await take();
    },
  },
  {
    name: "table",
    shows:
      "The table in share/licenses/third-party (one folder for each crate), sorted by size, largest first.",
    archive: SAMPLE,
    run: async ({ page, take }) => {
      await sample(page);
      for (const label of ["share/", "licenses/third-party/"]) {
        await named(page, label).first().click();
        await page.locator("#location", { hasText: label.split("/")[0]! }).waitFor();
      }
      const size = page.locator("[role=columnheader]", { hasText: "Size" }).first();
      for (let step = 0; step < 2; step++) {
        if ((await size.getAttribute("aria-sort")) === "descending") break;
        await size.locator("button").first().click();
      }
      await take();
    },
  },
  {
    name: "largest",
    shows:
      'The "Largest files under this folder" block below the short listing of the landing folder, with its first row selected and its preview open (a hex view).',
    archive: SAMPLE,
    run: async ({ page, take }) => {
      await sample(page);
      const block = page.locator("#list-viewport [data-block]:not([hidden])");
      await block.first().waitFor();
      // A click only selects (the Quick Look model). A double-click opens the
      // preview with the pointer, as most users do.
      await block.locator('[data-part="label"]').first().dblclick();
      await page.locator("#preview-pane").waitFor();
      await take();
    },
  },
  {
    name: "row-menu",
    shows: "The row menu of a file in lib/, opened with the secondary button.",
    archive: SAMPLE,
    run: async ({ page, take }) => {
      await sample(page);
      await named(page, "lib/").first().click();
      await page.locator("#location", { hasText: "lib" }).waitFor();
      const file = page
        .locator('#list-viewport [data-row][data-kind="entry"]:not([hidden]):not([data-block])')
        .nth(2);
      await file.click({ button: "right", position: { x: 60, y: 12 } });
      await page.locator("#row-menu").waitFor();
      await take();
    },
  },
  {
    name: "preview",
    shows:
      "The preview of share/doc/demo-app/README.md, a text file with line numbers (at 390 px, the full-screen preview).",
    archive: SAMPLE,
    run: async ({ page, take }) => {
      await sample(page);
      for (const label of ["share/", "doc/demo-app/"]) {
        await named(page, label).first().click();
        await page.locator("#location", { hasText: label.split("/")[0]! }).waitFor();
      }
      // A click only selects (the Quick Look model): a double-click opens the
      // preview with the pointer, so no focus ring shows on Back.
      await named(page, "README.md").first().dblclick();
      await page.locator("#preview-text").waitFor();
      await take();
    },
  },
  {
    name: "archive-panel",
    shows: "The Archive panel: totals, methods, health link, byte map, format.",
    archive: SAMPLE,
    more: [{ suffix: "scrolled", shows: "The Archive panel scrolled to its end." }],
    run: async ({ page, width, take }) => {
      await sample(page);
      await archivePanel(page, width);
      await take();
      await page
        .locator("#archive-footer, #archive-format")
        .last()
        .evaluate((element) => element.scrollIntoView({ block: "end" }));
      await take("scrolled");
    },
  },
  {
    name: "health",
    shows: "The health strip and the open findings list of a hostile archive.",
    archive: HOSTILE,
    more: [{ suffix: "strip", shows: "The health strip only, with the findings list closed." }],
    run: async ({ page, take }) => {
      await openFile(page, files.hostile);
      await page.locator("#health-strip").waitFor();
      await take("strip");
      await page.locator("#health-toggle").click();
      await page.locator("#health-panel").waitFor();
      await take();
    },
  },
  {
    name: "memory-prompt",
    shows: "The memory prompt at the soft budget (a test budget of 12 MiB).",
    archive: "target/archives/2000.zip (mise run gen:archive 2000)",
    init: async (context) => {
      await context.addInitScript(() => {
        (globalThis as { __zipscopeTestBudget?: unknown }).__zipscopeTestBudget = {
          soft: 12 * 2 ** 20,
          hard: 2 ** 31,
        };
      });
    },
    run: async ({ page, take }) => {
      await openArchive(page, files.budget);
      await page.locator("#budget-prompt").waitFor();
      await take();
    },
  },
  {
    name: "hard-stop",
    shows:
      "The hard stop at a test limit of 32 MiB: the error strip and the controls that are off.",
    archive: "target/design/stopped.zip (80,000 empty stored entries, written by this script)",
    init: async (context) => {
      await context.addInitScript(() => {
        (globalThis as { __zipscopeTestBudget?: unknown }).__zipscopeTestBudget = {
          soft: 2 ** 31,
          hard: 32 * 2 ** 20,
        };
      });
    },
    run: async ({ page, take }) => {
      await openFile(page, files.stopped);
      await page.locator("#health-stopped").waitFor();
      await take();
    },
  },
  {
    name: "extract-dialog",
    shows: "The extraction dialog for the root folder of the sample, before the folder choice.",
    archive: SAMPLE,
    init: stubPickers,
    run: async ({ page, take }) => {
      await sample(page);
      await page.locator("#folder-extract").click();
      await page.locator("#extract-confirm").waitFor();
      await take();
    },
  },
  {
    name: "extract-risk",
    shows:
      'The extraction dialog for the hostile archive: the risk of a bomb-like extraction, with "Extract anyway" and no primary button.',
    archive: HOSTILE,
    init: stubPickers,
    run: async ({ page, take }) => {
      await openFile(page, files.hostile);
      await page.locator("#folder-extract").click();
      await page.locator("#extract-confirm", { hasText: "Extract anyway" }).waitFor();
      await take();
    },
  },
  {
    name: "extract-report",
    shows:
      "The extraction report of the hostile archive: the summary, counts and the item table with failures and skips.",
    archive: HOSTILE,
    init: stubPickers,
    run: async ({ page, take }) => {
      await openFile(page, files.hostile);
      await page.locator("#folder-extract").click();
      // "Extract anyway" accepts the risk and then opens the folder picker.
      await page.locator("#extract-confirm", { hasText: "Extract anyway" }).click();
      await page.locator("#extract-summary").waitFor({ timeout: 60_000 });
      await take();
    },
  },
  {
    name: "remux-dialog",
    shows: "The zstd copy dialog of the sample, from the Archive panel.",
    archive: SAMPLE,
    init: stubPickers,
    run: async ({ page, width, take }) => {
      await sample(page);
      await archivePanel(page, width);
      await page.locator("#archive-remux #remux-button").click();
      await page.locator("#remux-confirm").waitFor();
      await take();
    },
  },
  {
    name: "remux-report",
    shows: "The report after the zstd copy of the sample.",
    archive: SAMPLE,
    init: stubPickers,
    run: async ({ page, width, take }) => {
      await sample(page);
      await archivePanel(page, width);
      await page.locator("#archive-remux #remux-button").click();
      await page.locator("#remux-confirm").click();
      await page.locator("#remux-summary").waitFor({ timeout: 120_000 });
      await take();
    },
  },
  {
    name: "replace",
    shows:
      'The Replace dialog: a second archive dropped while the sample is open ("Open photos-2026.zip").',
    archive: `${SAMPLE}, then target/design/photos-2026.zip (written by this script)`,
    run: async ({ page, take }) => {
      await sample(page);
      await dropArchive(page, files.second);
      await page.locator("#open-choice").waitFor();
      await take();
    },
  },
  {
    name: "reopen",
    shows:
      'The front door after a reload: "Reopen the file to continue", the archive name and the last folder.',
    archive:
      "target/design/site-build.zip (written by this script, kept in the origin private file system)",
    init: async (context) => {
      await context.addInitScript(() => {
        Object.assign(window, {
          showOpenFilePicker: async () => {
            const root = await navigator.storage.getDirectory();
            return [await root.getFileHandle("site-build.zip")];
          },
        });
      });
    },
    run: async ({ page, take }) => {
      const bytes = [...readFileSync(files.reopen)];
      await page.evaluate(async (data) => {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle("site-build.zip", { create: true });
        const writable = await handle.createWritable();
        await writable.write(new Uint8Array(data));
        await writable.close();
      }, bytes);
      await page.locator("#front-open").click();
      await waitForOutcome(page);
      await named(page, "assets/").first().click();
      await page.locator("#location", { hasText: "assets" }).waitFor();
      // The location goes to the history after a short time.
      await page.waitForTimeout(1000);
      await page.reload();
      await page.locator("#reopen-button").waitFor();
      await take();
    },
  },
  {
    name: "unsupported",
    shows: `The "This browser can't run Zipscope" page (CSS anchor positioning reported as missing).`,
    archive: "none",
    init: async (context) => {
      await context.addInitScript(() => {
        const supports = CSS.supports.bind(CSS);
        CSS.supports = ((...args: [string, string?]) =>
          String(args[0]).includes("anchor")
            ? false
            : supports(...(args as [string]))) as typeof CSS.supports;
      });
    },
    run: async ({ page, take }) => {
      await page.waitForLoadState("load");
      await page.locator("h1, [role=heading]").first().waitFor();
      await take();
    },
  },
  {
    name: "empty-archive",
    shows: 'An archive with no entries: "This archive has no entries."',
    archive: "target/design/empty.zip (written by this script)",
    run: async ({ page, take }) => {
      await openFile(page, files.empty);
      await take();
    },
  },
  {
    name: "empty-folder",
    shows: 'An archive whose only entry is one folder: "This folder is empty."',
    archive: "target/design/assets.zip (written by this script)",
    run: async ({ page, take }) => {
      await openFile(page, files.emptyFolder);
      await page.locator("#folder-empty").waitFor();
      await take();
    },
  },
];

/** Puts the fixed values in the page just before a picture. */
async function freeze(page: Page): Promise<void> {
  await page.evaluate(() => {
    const status = document.getElementById("status");
    if (status !== null && /^Listed in \d+ ms$/.test(status.textContent ?? "")) {
      status.textContent = "Listed in 48 ms";
    }
  });
  await page.mouse.move(0, 0);
}

/** Removes the metadata, so that two same pictures have the same bytes.
 *  The colors stay as they are: a smaller palette turned thin colored
 *  lines into gray, which looks like a defect of the app. */
function shrink(file: string): void {
  execFileSync("magick", [
    file,
    "-strip",
    "-define",
    "png:exclude-chunks=date,time",
    "-define",
    "png:compression-level=9",
    file,
  ]);
}

type Row = { file: string; shows: string; archive: string };

async function runSurface(
  browser: Browser,
  url: string,
  surface: Surface,
  size: (typeof WIDTHS)[number],
  theme: Theme,
  rows: Row[],
): Promise<void> {
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion: "no-preference",
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
  });
  try {
    await surface.init?.(context);
    // Playwright has no time limit outside its test runner. A step that
    // waits too long fails the surface, and the run goes on.
    context.setDefaultTimeout(30_000);
    const page = await context.newPage();
    page.on("pageerror", (error) => console.log(`  page error: ${error.message}`));
    await page.goto(url);
    const take = async (suffix?: string) => {
      const name = suffix === undefined ? surface.name : `${surface.name}-${suffix}`;
      const file = `${name}-${size.width}-${theme}.png`;
      await freeze(page);
      await page.waitForTimeout(250);
      await page.screenshot({
        path: path.join(outDir!, file),
        animations: "disabled",
        caret: "hide",
      });
      shrink(path.join(outDir!, file));
      const shows =
        suffix === undefined
          ? surface.shows
          : (surface.more?.find((item) => item.suffix === suffix)?.shows ?? surface.shows);
      rows.push({ file, shows, archive: surface.archive });
      console.log(`  ${file}`);
    };
    await surface.run({ page, context, width: size.width, url, take });
  } finally {
    await context.close();
  }
}

writeArchives();
mkdirSync(outDir, { recursive: true });
const server = await preview({
  root: web,
  configFile: path.join(web, "vite.config.ts"),
  preview: { port, strictPort: true, open: false },
  logLevel: "warn",
});
const browser = await chromium.launch({
  args: ["--font-render-hinting=none", "--disable-lcd-text", "--force-color-profile=srgb"],
});
const rows: Row[] = [];
const skips: string[] = [];
const failures: string[] = [];
try {
  const url = `http://localhost:${port}/`;
  for (const surface of surfaces) {
    if (only.size > 0 && !only.has(surface.name)) continue;
    for (const size of WIDTHS) {
      const reason = surface.skip?.[size.width];
      if (reason !== undefined) {
        skips.push(`${surface.name} at ${size.width} px: ${reason}`);
        continue;
      }
      for (const theme of THEMES) {
        try {
          await runSurface(browser, url, surface, size, theme, rows);
        } catch (error) {
          const message = `${surface.name} ${size.width} ${theme}: ${(error as Error).message.split("\n")[0]}`;
          if (process.env.DESIGN_SHOTS_DEBUG !== undefined) console.log((error as Error).message);
          console.log(`  FAILED ${message}`);
          failures.push(message);
        }
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}

if (only.size === 0) {
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root })
    .toString()
    .trim();
  const lines = [
    "# Design screenshots",
    "",
    `Commit ${commit}. Chromium (Playwright), device scale factor 1, en-US, UTC.`,
    "Viewports: 1440 x 900 and 390 x 844. Themes: light and dark (prefers-color-scheme).",
    'Fixed values: the status bar shows "Listed in 48 ms" in place of the measured parse time.',
    "CSS animations and transitions show their end state. PNGs have their full colors.",
    "",
    "| File | Shows | Archive |",
    "| --- | --- | --- |",
    ...rows.map((row) => `| ${row.file} | ${row.shows} | ${row.archive} |`),
    "",
    "## Skips",
    "",
    ...(skips.length === 0 ? ["None."] : skips.map((skip) => `- ${skip}`)),
    "",
    "## Failures",
    "",
    ...(failures.length === 0 ? ["None."] : failures.map((failure) => `- ${failure}`)),
    "",
  ];
  writeFileSync(path.join(outDir, "manifest.md"), lines.join("\n"));
}
console.log(`${rows.length} pictures, ${skips.length} skips, ${failures.length} failures`);
if (failures.length > 0) process.exitCode = 1;
