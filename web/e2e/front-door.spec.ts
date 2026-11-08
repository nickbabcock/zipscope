// The front door: the three questions in the served HTML, the answers, the
// connection reading, the demo archive and its "See it" controls, a drop that
// turns the page into the tool, and the states for returning visitors.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { door, front, SOURCE_URL } from "../src/front/strings.ts";
import { dropArchive, openArchive, waitForOutcome } from "./listing";
import { storedZip } from "./stored-zip";

const QUESTIONS = [door.contents.question, door.space.question, door.health.question];

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
  [1000, 800],
  [921, 800],
  [920, 800],
  [720, 800],
  [641, 800],
  [390, 844],
]) {
  test(`the first view has the questions and the actions at ${width} x ${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    const frontDoor = page.locator("#front-door");
    await expect(frontDoor).toHaveAttribute("data-state", "first");
    let previous = -1;
    for (const question of QUESTIONS) {
      const heading = page.getByRole("heading", { level: 2, name: question, exact: true });
      await expect(heading).toBeInViewport({ ratio: 1 });
      const box = (await heading.boundingBox())!;
      expect(box.y, question).toBeGreaterThan(previous);
      previous = box.y;
    }
    for (const selector of ["#see-contents", "#see-space", "#see-health"]) {
      await expect(page.locator(selector)).toHaveText(front.see);
      await expect(page.locator(selector)).toBeInViewport({ ratio: 1 });
    }
    await expect(page.locator("#door-action")).toHaveText(door.action.fine, { useInnerText: true });
    await expect(page.locator("#front-open")).toHaveText(front.open);
    await expect(page.locator("#sample-button")).toHaveText(front.sample);
    await expect(page.locator("#front-open")).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#sample-button")).toBeInViewport({ ratio: 1 });
    // The action line and the buttons are inside the row.
    const rowBox = (await page.locator("#door-row").boundingBox())!;
    for (const selector of ["#door-action", "#door-buttons"]) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(box.y, selector).toBeGreaterThanOrEqual(rowBox.y);
      expect(box.y + box.height, selector).toBeLessThanOrEqual(rowBox.y + rowBox.height);
    }
    // The rest of the page is not in the first view: it starts below the top
    // edge of the sticky row.
    const rest = (await page.getByRole("heading", { name: door.files.question }).boundingBox())!;
    expect(rest.y).toBeGreaterThan((await page.locator("#door-row").boundingBox())!.y);
    // The page scrolls inside the work area. The bars and the row stay.
    await page.locator("#door-close").scrollIntoViewIfNeeded();
    await expect(page.locator("#door-close")).toBeInViewport();
    await expect(page.locator("#front-open")).toBeInViewport({ ratio: 1 });
    await expect(page.locator("header")).toBeInViewport();
    await expect(page.locator("footer")).toBeInViewport();
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  });
}

for (const width of [1440, 390, 320]) {
  test(`the line beside the word mark fits at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await expect(page.locator("#front-door")).toBeVisible();
    const line = page.locator("header #door-tagline");
    await expect(line).toHaveText(door.tagline);
    await expect(line).toBeInViewport({ ratio: 1 });
    expect(await line.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}

test("the line beside the word mark is only on the first door", async ({ page }) => {
  await openSmall(page);
  await expect(page.locator("#door-tagline")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "return");
  await expect(page.locator("#door-tagline")).toHaveCount(0);
});

test("the rows have a label, and each name is near its size", async ({ page }) => {
  await page.goto("/");
  const rows = page.locator("#door-rows");
  await expect(rows.locator("caption")).toHaveText(door.space.rowsLabel);
  await expect(rows.locator("tr")).toHaveCount(door.space.rows.length);
  expect((await rows.boundingBox())!.width).toBeLessThanOrEqual(480);
  await expect(rows).toHaveCSS("cursor", "default");
  // A rule between rows, and none below the last.
  await expect(rows.locator("tr").last()).toHaveCSS("border-bottom-width", "0px");
});

test("the served HTML has the questions, the answers and the head tags", async ({ request }) => {
  const html = await (await request.get("/")).text();
  const text = html.replace(/<\/?(code|kbd|b)>/g, "");
  expect(html).toContain(`<h1 id="door-h1">${door.heading}</h1>`);
  // One label covers all three answers, before the first question, and each
  // answer says that it is for the sample.
  expect(html.indexOf('id="door-demo"')).toBeLessThan(html.indexOf("<h2"));
  expect(html.match(/class="door-tag"/g)).toHaveLength(1);
  expect(html.match(new RegExp(door.samplePrefix, "g"))).toHaveLength(3);
  // The hidden heading comes before all other headings.
  expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("<h2"));
  for (const part of [
    door.contents,
    door.space,
    door.files,
    door.reads,
    door.lies,
    door.inside,
    door.keyboard,
    ...door.formats,
  ]) {
    expect(html).toContain(`<h2>${part.question}</h2>`);
    expect(text).toContain(plain(part.answer));
  }
  expect(text).toContain(plain(door.device.answer));
  expect(html).toContain("<kbd>Backspace</kbd>");
  expect(html).toContain(`<a href="${SOURCE_URL}">`);
  expect(html).toContain(door.noScript);
  expect(html).toContain(door.tagline);
  expect(html).toContain("<title>What is in this zip? Zipscope, a zip viewer in your browser");
  expect(html).toContain('name="description"');
  expect(html).toContain('property="og:title"');
  expect(html).toContain('name="twitter:card"');
  expect(html).toContain('rel="icon"');
  // No origin in this build: these tags stay out.
  expect(html).not.toContain('rel="canonical"');
  expect(html).not.toContain("og:url");
  expect(html).not.toContain("og:image");
  // No inline style or script: the CSP blocks them.
  expect(html).not.toContain("<style");
  expect(html).not.toContain(" style=");
});

test("the first paint has the styles, with no script", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("#door-noscript")).toHaveText(door.noScript);
  const heading = page.getByRole("heading", { level: 2, name: door.contents.question });
  await expect(heading).toBeInViewport({ ratio: 1 });
  expect(await heading.evaluate((element) => getComputedStyle(element).fontWeight)).toBe("650");
  expect(await heading.evaluate((element) => getComputedStyle(element).fontFamily)).toContain(
    "system-ui",
  );
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
    await expect(page.locator("#door-questions")).toBeVisible();
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
  // The questions and the action line stay hidden in this state.
  await expect(page.locator("#door-questions")).toBeHidden();
  await expect(page.locator("#door-action")).toBeHidden();
  await expect(page.locator("#explainer")).toBeHidden();
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
  expect(levels.slice(1).every((level) => level === "H2")).toBe(true);
  await expect(page.locator("h1")).toHaveText(door.heading);
  await expect(page.locator("header h1")).toHaveCount(0);
});

