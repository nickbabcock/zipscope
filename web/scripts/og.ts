// Makes the social picture `public/og.png`: the word mark, the line "A zip
// viewer in your browser." and a screenshot of the app with the sample
// archive open at its root, as a sheet with a slight turn.
//
// The card shows the UI. When the shell layout, the tokens or the sample
// archive change, make the card again.
//
// Usage, from the `web` folder, with the built app on a preview server:
//
//   ZIPSCOPE_PORT=4310 mise run preview
//   ZIPSCOPE_PORT=4310 node scripts/og.ts [url]
//
// Without a URL, the script uses http://localhost:<ZIPSCOPE_PORT>/ (default
// port 4173). It uses Playwright Chromium and ImageMagick (`magick`).
//
// The screenshot is the whole app at 1240 x 480 CSS px in the light theme,
// at device scale 3, so the rows stay sharp after the turn. The card is
// drawn at device scale 2 and reduced to 1200 x 630 with 256 colors and no
// dither, for a small file. The text uses system-ui, which is different on
// each operating system. Thus a card from a different system looks
// different. The status bar shows the parse time of this run.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { waitForOutcome } from "../e2e/listing.ts";

const url = process.argv[2] ?? `http://localhost:${process.env.ZIPSCOPE_PORT ?? 4173}/`;
const out = fileURLToPath(new URL("../public/og.png", import.meta.url));
const width = 1240;
const height = 480;

const browser = await chromium.launch();
const app = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: 3,
  colorScheme: "light",
});
await app.goto(url);
await app.getByRole("button", { name: "Try a sample archive" }).click();
const result = await waitForOutcome(app);
if (result.outcome !== "complete") throw new Error(`sample: ${result.status}`);
await app.getByRole("button", { name: "Preview" }).click();
// Opens share and share/demo-app in the tree: select the row, then the
// right arrow. Then selects the root, so the table lists the largest files.
const tree = app.getByRole("tree");
const row = (name: string) =>
  tree.getByRole("treeitem", { name: new RegExp(`^${name}(?![-\\w.])`) }).first();
for (const name of ["share", "demo-app"]) {
  await row(name).click();
  await app.waitForTimeout(300);
  await app.keyboard.press("ArrowRight");
  await app.waitForTimeout(300);
}
await row("demo-app-2\\.4\\.0-release\\.zip").click();
await app.waitForTimeout(500);
// Selects the largest file, so the preview shows its bytes.
await app.getByText("debug/demo-app.debug").first().click();
await app.waitForTimeout(800);
await app.mouse.move(width - 5, height - 5);
await app.waitForTimeout(300);
const shot = (await app.screenshot()).toString("base64");

const card = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 2,
});
await card.setContent(`<!doctype html><html><head><style>
html,body{margin:0}
body{width:1200px;height:630px;overflow:hidden;position:relative;background:#fafaf9;color:#1c1917;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
.mark{position:absolute;left:72px;top:30px;margin:0;font-size:88px;font-weight:650;letter-spacing:-0.01em;line-height:1;white-space:nowrap}
.line{position:absolute;left:75px;top:128px;margin:0;font-size:42px;font-weight:400;line-height:1.15;white-space:nowrap}
.sheet{position:absolute;left:75px;top:212px;width:1040px;display:block;border-radius:10px;
  border:1px solid #e7e5e4;transform-origin:left top;transform:rotate(-1.5deg);
  box-shadow:0 8px 24px rgb(28 25 23 / .14)}
</style></head><body>
<h1 class="mark">Zipscope</h1>
<p class="line">A zip viewer in your browser.</p>
<img class="sheet" src="data:image/png;base64,${shot}" alt="">
</body></html>`);
const big = await card.screenshot();
await browser.close();

execFileSync(
  "magick",
  [
    "png:-",
    "-filter",
    "Lanczos",
    "-resize",
    "1200x630!",
    "+dither",
    "-colors",
    "256",
    "-strip",
    `PNG8:${out}`,
  ],
  { input: big },
);
