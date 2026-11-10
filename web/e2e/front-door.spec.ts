// The front door: the word mark, the row of actions and the picture of the
// tool in the served HTML, the five bands and their "See it" controls, the
// connection reading, the demo archive, a drop that turns the page into the
// tool, and the states for returning visitors.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { door, front } from "../src/front/strings.ts";
import { dropArchive, openArchive, waitForOutcome } from "./listing";
import { storedZip } from "./stored-zip";

/** The text of the `h1`: the word mark, a hidden colon and the tagline. */
const HEADING = `${door.mark}: ${door.tagline}`;
const BANDS = [door.fast, door.local, door.preview, door.health, door.save];

/** A served copy with no marks: the HTML puts these words in `<code>` or `<b>`. */
const plain = (text: string) => text.replaceAll("`", "").replaceAll("**", "");

/** Marks the document, so a test can see that no navigation happened. */
async function mark(page: Page): Promise<void> {
  await page.evaluate(() => ((window as { zipscopeMark?: number }).zipscopeMark = 1));
}

async function marked(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as { zipscopeMark?: number }).zipscopeMark === 1);
}

for (const [width, height] of [
  [1440, 900],
  [1440, 780],
  [1280, 720],
  [1000, 800],
  [720, 800],
  [390, 844],
  [320, 568],
]) {
  test(`the first view has the word mark, the actions and the tool at ${width} x ${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.locator("#front-door")).toHaveAttribute("data-state", "first");
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText(HEADING);
    await expect(page.locator("#door-wordmark")).toBeInViewport({ ratio: 1 });
    // The word mark is in the display face, and it does not overflow.
    expect(
      await page.locator("#door-wordmark").evaluate((el) => getComputedStyle(el).fontFamily),
    ).toContain("Archivo Black");
    const widths = await page
      .locator("#front-door")
      .evaluate((door) => [door.scrollWidth, door.clientWidth]);
    expect(widths[0]).toBe(widths[1]);
    await expect(page.locator("#front-open")).toHaveText(front.open);
    await expect(page.locator("#front-open")).toBeInViewport({ ratio: 1 });
    // The picture of the tool starts in the first view, below the actions.
    const shot = (await page.locator("#door-shot-button").boundingBox())!;
    const open = (await page.locator("#front-open").boundingBox())!;
    expect(shot.y).toBeGreaterThan(open.y + open.height);
    if (height >= 720) expect(shot.y).toBeLessThan(height - 28);
    // The page scrolls inside the work area. The map margin stays.
    await page.locator("#door-close").scrollIntoViewIfNeeded();
    await expect(page.locator("#door-close")).toBeInViewport();
    await expect(page.locator("footer")).toBeInViewport();
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  });
}

for (const [width, side] of [
  [1440, true],
  [390, false],
] as const) {
  test(`each band has its datum ${side ? "beside" : "above"} its claim at ${width} px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    for (const id of ["fast", "local", "preview", "health", "save"]) {
      const datum = (await page.locator(`#door-${id} .door-datum`).boundingBox())!;
      const claim = (await page.locator(`#door-${id} .door-claim`).boundingBox())!;
      if (side) expect(claim.x, id).toBeGreaterThan(datum.x + datum.width);
      else expect(claim.y, id).toBeGreaterThanOrEqual(datum.y + datum.height);
    }
  });
}

test("the served HTML has the page, the bands and the head tags", async ({ request }) => {
  const html = await (await request.get("/")).text();
  const text = html.replace(/<\/?(code|kbd|b)>/g, "");
  expect(html).toContain('<span id="door-wordmark">Zipscope</span>');
  expect(text).toContain(plain(door.lead));
  expect(html.match(/class="door-tag"/g)).toHaveLength(1);
  for (const band of BANDS) {
    expect(html).toContain(`>${band.heading}</h2>`);
    expect(text).toContain(plain(band.body));
  }
  expect(html).toContain(door.preview.shotAlt);
  expect(html).toContain(door.local.note);
  // The page links neither the source code nor the sample in the bands.
  expect(html).not.toContain("github.com");
  expect(html).not.toContain("door-see");
  expect(html).toContain(door.noScript);
  expect(html).toContain(door.opens);
  expect(html).toContain("<title>Zip viewer in your browser");
  expect(html).toContain('name="description"');
  expect(html).toContain('property="og:title"');
  expect(html).toContain('name="twitter:card"');
  expect(html).toContain('rel="icon"');
  expect(html).toMatch(
    /<link\s+rel="preload"\s+href="\/fonts\/archivo-black-latin\.woff2"\s+as="font"/,
  );
  // No origin in this build: these tags stay out, and the page is not indexed.
  expect(html).toContain('<meta name="robots" content="noindex"');
  expect(html).not.toContain('rel="canonical"');
  expect(html).not.toContain("og:url");
  expect(html).not.toContain("og:image");
  expect(html).not.toContain("application/ld+json");
  // No inline style or script: the CSP blocks them.
  expect(html).not.toContain("<style");
  expect(html).not.toContain(" style=");
});