test("the tab order follows the first view", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#see-contents")).toBeVisible();
  const order: (string | null)[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    order.push(
      await page.evaluate(
        () => document.activeElement?.id || document.activeElement?.tagName || null,
      ),
    );
  }
  expect(order).toEqual([
    "see-contents",
    "see-space",
    "see-health",
    "front-open",
    "sample-button",
    "A",
  ]);
});

test("the rest of the page shows below the first view", async ({ page }) => {
  await page.goto("/");
  const section = page.locator("#explainer");
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeVisible();
  await expect(section.locator("h2")).toHaveCount(13);
  // The first reference answer is the one about the device.
  await expect(section.locator("h2").first()).toHaveText(door.device.question);
  await expect(section.locator("a")).toHaveAttribute("href", SOURCE_URL);
  await expect(page.locator("#front-door #explainer")).toHaveCount(1);
  // The sticky row is the only action at the end of the page.
  await expect(page.locator("#door-close button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: front.open })).toHaveCount(1);
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
    // In the stacked row, the short line is directly above the buttons.
    if (width <= 920) {
      const line = (await page.locator('.door-line[data-line="dragging"]').boundingBox())!;
      expect(before!.y - (line.y + line.height)).toBeLessThanOrEqual(12);
    }
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
    await expect(page.locator("#see-contents")).toBeVisible();
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, 20_000);
    await expect
      .poll(() => page.locator("#front-door").evaluate((door) => door.scrollTop))
      .toBeGreaterThan(0);
    expect((await page.locator("header").boundingBox())!.y).toBe(0);
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
    await expect(page.locator("#sample-button")).toBeVisible();
    const widths = await page
      .locator("#front-door")
      .evaluate((door) => [door.scrollWidth, door.clientWidth]);
    expect(widths[0]).toBe(widths[1]);
    const button = (await page.locator("#sample-button").boundingBox())!;
    expect(button.x + button.width).toBeLessThanOrEqual(width);
  });
}