test("the first paint has the styles and the pictures, with no script", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("#door-noscript")).toHaveText(door.noScript);
  const mark = page.locator("#door-wordmark");
  await expect(mark).toBeInViewport({ ratio: 1 });
  expect(await mark.evaluate((element) => getComputedStyle(element).fontFamily)).toContain(
    "Archivo Black",
  );
  const picture = page.locator("#door-shot img");
  await expect(picture).toHaveAttribute("alt", door.shotAlt);
  await expect
    .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  await context.close();
});

for (const [name, chunk] of [
  ["the entry module", "index"],
  ["the app chunk", "start"],
] as const) {
  test(`a page where ${name} cannot load says why nothing works`, async ({ page }) => {
    await page.route(`**/assets/${chunk}-*.js`, (route) => route.abort("failed"));
    await page.goto("/");
    await expect(page.locator("#door-failed")).toHaveText(door.noScript);
    await expect(page.locator("#door-failed")).toBeVisible();
    await expect(page.locator("#door-hero")).toBeVisible();
  });
}

for (const [width, height] of [
  [1440, 900],
  [390, 844],
  [320, 568],
]) {
  test(`with a failed entry module the row has only the failed line at ${width} px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.route("**/assets/index-*.js", (route) => route.abort("failed"));
    await page.goto("/");
    const line = page.locator("#door-failed");
    await expect(line).toBeVisible();
    // The page cannot act on a drop, so it does not ask for one.
    await expect(page.locator("#door-action")).toBeHidden();
    const row = (await page.locator("#door-row").boundingBox())!;
    const box = (await line.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(row.y);
    expect(box.y + box.height).toBeLessThanOrEqual(row.y + row.height);
  });
}

test("a reload with an archive says why nothing works when the entry module cannot load", async ({
  page,
}) => {
  await openSmall(page);
  await page.route("**/assets/index-*.js", (route) => route.abort("failed"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-door", "resume");
  const line = page.locator("#door-failed");
  await expect(line).toHaveText(door.noScript);
  await expect(line).toBeInViewport({ ratio: 1 });
  // The rest of the page and the action line stay hidden in this state.
  for (const selector of ["#door-lead", "#door-shot-frame", "#door-bands", "#door-close"]) {
    await expect(page.locator(selector), selector).toBeHidden();
  }
  await expect(page.locator("#door-action")).toBeHidden();
});

test("a page that starts does not show the line about scripts", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#front-door")).toBeVisible();
  await expect(page.locator("#door-failed")).toBeHidden();
});

test("the headings are in order, with one h1 on the door", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#front-door")).toBeVisible();
  const levels = await page
    .locator("h1, h2, h3")
    .evaluateAll((items) => items.map((item) => item.tagName));
  expect(levels[0]).toBe("H1");
  expect(levels.filter((level) => level === "H1")).toHaveLength(1);
  // The bands and the close are the sections of the page.
  expect(levels.slice(1).every((level) => level === "H2")).toBe(true);
  await expect(page.locator("h1")).toHaveText(HEADING);
  // The poster word mark is the header: the top bar of the tool does not show.
  await expect(page.locator("header")).toBeHidden();
});

test("the tab order follows the first view", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#door-shot-button")).toBeVisible();
  const order: (string | null)[] = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Tab");
    order.push(
      await page.evaluate(
        () => document.activeElement?.id || document.activeElement?.textContent || null,
      ),
    );
  }
  // The bands have no controls: the close comes next.
  expect(order).toEqual(["front-open", "door-shot-button", "close-open"]);
});

test("the rest of the page shows below the first view", async ({ page }) => {
  await page.goto("/");
  const picture = page.locator(".door-preview-shot img");
  await picture.scrollIntoViewIfNeeded();
  await expect(picture).toBeVisible();
  await expect(picture).toHaveAttribute("alt", door.preview.shotAlt);
  await expect(page.locator("#door-bands a, #door-bands button")).toHaveCount(0);
  // The close asks for a file again.
  await expect(page.locator("#close-open")).toHaveText(front.open);
  await expect(page.getByRole("button", { name: front.open })).toHaveCount(2);
});

test("the picture of the tool is the one way into the sample", async ({ page }) => {
  await page.goto("/");
  await mark(page);
  const shot = page.getByRole("button", { name: front.shotName });
  await expect(shot).toHaveId("door-shot-button");
  // The caption that says what the picture does is in the first view.
  await expect(page.locator("#door-shot-label")).toBeInViewport();
  await expect(page.locator("#sample-button")).toHaveCount(0);
  await shot.click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#demo-label")).toHaveText(front.demo);
  expect(await marked(page)).toBe(true);
});

for (const [width, height] of [
  [1440, 900],
  [390, 844],
]) {
  test(`the buttons do not move during a drag at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    const before = await page.locator("#front-open").boundingBox();
    await page.locator("#front-door").evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(new File(["x"], "x.zip"));
      element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: data }));
    });
    await expect(page.locator("#door-action")).toHaveText(door.action.dragging, {
      useInnerText: true,
    });
    expect(await page.locator("#front-open").boundingBox()).toEqual(before);
  });
}

for (const [width, height] of [
  [844, 390],
  [320, 568],
  [641, 500],
]) {
  test(`only the work area scrolls at ${width} x ${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.locator("#door-shot-button")).toBeVisible();
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, 20_000);
    await expect
      .poll(() => page.locator("#front-door").evaluate((door) => door.scrollTop))
      .toBeGreaterThan(0);
    expect((await page.locator("#front-door").boundingBox())!.y).toBe(0);
    await expect(page.locator("footer")).toBeInViewport();
    const metrics = await page.evaluate(() => ({
      top: document.scrollingElement!.scrollTop,
      height: document.scrollingElement!.scrollHeight,
      window: window.innerHeight,
    }));
    expect(metrics.top).toBe(0);
    expect(metrics.height).toBe(metrics.window);
  });
}

for (const width of [320, 360, 379, 380, 390]) {
  test(`nothing overflows the width of the door at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await expect(page.locator("#door-shot-button")).toBeVisible();
    const widths = await page
      .locator("#front-door")
      .evaluate((door) => [door.scrollWidth, door.clientWidth]);
    expect(widths[0]).toBe(widths[1]);
    const button = (await page.locator("#door-shot-button").boundingBox())!;
    expect(button.x + button.width).toBeLessThanOrEqual(width);
  });
}

test("a drag of text does not change the action line", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#door-action")).toHaveText(door.action.fine, { useInnerText: true });
  await page.locator("#front-door").evaluate((element) => {
    const data = new DataTransfer();
    data.setData("text/plain", "a word");
    element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: data }));
  });
  await expect(page.locator("#front-door")).not.toHaveAttribute("data-dragging", "true");
  await expect(page.locator("#door-action")).toHaveText(door.action.fine, { useInnerText: true });
});

test("a file over the window changes the action line", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#door-action")).toHaveText(door.action.fine, { useInnerText: true });
  await page.locator("#front-door").evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File(["x"], "x.zip"));
    element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: data }));
  });
  await expect(page.locator("#door-action")).toHaveText(door.action.dragging, {
    useInnerText: true,
  });
});

test("the map margin shows the reading only while offline, and only it changes", async ({
  page,
  context,
}) => {
  await page.goto("/");
  // The offline line shows when the preload completes. Wait for it, so that
  // only the connection change can change the text.
  await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "true");
  const status = page.locator("#status");
  // Online: the map margin is empty. The live region stays.
  await expect(status).toBeEmpty();
  const before = await page.locator("#front-door").innerText();
  const actions = await page.locator("#front-open").boundingBox();
  await context.setOffline(true);
  await expect(status).toHaveText(front.offline);
  expect(await page.locator("#front-door").innerText()).toBe(before);
  // The reading does not move the actions.
  expect(await page.locator("#front-open").boundingBox()).toEqual(actions);
  await context.setOffline(false);
  await expect(status).toBeEmpty();
});