test("the sticky row does not cover the focus, and it stops in a low window", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#see-contents")).toBeVisible();
  // Tab to the link below the first view. The row does not cover it.
  await page.locator("#sample-button").focus();
  await page.keyboard.press("Tab");
  const link = (await page.locator("#explainer a").boundingBox())!;
  const row = (await page.locator("#door-row").boundingBox())!;
  expect(link.y + link.height).toBeLessThanOrEqual(row.y);
  // In a low window, the row is in the page, below the questions.
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator("#door-row")).toHaveCSS("position", "static");
  const questions = (await page.locator("#door-questions").boundingBox())!;
  const lowRow = (await page.locator("#door-row").boundingBox())!;
  const rest = (await page.locator("#explainer").boundingBox())!;
  expect(lowRow.y).toBeGreaterThanOrEqual(questions.y + questions.height - 1);
  expect(rest.y).toBeGreaterThanOrEqual(lowRow.y + lowRow.height - 1);
});

test("a coarse pointer gets a hit area of 44 px on each See it", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("#see-space")).toBeVisible();
  await expect(page.locator("#door-action")).toHaveText(door.action.coarse, { useInnerText: true });
  for (const id of ["see-contents", "see-space", "see-health"]) {
    const box = (await page.locator(`#${id}`).boundingBox())!;
    const x = box.x + box.width / 2;
    const top = box.y + box.height / 2 - 22;
    const hit = await page.evaluate(
      ([px, py]) => [
        document.elementFromPoint(px!, py!)?.id,
        document.elementFromPoint(px!, py! + 43)?.id,
      ],
      [x, top],
    );
    expect(hit, id).toEqual([id, id]);
  }
  await context.close();
});

test("each See it has its own accessible name, and it is a button", async ({ page }) => {
  await page.goto("/");
  for (const answer of ["contents", "space", "health"] as const) {
    await expect(page.getByRole("button", { name: front.seeNames[answer] })).toHaveText(front.see);
  }
});

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
  await page.locator("#sample-button").click();
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

for (const id of ["see-contents", "sample-button"]) {
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

test("Enter on see-space selects the space hog and moves the focus to the table", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#see-space").focus();
  await page.keyboard.press("Enter");
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#list-viewport")).toBeFocused();
  await expect(page.locator('#list-viewport [aria-selected="true"]')).toHaveAttribute(
    "data-block",
    "true",
  );
});

test("Enter on see-health moves the focus to the toggle of the health list", async ({ page }) => {
  await page.goto("/");
  await page.locator("#see-health").focus();
  await page.keyboard.press("Enter");
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#health-toggle")).toBeFocused();
  await expect(page.locator("#health-panel [data-finding]")).toHaveCount(2);
});

test("See it on the health answer does not take the focus from a visitor who moved it", async ({
  page,
}) => {
  // The visitor moves to the search field as soon as it shows.
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      const field = document.getElementById("search-input");
      if (field !== null) {
        field.focus();
        observer.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto("/");
  await page.locator("#see-health").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#health-panel [data-finding]")).toHaveCount(2);
  await expect(page.locator("#search-input")).toBeFocused();
});

test("a real file does not move the focus", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#see-contents")).toBeVisible();
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
  await expect(page.locator("#see-contents")).toBeVisible();
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
  await expect(page.locator("#see-contents")).toBeVisible();
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
  await page.locator("#sample-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#list-viewport")).toBeFocused();
  expect(await rowRing(page, 0)).toContain("inset");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#list-viewport")).not.toHaveAttribute("data-first-ring");
});

test("the ring of the first row goes with a blur", async ({ page }) => {
  await page.goto("/");
  await page.locator("#sample-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#list-viewport")).toHaveAttribute("data-first-ring");
  await page.locator("#search-input").focus();
  await expect(page.locator("#list-viewport")).not.toHaveAttribute("data-first-ring");
});