test("the sample archive opens as a demo, with its findings", async ({ page }) => {
  await page.goto("/");
  await mark(page);
  await page.locator("#door-shot-button").click();
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  expect(result.rows).toBeGreaterThan(500);
  await expect(page.locator("#front-door")).toHaveCount(0);
  await expect(page.locator("#panes")).toBeVisible();
  expect(await marked(page)).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/");
  // "Demo" in the top bar and the title.
  // The DEMO tag shows
  // once, in the top bar; the map margin has none.
  await expect(page.locator("#archive-name")).toHaveText("demo-app-2.4.0-release.zip");
  await expect(page.locator("#demo-label")).toHaveText(front.demo);
  await expect(page.locator("#status-demo")).toHaveCount(0);
  await expect(page).toHaveTitle(/^Demo: demo-app-2\.4\.0-release\.zip/);
  // The two mild findings that the tool detects. The strip shows them;
  // the top bar has no health indicator.
  await expect(page.locator("#health-strip")).toBeVisible();
  await expect(page.locator("#health-indicator")).toHaveCount(0);
  await page.locator("#health-toggle").click();
  const findings = page.locator("#health-panel [data-finding]");
  await expect(findings).toHaveCount(2);
  expect(
    (
      await findings.evaluateAll((items) => items.map((item) => item.getAttribute("data-finding")))
    ).sort(),
  ).toEqual(["duplicate-names", "epilogue"]);
  await expect(page.locator('#health-panel [data-severity="error"]')).toHaveCount(0);
  // The debug symbols are the space hog of the tree.
  await expect(page.locator("#tree-viewport [role=treeitem]", { hasText: "debug" })).toContainText(
    "12.2 MiB",
  );
});

test("a dropped file turns the page into the tool without navigation", async ({ page }) => {
  await page.goto("/");
  await mark(page);
  const bytes = [
    ...storedZip([
      ["drop/one.txt", 3],
      ["drop/two.txt", 5],
    ]),
  ];
  await page.locator("#front-door").evaluate((door, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array(data)], "dropped.zip", { type: "application/zip" }),
    );
    door.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: transfer }));
    door.dispatchEvent(
      new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
    door.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  }, bytes);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  await expect(page.locator("#archive-name")).toHaveText("dropped.zip");
  await expect(page.locator("#front-door")).toHaveCount(0);
  await expect(page.locator("#demo-label")).toHaveCount(0);
  await expect(page).toHaveTitle("Zipscope");
  expect(await marked(page)).toBe(true);
  expect(new URL(page.url()).pathname).toBe("/");
});

for (const id of ["door-shot-button"]) {
  test(`Enter on ${id} moves the focus to the table, with no selected row`, async ({ page }) => {
    await page.goto("/");
    await page.locator(`#${id}`).focus();
    await page.keyboard.press("Enter");
    expect((await waitForOutcome(page)).outcome).toBe("complete");
    const grid = page.locator("#list-viewport");
    await expect(grid).toBeFocused();
    expect(await grid.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
    await expect(grid.locator('[data-row="0"]')).toHaveCSS("box-shadow", /inset/);
    await expect(page.locator('#list-viewport [aria-selected="true"]')).toHaveCount(0);
    // The first key press selects the first row.
    await page.keyboard.press("ArrowDown");
    await expect(page.locator('#list-viewport [aria-selected="true"]')).toHaveCount(1);
  });
}

test("a real file does not move the focus", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#door-shot-button")).toBeVisible();
  const path = test.info().outputPath("focus.zip");
  writeFileSync(path, storedZip([["a/one.txt", 1]]));
  await openArchive(page, path);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#list-viewport")).not.toBeFocused();
});

/** The inset ring on a row, or "none". */
const rowRing = (page: Page, row: number) =>
  page
    .locator(`#list-viewport [data-row="${row}"]`)
    .evaluate((el) => getComputedStyle(el).boxShadow);

test("a real file gets no ring on the first row after a scroll past the selected row", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#door-shot-button")).toBeVisible();
  const path = test.info().outputPath("long.zip");
  writeFileSync(
    path,
    storedZip(
      Array.from({ length: 1501 }, (_, i): [string, number] => [
        `f${String(i).padStart(5, "0")}.txt`,
        1,
      ]),
    ),
  );
  await dropArchive(page, path);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  const grid = page.locator("#list-viewport");
  await grid.focus();
  // The selected row goes out of the row pool.
  await page.keyboard.press("End");
  await expect(page.locator('#list-viewport [aria-selected="true"]')).toHaveCount(1);
  const box = (await grid.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -1_000_000);
  await expect(page.locator('#list-viewport [data-row="0"]')).toBeVisible();
  await expect(page.locator('#list-viewport [aria-selected="true"]')).toHaveCount(0);
  expect(await grid.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  expect(await rowRing(page, 0)).toBe("none");
});

test("a real file gets no ring on the first row after a key press on an empty part", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#door-shot-button")).toBeVisible();
  const path = test.info().outputPath("short.zip");
  writeFileSync(path, storedZip([["one.txt", 1]]));
  await dropArchive(page, path);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  const grid = page.locator("#list-viewport");
  const box = (await grid.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20);
  await expect(grid).toBeFocused();
  await expect(page.locator('#list-viewport [aria-selected="true"]')).toHaveCount(0);
  // A key with no action makes the focus visible.
  await page.keyboard.press("Shift");
  expect(await grid.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  expect(await rowRing(page, 0)).toBe("none");
});

test("the ring of the first row goes with the first selection", async ({ page }) => {
  await page.goto("/");
  await page.locator("#door-shot-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#list-viewport")).toBeFocused();
  expect(await rowRing(page, 0)).toContain("inset");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#list-viewport")).not.toHaveAttribute("data-first-ring");
});

test("the ring of the first row goes with a blur", async ({ page }) => {
  await page.goto("/");
  await page.locator("#door-shot-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#list-viewport")).toHaveAttribute("data-first-ring");
  await page.locator("#search-input").focus();
  await expect(page.locator("#list-viewport")).not.toHaveAttribute("data-first-ring");
});

/** Opens the sample with the keyboard, so that the first row has the ring. */
async function sampleWithRing(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("#door-shot-button").focus();
  await page.keyboard.press("Enter");
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#list-viewport")).toHaveAttribute("data-first-ring");
}

const selectedRowLabel = (page: Page) =>
  page.locator('#list-viewport [role=row][aria-selected="true"] [data-part="label"]');

for (const key of ["ArrowDown", "ArrowUp", "Home", "PageDown", "PageUp"]) {
  test(`${key} selects the first row while it has the ring`, async ({ page }) => {
    await sampleWithRing(page);
    await page.keyboard.press(key);
    await expect(selectedRowLabel(page)).toHaveText("debug/");
  });
}

test("End selects the last row while the first row has the ring", async ({ page }) => {
  await sampleWithRing(page);
  await page.keyboard.press("End");
  await expect(selectedRowLabel(page)).toHaveCount(1);
  await expect(selectedRowLabel(page)).not.toHaveText("debug/");
});

test("Enter selects the first row while it has the ring, and then opens it", async ({ page }) => {
  await sampleWithRing(page);
  await page.keyboard.press("Enter");
  await expect(page.locator("#location")).toContainText("debug");
});

test("ArrowRight selects the first row while it has the ring, and then expands it", async ({
  page,
}) => {
  await sampleWithRing(page);
  await page.keyboard.press("ArrowRight");
  await expect(selectedRowLabel(page)).toHaveText("debug/");
  await expect(
    page.locator("#list-viewport [data-part='label']", { hasText: "demo-app.debug" }),
  ).toHaveCount(2);
});

test("Space selects the first row while it has the ring, and then acts as on that row", async ({
  page,
}) => {
  await sampleWithRing(page);
  await page.keyboard.press(" ");
  await expect(selectedRowLabel(page)).toHaveText("debug/");
  await expect(page.locator("#panes")).toHaveAttribute("data-preview", "open");
});

for (const key of ["Alt+ArrowRight", "Alt+Enter"]) {
  test(`${key} selects no row while the first row has the ring`, async ({ page }) => {
    await sampleWithRing(page);
    await page.keyboard.press(key);
    // The wait is a part of the test: the key must not act in this time.
    await page.waitForTimeout(100);
    await expect(selectedRowLabel(page)).toHaveCount(0);
    await expect(page.locator("#list-viewport")).toHaveAttribute("data-first-ring");
  });
}