/** Opens the sample with the keyboard, so that the first row has the ring. */
async function sampleWithRing(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("#sample-button").focus();
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

test("See it opens the sample at the root listing", async ({ page }) => {
  await page.goto("/");
  await mark(page);
  await page.locator("#see-contents").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#demo-label")).toHaveText(front.demo);
  await expect(page.locator("#health-panel")).toHaveCount(0);
  await expect(page.locator('#list-viewport [aria-selected="true"]')).toHaveCount(0);
  await expect(
    page.locator('#list-viewport [data-part="label"]', { hasText: "debug/" }).first(),
  ).toBeVisible();
  expect(await marked(page)).toBe(true);
});

for (const [width, height] of [
  [1440, 900],
  [390, 844],
]) {
  test(`See it selects the space hog in the largest files at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.locator("#see-space").click();
    expect((await waitForOutcome(page)).outcome).toBe("complete");
    const selected = page.locator('#list-viewport [role=row][aria-selected="true"]');
    await expect(selected).toHaveAttribute("data-block", "true");
    await expect(selected.locator('[data-part="label"]')).toHaveText("debug/demo-app.debug");
    await expect(page.locator("#list-viewport")).toBeFocused();
    // The ring shows after the move, also after a pointer click.
    expect(
      await page.locator("#list-viewport").evaluate((el) => el.matches(":focus-visible")),
    ).toBe(true);
  });
}

for (const [width, height] of [
  [1280, 560],
  [800, 500],
  [390, 560],
]) {
  test(`See it selects the folder of the hog with no largest files at ${width} x ${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.locator("#see-space").click();
    expect((await waitForOutcome(page)).outcome).toBe("complete");
    const selected = page.locator('#list-viewport [role=row][aria-selected="true"]');
    await expect(selected.locator('[data-part="label"]')).toHaveText("debug/");
    await expect(page.locator("#list-viewport")).toBeFocused();
    // A later resize does not move the selection.
    await page.locator("#search-input").focus();
    await page.setViewportSize({ width, height: 900 });
    // The wait is a part of the test: the resize must not move the selection.
    await page.waitForTimeout(300);
    await expect(selected.locator('[data-part="label"]')).toHaveText("debug/");
    await expect(page.locator("#search-input")).toBeFocused();
  });
}

test("Back and Forward keep the hog selected after See it", async ({ page }) => {
  await page.goto("/");
  await page.locator("#see-space").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  const label = page.locator('#list-viewport [role=row][aria-selected="true"] [data-part="label"]');
  await expect(label).toHaveText("debug/demo-app.debug");
  await page.goBack();
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "return");
  // The wait is a part of the test: the hidden table must not move the selection.
  await page.waitForTimeout(200);
  await page.goForward();
  await expect(page.locator("#front-door")).toHaveCount(0);
  await expect(label).toHaveText("debug/demo-app.debug");
});

test("See it opens the health list", async ({ page }) => {
  await page.goto("/");
  await page.locator("#see-health").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#health-panel [data-finding]")).toHaveCount(2);
  await expect(page.locator("#health-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#health-toggle")).toBeFocused();
  expect(await page.locator("#health-toggle").evaluate((el) => el.matches(":focus-visible"))).toBe(
    true,
  );
});