test("the sample opens at the root listing", async ({ page }) => {
  await page.goto("/");
  await mark(page);
  await page.locator("#door-shot-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#demo-label")).toHaveText(front.demo);
  await expect(page.locator("#health-panel")).toHaveCount(0);
  await expect(page.locator('#list-viewport [aria-selected="true"]')).toHaveCount(0);
  await expect(
    page.locator('#list-viewport [data-part="label"]', { hasText: "debug/" }).first(),
  ).toBeVisible();
  expect(await marked(page)).toBe(true);
});

test("the picture of the sample shows in the preview", async ({ page }) => {
  await page.goto("/");
  await page.locator("#door-shot-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await page.locator("#search-input").fill("demo-app.svg");
  const row = page.locator("#list-viewport [role=row]", { hasText: "demo-app.svg" }).first();
  await row.click();
  await page.keyboard.press("Enter");
  const picture = page.locator("#preview-pane img");
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(256);
});

test("the picture is busy while the sample is made, and a second click does no more", async ({
  page,
}) => {
  const gate = Promise.withResolvers<void>();
  await page.route("**/assets/sample-worker-*.js", async (route) => {
    await gate.promise;
    await route.continue();
  });
  await page.goto("/");
  await page.locator("#door-shot-button").click();
  await expect(page.locator("#door-shot-button")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#status")).toHaveText(front.making);
  // A second click starts no more work.
  await page.locator("#door-shot-button").click();
  await expect(page.locator("#door-shot-button")).toHaveAttribute("aria-busy", "true");
  gate.resolve();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator('#list-viewport [role=row][aria-selected="true"]')).toHaveCount(0);
});

test("a generator that fails says so, and the next try works", async ({ page }) => {
  // The generator rejects: the deflate of each entry throws.
  await page.route("**/assets/sample-worker-*.js", async (route) => {
    const response = await route.fetch();
    const script = await response.text();
    await route.fulfill({
      response,
      body: `globalThis.CompressionStream = class { constructor() { throw new Error("no"); } };${script}`,
    });
  });
  await page.goto("/");
  await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "true");
  await page.locator("#door-shot-button").click();
  await expect(page.locator("#status")).toHaveText(front.sampleFailed);
  await expect(page.locator("#door-shot-button")).not.toHaveAttribute("aria-busy", "true");
  // Only the two workers of the preload stay: the generator stopped.
  await expect.poll(() => page.workers().length).toBe(2);
  expect(page.workers().filter((worker) => worker.url().includes("sample-worker"))).toEqual([]);
  await page.unrouteAll();
  await page.locator("#door-shot-button").click();
  await expect(page.locator("#status")).not.toHaveText(front.sampleFailed);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
});

test("a worker that cannot start says so, and a file still opens", async ({ page }) => {
  await page.route("**/assets/sample-worker-*.js", (route) => route.abort("failed"));
  await page.goto("/");
  await page.locator("#door-shot-button").click();
  await expect(page.locator("#status")).toHaveText(front.sampleFailed);
  await expect(page.locator("#door-shot-button")).not.toHaveAttribute("aria-busy", "true");
  const path = test.info().outputPath("after.zip");
  writeFileSync(path, storedZip([["a/one.txt", 1]]));
  await openArchive(page, path);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
});

test("a file that is dropped before the app starts opens, with no navigation", async ({ page }) => {
  // Hold the entry module, so only the boot script runs.
  const gate = Promise.withResolvers<void>();
  await page.route("**/assets/index-*.js", async (route) => {
    await gate.promise;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "commit" });
  await page.locator("#door-work").waitFor();
  await mark(page);
  const bytes = [...storedZip([["early/one.txt", 3]])];
  const prevented = await page.locator("#door-work").evaluate((element, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(data)], "early.zip", { type: "application/zip" }));
    const over = new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    element.dispatchEvent(over);
    const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
    element.dispatchEvent(drop);
    return over.defaultPrevented && drop.defaultPrevented;
  }, bytes);
  expect(prevented).toBe(true);
  gate.resolve();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#archive-name")).toHaveText("early.zip");
  await expect(page.locator("#front-door")).toHaveCount(0);
  expect(await marked(page)).toBe(true);
  // The boot script keeps no reference to the file.
  expect(await page.evaluate(() => "zipscopeTakeDrop" in window)).toBe(false);
});

test("the first of two drops before the app starts wins, and a drop of text keeps nothing", async ({
  page,
}) => {
  const gate = Promise.withResolvers<void>();
  await page.route("**/assets/index-*.js", async (route) => {
    await gate.promise;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "commit" });
  await page.locator("#door-work").waitFor();
  await mark(page);
  const bytes = [...storedZip([["first/one.txt", 3]])];
  const prevented = await page.locator("#door-work").evaluate((element, data) => {
    const send = (name: string, text?: string) => {
      const transfer = new DataTransfer();
      if (text !== undefined) transfer.setData("text/plain", text);
      else transfer.items.add(new File([new Uint8Array(data)], name));
      const event = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return [send("", "only text"), send("first.zip"), send("second.zip")];
  }, bytes);
  expect(prevented).toEqual([true, true, true]);
  gate.resolve();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#archive-name")).toHaveText("first.zip");
  expect(await marked(page)).toBe(true);
});

test("a drop of text before the app starts opens nothing", async ({ page }) => {
  const gate = Promise.withResolvers<void>();
  await page.route("**/assets/index-*.js", async (route) => {
    await gate.promise;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "commit" });
  await page.locator("#door-work").waitFor();
  await page.locator("#door-work").evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "only text");
    element.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });
  gate.resolve();
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "first");
  await expect(page.locator("#archive-name")).toHaveCount(0);
});

test("a store that refuses a write does not stop a file", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("refused");
    };
  });
  await openSmall(page);
  // The wait is a part of the test: no error must come in this time.
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
});

test("the sample still extracts after its worker stopped", async ({ page }) => {
  // The pickers use the origin private file system.
  await page.addInitScript(() => {
    Object.assign(window, {
      showDirectoryPicker: async () =>
        (await navigator.storage.getDirectory()).getDirectoryHandle("out", { create: true }),
    });
  });
  await page.goto("/");
  await page.locator("#door-shot-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await page.getByRole("button", { name: "Extract this folder" }).click();
  await page.locator("#extract-confirm").click();
  await expect(page.locator("#extract-summary")).toContainText("880 of 880", { timeout: 60_000 });
  await expect(page.locator("#extract-summary")).toContainText("verified");
});

test("after a real file, a later visit gets the same page", async ({ page }) => {
  await openSmall(page);
  // A new visit: a new tab with no history entry of an archive.
  const next = await page.context().newPage();
  await next.goto("/");
  await expect(next.locator("#front-door")).toHaveAttribute("data-state", "first");
  await expect(next.locator("html")).toHaveAttribute("data-door", "first");
  for (const selector of ["#door-lead", "#door-shot-frame", "#door-bands", "#door-close"]) {
    await expect(next.locator(selector), selector).toBeVisible();
  }
  await expect(next.locator("#front-open")).toBeInViewport();
  await next.close();
});

test("a broken storage does not stop the door", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("blocked");
      },
    });
  });
  await page.goto("/");
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "first");
  await expect(page.locator("#door-bands")).toBeVisible();
});

test("the boot script hides the page before the first paint after a reload", async ({ page }) => {
  await openSmall(page);
  // Hold the entry module, so only the boot script and the CSS apply.
  await page.route("**/assets/index-*.js", () => {});
  await page.reload({ waitUntil: "commit" });
  await page.locator("#door-work").waitFor({ state: "attached" });
  await expect(page.locator("html")).toHaveAttribute("data-door", "resume");
  await expect(page.locator("#door-page")).toBeHidden();
});

test("a sample that is still in generation does not replace a file opened later", async ({
  page,
}) => {
  // Hold the sample generator, so the sample waits.
  const gate = Promise.withResolvers<void>();
  await page.route("**/assets/sample-*.js", async (route) => {
    await gate.promise;
    await route.continue();
  });
  await page.goto("/");
  const generator = page.waitForEvent("worker", (worker) =>
    worker.url().includes("/assets/sample-"),
  );
  await page.locator("#door-shot-button").click();
  const path = test.info().outputPath("later.zip");
  writeFileSync(path, storedZip([["later/one.txt", 1]]));
  await openArchive(page, path);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  gate.resolve();
  // The page stops the worker when it receives the sample. Then the file is
  // still open.
  await (await generator).waitForEvent("close");
  await expect(page.locator("#archive-name")).toHaveText("later.zip");
  await expect(page.locator("#demo-label")).toHaveCount(0);
});

test("a wrong file uses the error of the tool", async ({ page }) => {
  const path = test.info().outputPath("notes.txt");
  writeFileSync(path, "not a zip archive");
  await page.goto("/");
  await openArchive(page, path);
  const result = await waitForOutcome(page);
  expect(result.outcome).toBe("failed");
  expect(result.status).toContain("Cannot open");
});