test("the control that starts the sample is busy, and a second control takes its place", async ({
  page,
}) => {
  const gate = Promise.withResolvers<void>();
  await page.route("**/assets/sample-worker-*.js", async (route) => {
    await gate.promise;
    await route.continue();
  });
  await page.goto("/");
  await page.locator("#see-health").click();
  await expect(page.locator("#see-health")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#status")).toHaveText(front.making);
  // A second control takes its place and starts no more work.
  await page.locator("#see-space").click();
  await expect(page.locator("#see-health")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#see-space")).toHaveAttribute("aria-busy", "true");
  gate.resolve();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator('#list-viewport [role=row][aria-selected="true"]')).toHaveAttribute(
    "data-block",
    "true",
  );
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
  await page.locator("#sample-button").click();
  await expect(page.locator("#status")).toHaveText(front.sampleFailed);
  await expect(page.locator("#sample-button")).not.toHaveAttribute("aria-busy", "true");
  // Only the two workers of the preload stay: the generator stopped.
  await expect.poll(() => page.workers().length).toBe(2);
  expect(page.workers().filter((worker) => worker.url().includes("sample-worker"))).toEqual([]);
  await page.unrouteAll();
  await page.locator("#see-contents").click();
  await expect(page.locator("#status")).not.toHaveText(front.sampleFailed);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
});

test("a worker that cannot start says so, and a file still opens", async ({ page }) => {
  await page.route("**/assets/sample-worker-*.js", (route) => route.abort("failed"));
  await page.goto("/");
  await page.locator("#sample-button").click();
  await expect(page.locator("#status")).toHaveText(front.sampleFailed);
  await expect(page.locator("#sample-button")).not.toHaveAttribute("aria-busy", "true");
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

test("a file that does not open does not set the flag of the repeat visit", async ({ page }) => {
  const path = test.info().outputPath("notes.txt");
  writeFileSync(path, "not a zip archive");
  await page.goto("/");
  await openArchive(page, path);
  expect((await waitForOutcome(page)).outcome).toBe("failed");
  expect(await page.evaluate(() => localStorage.getItem("zipscope.door"))).toBeNull();
});

test("a store that refuses the flag does not stop a file", async ({ page }) => {
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
  await page.locator("#sample-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await page.getByRole("button", { name: "Extract this folder" }).click();
  await page.locator("#extract-confirm").click();
  await expect(page.locator("#extract-summary")).toContainText("879 of 879", { timeout: 60_000 });
  await expect(page.locator("#extract-summary")).toContainText("verified");
});

test("after a first real file, a later visit gets the compact door", async ({ page }) => {
  await page.goto("/");
  await page.locator("#sample-button").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  // The sample does not count.
  expect(await page.evaluate(() => localStorage.getItem("zipscope.door"))).toBeNull();

  await openSmall(page);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("zipscope.door")))
    .toBe("compact");
  // A new visit: a new tab with no history entry of an archive.
  const next = await page.context().newPage();
  await next.goto("/");
  await expect(next.locator("html")).toHaveAttribute("data-door", "compact");
  await expect(next.locator("#front-door")).toHaveAttribute("data-state", "first");
  await expect(next.locator("#door-questions")).toBeHidden();
  await expect(next.locator("#front-open")).toBeInViewport();
  await expect(next.locator("#sample-button")).toBeInViewport();
  await expect(next.locator("#door-action")).toHaveText(door.action.compact, {
    useInnerText: true,
  });
  await expect(next.locator("#door-row")).toHaveCSS("position", "static");
  await expect(next.locator("#explainer")).toBeVisible();
  // A drop still works.
  await next.locator("#front-open").waitFor();
  const path = test.info().outputPath("again.zip");
  writeFileSync(path, storedZip([["b/two.txt", 1]]));
  await openArchive(next, path);
  expect((await waitForOutcome(next)).outcome).toBe("complete");
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
  await expect(page.locator("#door-questions")).toBeVisible();
});

test("the boot script hides the questions before the first paint after a reload", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
  });
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
  await page.locator("#sample-button").click();
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
  await expect(page.locator("#compact-open")).toHaveText(front.open);
  // No questions, no offline line and nothing below the fold.
  for (const selector of ["#door-questions", "#front-test", "#explainer"]) {
    await expect(page.locator(selector), selector).toHaveCount(0);
  }
  // The word mark is a plain element, and the door has the h1.
  await expect(page.locator("header h1")).toHaveCount(0);
  await expect(page.locator("#front-door h1")).toHaveText(door.heading);
  await page.locator("#return-button").click();
  await expect(frontDoor).toHaveCount(0);
  await expect(page.locator("header h1")).toHaveText("Zipscope");
});

test("after a reload, the door offers to reopen the file", async ({ page }) => {
  // Without the File System Access picker (as in Firefox and Safari), the
  // reopen action opens the file input. reload.spec.ts has the picker.
  await page.addInitScript(() => {
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
  });
  await openSmall(page);
  await page.reload();
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "reopen");
  await expect(page.locator("#reopen-text")).toHaveText(front.reopen);
  await expect(page.locator("#reopen-button")).toHaveText("small.zip");
  await expect(page.locator("#compact-open")).toHaveText(front.open);
  await expect(page.locator("#door-questions")).toHaveCount(0);
  await expect(page.locator("#explainer")).toHaveCount(0);
  // The reopen action opens the file picker.
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#reopen-button").click();
  await (await chooser).setFiles(test.info().outputPath("small.zip"));
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#archive-name")).toHaveText("small.zip");
});

test("after a reload of the demo, the reopen action makes the demo again", async ({ page }) => {
  await page.goto("/");
  await page.locator("#sample-button").click();
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
  await expect(page.locator("#sample-button")).toHaveCount(0);
  // The sample answers go. The rest of the page stays. The close asks for a
  // file, so it goes too.
  await expect(page.locator("#door-questions")).toHaveCount(0);
  await expect(page.locator("#door-frame")).toHaveCount(0);
  await page.locator("#explainer").scrollIntoViewIfNeeded();
  await expect(page.locator("#explainer")).toBeVisible();
  await expect(page.locator("#door-close")).toBeHidden();
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