async function openSmall(page: Page, name = "small.zip"): Promise<void> {
  const path = test.info().outputPath(name);
  writeFileSync(path, storedZip([["a/one.txt", 1]]));
  await page.goto("/");
  await openArchive(page, path);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
}

test("after Back, the door has Return and Open a file", async ({ page }) => {
  await openSmall(page);
  await page.goBack();
  const frontDoor = page.locator("#front-door");
  await expect(frontDoor).toHaveAttribute("data-state", "return");
  await expect(page.locator("#return-button")).toHaveText(front.returnTo("small.zip"));
  await expect(page.locator("#other-open")).toHaveText(front.openOther);
  // No poster, no offline line and nothing below the fold.
  for (const selector of ["#door-hero", "#front-test", "#door-bands"]) {
    await expect(page.locator(selector), selector).toHaveCount(0);
  }
  // The top bar does not show, and the door has the h1.
  await expect(page.locator("header")).toBeHidden();
  await expect(page.locator("#front-door h1")).toHaveText(HEADING);
  await page.locator("#return-button").click();
  await expect(frontDoor).toHaveCount(0);
  await expect(page.locator("header h1")).toHaveText("Zipscope");
});

test("after a reload of the demo, the reopen action makes the demo again", async ({ page }) => {
  await page.goto("/");
  await page.locator("#door-shot-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await page.reload();
  const reopen = page.locator("#reopen-button");
  await expect(reopen).toContainText("demo-app-2.4.0-release.zip");
  await expect(reopen).toContainText(front.demo);
  await reopen.click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#demo-label")).toHaveText(front.demo);
});

/** Counts the workers that the page starts, in `window.__workers`. */
async function countWorkers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as unknown as { __workers: number };
    state.__workers = 0;
    const Native = Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        state.__workers += 1;
      }
    };
  });
}

/** Checks the unsupported state, and that the app did not start. */
async function expectUnsupported(page: Page, reason: string): Promise<void> {
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "unsupported");
  await expect(page.locator("#unsupported-heading")).toHaveText(front.unsupported);
  await expect(page.locator("#unsupported-reason")).toHaveText(reason);
  await expect(page.locator("#unsupported")).toContainText(front.supportedBrowsers);
  await expect(page.locator("#door-shot-button")).toHaveCount(0);
  // The static page goes: its actions need a browser that can read a file.
  await expect(page.locator("#door-hero")).toHaveCount(0);
  await expect(page.locator("#door-frame")).toHaveCount(0);
  await expect(page.locator("#door-bands")).toHaveCount(0);
  await expect(page.locator("#door-close")).toHaveCount(0);
  await expect(page.locator("header h1")).toHaveText("Zipscope");
  // The app did not run: no tool, no file input, no status bar and no
  // worker preload. The app preloads its workers in idle time, so wait for
  // idle time.
  await page.evaluate(() => new Promise((resolve) => requestIdleCallback(resolve)));
  for (const selector of ["#file-input", "#status", "#search-slot"]) {
    await expect(page.locator(selector), selector).toHaveCount(0);
  }
  expect(await page.evaluate(() => (window as unknown as { __workers: number }).__workers)).toBe(0);
}

test("below the browser floor, the page says so and does not start the app", async ({ page }) => {
  await countWorkers(page);
  await page.addInitScript(() => {
    CSS.supports = () => false;
  });
  await page.goto("/");
  await expectUnsupported(page, front.unsupportedBrowser);
  await expect(page).toHaveTitle(`${front.unsupported} – Zipscope`);
  // The page names what is missing.
  await expect(page.locator("#unsupported-missing")).toContainText("CSS anchor positioning");
});

test("without cross-origin isolation, the page says so and does not start the app", async ({
  page,
}) => {
  await countWorkers(page);
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "crossOriginIsolated", { value: false });
  });
  await page.goto("/");
  await expectUnsupported(page, front.unsupportedIsolation);
  await expect(page.locator("#cross-origin-isolated")).toHaveText("false");
});

test("a supported browser preloads the app chunk with the entry module", async ({ page }) => {
  await page.goto("/");
  const preloads = await page
    .locator('link[rel="modulepreload"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
  expect(preloads.some((href) => /\/assets\/start-[\w-]+\.js$/.test(href))).toBe(true);
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "first");
});
