// The Archive panel: the comment, the byte map with its hex
// view and save, the format facts, the totals, the link to the health
// list, the parts that hide when they are empty and the
// build in the footer. `node/archive-panel.test.ts` checks more facts,
// comments and byte maps with the real workers and wasm.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { apkSigningBlock, panelZip } from "./archive-zip";
import type { PanelZip } from "./archive-zip";
import { archives, openArchive, waitForOutcome } from "./listing";

const script = Buffer.from('#!/bin/sh\nexec unzip -o "$0" "$@"\n');

async function openPanel(page: Page, spec: PanelZip, name = "panel.zip", width = 1440) {
  const file = test.info().outputPath(name);
  const { bytes } = panelZip(spec);
  writeFileSync(file, bytes);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  if (width < 700) {
    await page.locator("#drawer-button").click();
  }
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
  await expect(page.locator("#archive-panel")).toBeVisible();
  return { bytes, result };
}

interface Row {
  kind: string;
  start: number;
  bytes: number;
  note: string;
}

/** The rows of the region list, with their exact offsets and sizes. */
async function regions(page: Page): Promise<Row[]> {
  await expect(page.locator("#byte-map-regions")).toBeVisible();
  return page.locator("#byte-map-regions tbody").evaluateAll((groups) =>
    groups.map((group) => {
      const cells = group.querySelectorAll("tr:first-child td");
      const exact = (cell: Element | undefined) =>
        Number((cell?.getAttribute("title") ?? "").replace(/[^\d]/g, ""));
      return {
        kind: group.getAttribute("data-kind") ?? "",
        // One column grid, so Size comes before
        // Offset.
        start: exact(cells[2]),
        bytes: exact(cells[1]),
        note: group.querySelector('[data-part="note"]')?.textContent ?? "",
      };
    }),
  );
}

test("the byte map accounts for each byte, with labels, hex and save", async ({ page }) => {
  const comment = Buffer.from("Release 1.2 — built on the build server");
  const { bytes } = await openPanel(page, {
    prelude: Buffer.concat([script, Buffer.alloc(100, 0x0a)]),
    entries: [
      { name: "a/one.txt", data: Buffer.from("one\n") },
      { name: "a/two.txt", data: Buffer.from("two two\n") },
    ],
    comment,
    epilogue: Buffer.from("TRAILING DATA"),
  });
  await expect(page.locator("#archive-comment-text")).toHaveText(comment.toString());
  await expect(page.locator("#archive-comment-encoding")).toHaveCount(0);

  const rows = await regions(page);
  expect(rows.map((row) => row.kind)).toEqual([
    "prelude",
    "entries",
    "directory",
    "end-record",
    "epilogue",
  ]);
  // Each region starts where the last one ended, and they end at the
  // file size.
  let at = 0;
  for (const row of rows) {
    expect(row.start).toBe(at);
    expect(row.bytes).toBeGreaterThan(0);
    at += row.bytes;
  }
  expect(at).toBe(bytes.length);
  expect(rows[0]!.note).toBe("Shell script prefix");
  expect(rows[0]!.bytes).toBe(script.length + 100);
  expect(rows[3]!.bytes).toBe(22 + comment.length);
  expect(rows[4]!.bytes).toBe(13);

  const prelude = page.locator('#byte-map-regions tbody[data-kind="prelude"]');
  await prelude.locator('[data-action="hex"]').click();
  const hex = prelude.locator('[data-part="hex"]');
  await expect(hex).toContainText("00000000  23 21 2f 62 69 6e 2f 73");
  await expect(prelude).toContainText(`All ${script.length + 100} B`);

  const epilogue = page.locator('#byte-map-regions tbody[data-kind="epilogue"]');
  const download = page.waitForEvent("download");
  await epilogue.locator('[data-action="save"]').click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("panel.epilogue.bin");
  expect(readFileSync(await saved.path()).toString()).toBe("TRAILING DATA");

  // The footer names the build.
  const sha = (
    process.env.ZIPSCOPE_BUILD_SHA ??
    process.env.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" })
  )
    .trim()
    .slice(0, 12);
  await expect(page.locator("#archive-build")).toHaveText(`Zipscope build ${sha}`);
});

test("gaps, an APK signing block and a hidden entry show as labeled gaps", async ({ page }) => {
  const hidden = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40, 0x41)]);
  const block = apkSigningBlock(300);
  const { bytes } = await openPanel(page, {
    entries: [
      { name: "classes.dex", data: Buffer.alloc(64, 1), after: hidden },
      { name: "AndroidManifest.xml", data: Buffer.alloc(32, 2) },
    ],
    beforeDirectory: block,
  });
  const rows = await regions(page);
  expect(rows.map((row) => row.kind)).toEqual([
    "entries",
    "gap",
    "entries",
    "gap",
    "directory",
    "end-record",
  ]);
  expect(rows[1]).toMatchObject({
    bytes: hidden.length,
    note: "A local header that no entry lists",
  });
  expect(rows[3]).toMatchObject({ bytes: block.length, note: "APK signing block" });
  expect(rows.reduce((sum, row) => sum + row.bytes, 0)).toBe(bytes.length);
  await expect(page.locator("#byte-map-summary")).toContainText(
    `2 gaps hold ${hidden.length + block.length} B`,
  );
  // A gap can show in hex too.
  const gap = page.locator("#byte-map-regions tbody").nth(1);
  await gap.locator('[data-action="hex"]').click();
  await expect(gap.locator('[data-part="hex"]')).toContainText("50 4b 03 04");
});

test("the format facts flag counts that differ and a spanned archive", async ({ page }) => {
  await openPanel(page, {
    entries: [
      { name: "x.txt", data: Buffer.from("x") },
      { name: "y.txt", data: Buffer.from("y") },
    ],
    declared: 7,
    disk: 1,
    directoryDisk: 1,
  });
  const entries = page.locator('#archive-format [data-fact="entries"] dd');
  await expect(entries).toHaveText("7 declared, 2 found");
  await expect(entries).toHaveAttribute("data-level", "warning");
  const disks = page.locator('#archive-format [data-fact="disks"] dd');
  await expect(disks).toContainText("spanned archive");
  await expect(disks).toHaveAttribute("data-level", "error");
  // The panel has no list of findings any more: the
  // spanned archive is the error of the Disks fact, and the count
  // mismatch is in the health list, which the one link of the panel opens.
  await expect(page.locator("#archive-health-link")).toHaveText(
    "Show 1 finding in the health list",
  );
  await page.locator("#archive-health-link").click();
  await expect(page.locator('#health-panel [data-finding="count-mismatch"]')).toBeVisible();
});

test("the method table shows before the byte map", async ({ page }) => {
  // The map reads the local headers, in windows of at most 8 KiB. The totals
  // pass reads nothing. A sleep on each such read holds only the map.
  await page.route(/\/assets\/worker-[\w-]+\.js$/, async (route) => {
    const response = await route.fetch();
    const slow = `
      const nativeRead = FileReaderSync.prototype.readAsArrayBuffer;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      FileReaderSync.prototype.readAsArrayBuffer = function (blob) {
        if (blob.size <= 8192) Atomics.wait(sleeper, 0, 0, 20);
        return nativeRead.call(this, blob);
      };
    `;
    await route.fulfill({ response, body: slow + (await response.text()) });
  });
  const entries = Array.from({ length: 300 }, (_, index) => ({
    name: `e/${index}`,
    data: Buffer.alloc(1024),
    method: index % 3,
  }));
  await openPanel(page, { entries }, "held-map.zip");
  await expect(page.locator("#archive-methods tbody tr")).toHaveCount(3);
  const map = page.locator("#archive-map");
  await expect(map).not.toContainText("Each byte of the");
  await expect(map).toContainText("Each byte of the", { timeout: 30_000 });
});

test("the totals break down by method, encryption and creating system", async ({ page }) => {
  await openPanel(page, {
    entries: [
      { name: "unix.txt", data: Buffer.alloc(10, 1), madeBy: 0x0314 },
      { name: "dos.txt", data: Buffer.alloc(20, 2), madeBy: 0x0014 },
      { name: "ntfs.txt", data: Buffer.alloc(30, 3), madeBy: 0x0a14 },
    ],
  });
  await expect(page.locator('#archive-totals [data-total="entries"]')).toHaveText("3");
  await expect(page.locator('#archive-totals [data-total="uncompressed"]')).toHaveText("60 B");
  // A no-break space joins a number and its unit.
  await expect(page.locator("#archive-methods tbody tr")).toHaveText([
    /^Stored\s*3\s*60\sB\s*60\sB$/,
  ]);
  // No entry is encrypted, so the panel has no encryption breakdown
  // (not a row that says "None 100%").
  await expect(page.locator("#archive-encryption")).toHaveCount(0);
  await expect(page.locator('#archive-format [data-fact="encryption"] dd')).toHaveCount(0);
  await expect(page.locator('#archive-format [data-fact="system"] dd')).toHaveCount(0);
  // Groups with the same count are in the order of their codes.
  await expect(page.locator("#archive-systems tbody tr td:first-child")).toHaveText([
    "MS-DOS (FAT)",
    "Unix",
    "Windows (NTFS)",
  ]);
});

test("the panel links to the health list, and a finding links to its entry", async ({ page }) => {
  // A prelude, and an entry with a bomb-like ratio (an example row).
  const file = test.info().outputPath("links.zip");
  const { bytes } = panelZip({
    prelude: Buffer.from("MZ stub"),
    entries: [{ name: "docs/readme.txt", data: Buffer.from("hello") }],
  });
  // Make the central directory claim a large uncompressed size: the ratio
  // rule needs at least 16 MiB.
  const record = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(20_000_000, record + 24);
  writeFileSync(file, bytes);
  await page.goto("/");
  await openArchive(page, file);
  await waitForOutcome(page);
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();

  // The Health section of the panel is one link
  // to the health list, in place of a second list of the findings.
  await expect(page.locator("#archive-health [data-finding]")).toHaveCount(0);
  const link = page.locator("#archive-health-link");
  await expect(link).toHaveText("Show 2 findings in the health list");
  await expect(page.locator("#health-panel")).toHaveCount(0);
  await link.click();
  await expect(page.locator("#health-panel")).toBeVisible();
  await expect(page.locator("#health-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('#health-panel [data-finding="prelude"]')).toBeVisible();
  // The "Show entry" link of a finding with an example is in the list.
  await expect(page.locator('#health-panel [data-finding="prelude"] button')).toHaveCount(0);
  const bomb = page.locator('#health-panel [data-finding="bomb-ratio"]');
  await expect(bomb).toContainText("For example: docs/readme.txt");
  await bomb.locator('[data-action="show-entry"]').click();
  await expect(page.locator('#preview-meta [data-field="path"]')).toHaveText("docs/readme.txt");
  await expect(page.locator("#archive-panel")).toHaveCount(0);
});

test("the panel fits the narrow layout", async ({ page }) => {
  await openPanel(
    page,
    {
      prelude: script,
      entries: [{ name: "a/b/c.txt", data: Buffer.from("c") }],
      epilogue: Buffer.alloc(10),
    },
    "narrow.zip",
    390,
  );
  await expect(page.locator("#preview-back")).toBeVisible();
  await expect(page.locator("#byte-map-regions")).toBeVisible();
  // The hex view scrolls in its own box.
  const prelude = page.locator('#byte-map-regions tbody[data-kind="prelude"]');
  await prelude.locator('[data-action="hex"]').click();
  await expect(prelude.locator('[data-part="hex"]')).toContainText("00000000");
  const overflow = await page.evaluate(() => {
    const pane = document.getElementById("preview-pane")!;
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      table: document.getElementById("byte-map-regions")!.scrollWidth - pane.clientWidth,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.table).toBeLessThanOrEqual(0);
});

test("a stopped listing maps its rows and shows the rest as a gap", async ({ page }) => {
  // A 12 MiB soft budget pauses after the first batch (see health.spec.ts).
  await page.addInitScript(() => {
    (globalThis as { __zipscopeTestBudget?: unknown }).__zipscopeTestBudget = {
      soft: 12 * 2 ** 20,
      hard: 2 ** 31,
    };
  });
  await page.goto("/");
  const file = path.join(archives, "2000.zip");
  await openArchive(page, file);
  await expect(page.locator("#budget-prompt")).toBeVisible();
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
  // While the prompt waits, the facts show, and the map waits.
  await expect(page.locator("#archive-map")).toContainText(
    "The byte map shows when the listing ends.",
  );
  await expect(page.locator('#archive-format [data-fact="entries"] dd')).toContainText(
    "2,000 declared",
  );
  await page.locator("#budget-stop").click();
  const result = await waitForOutcome(page);
  expect(result.outcome).toBe("cancelled");
  const rows = await regions(page);
  expect(rows.map((row) => row.kind)).toEqual(["entries", "gap", "directory", "end-record"]);
  expect(rows.reduce((sum, row) => sum + row.bytes, 0)).toBe(statSync(file).size);
  await expect(page.locator("#archive-map")).toContainText("The listing is partial");
  await expect(page.locator('#archive-totals [data-total="entries"]')).toHaveText(
    result.rows.toLocaleString("en"),
  );
  await expect(page.locator('#archive-format [data-fact="entries"] dd')).toContainText(
    "did not read the whole central directory",
  );
});

test("after the preload, the Archive panel opens without the network", async ({
  page,
  context,
}) => {
  const file = test.info().outputPath("offline.zip");
  writeFileSync(
    file,
    panelZip({ prelude: script, entries: [{ name: "a.txt", data: Buffer.from("a") }] }).bytes,
  );
  await page.goto("/");
  await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "true");
  await context.setOffline(true);
  await openArchive(page, file);
  await waitForOutcome(page);
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
  await expect(page.locator('#byte-map-regions tbody[data-kind="prelude"]')).toContainText(
    "Shell script prefix",
  );
});

test("an archive from Python zipfile with force_zip64 shows zip64", async ({ page }) => {
  // The bytes that Python 3 `zipfile` writes for two entries ("abc" and an
  // empty one) with `force_zip64=True`: local size markers and local zip64
  // fields, a 32-bit central directory and no zip64 end record.
  const bytes = Buffer.from(
    "504b03042d000000000000002100c2412435ffffffffffffffff05001400612e7478740100100003000000000000000300000000000000616263504b03042d00000000000000210000000000ffffffffffffffff05001400652e7478740100100000000000000000000000000000000000504b01022d032d000000000000002100c24124350300000003000000050000000000000000000000800100000000612e747874504b01022d032d00000000000000210000000000000000000000000005000000000000000000000080013a000000652e747874504b0506000000000200020066000000710000000000",
    "hex",
  );
  const file = test.info().outputPath("force-zip64.zip");
  writeFileSync(file, bytes);
  await page.goto("/");
  await openArchive(page, file);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
  await expect(page.locator('#archive-format [data-fact="zip64"] dd')).toHaveText(
    "Yes. 2 entries use zip64 fields; the end record has no zip64 record.",
  );
  // A layout of entries, the central directory and the end record is one
  // sentence, with no bar and no region list.
  await expect(page.locator("#byte-map-plain")).toBeVisible();
  await expect(page.locator("#byte-map-regions")).toHaveCount(0);
});

test("a hostile archive with 65,535 methods and gaps keeps the panel small and fast", async ({
  page,
}) => {
  // Each breakdown shows 10 groups and one
  // "other" row; the region list holds at most 257 gaps.
  const entries = Array.from({ length: 65_535 }, (_, index) => ({
    name: `e/${index}`,
    data: Buffer.alloc(0),
    method: index + 1,
    madeBy: (index % 256) << 8,
    after: Buffer.from([0x21]),
  }));
  const { bytes } = await openPanel(page, { entries }, "methods.zip");
  expect(bytes.length).toBeGreaterThan(3 * 2 ** 20);
  await page.evaluate(() => {
    (window as { __long?: number[] }).__long = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        (window as unknown as { __long: number[] }).__long.push(entry.duration);
      }
    }).observe({ type: "longtask" });
  });
  // Open the panel again, so that the observer sees its render.
  await page.locator("#preview-close").click();
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
  const methods = page.locator("#archive-methods");
  await expect(methods.locator("tbody tr")).toHaveCount(10);
  await expect(methods.locator('[data-part="other"]')).toContainText("65,525 other methods");
  await expect(page.locator("#archive-systems tbody tr")).toHaveCount(10);
  await expect(page.locator("#archive-systems [data-part='other']")).toContainText(
    "246 other systems",
  );
  await expect(page.locator("#byte-map-regions tbody[data-kind='gap']")).toHaveCount(257);
  const nodes = await page
    .locator("#archive-panel")
    .evaluate((panel) => panel.querySelectorAll("*").length);
  expect(nodes).toBeLessThan(10_000);
  const longest = await page.evaluate(() =>
    Math.max(0, ...((window as { __long?: number[] }).__long ?? [])),
  );
  test.info().annotations.push({
    type: "measure",
    description: `${nodes} nodes, longest task ${longest} ms`,
  });
  expect(longest).toBeLessThan(500);
  // More groups come in pages of 50, and the rows still add up.
  await methods.locator('[data-action="more-groups"]').click();
  await expect(methods.locator("tbody tr")).toHaveCount(60);
  await expect(methods.locator('[data-part="other"]')).toContainText("65,475 other methods");
});

test("the Archive panel of the sample has the Demo marker", async ({ page }) => {
  await page.goto("/");
  await page.locator("#door-shot-button").click();
  await waitForOutcome(page);
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
  // The DEMO tag shows
  // once, in the top bar, so the note of the panel has no tag.
  await expect(page.locator("#archive-demo")).toContainText("synthetic archive");
  // A file that is not the sample has no marker.
  await openPanel(page, { entries: [{ name: "a.txt", data: Buffer.from("a") }] });
  await expect(page.locator("#archive-demo")).toHaveCount(0);
});

test("an archive with no comment has no Comment section", async ({ page }) => {
  // The panel hides what is empty.
  await openPanel(page, { entries: [{ name: "a.txt", data: Buffer.from("a") }] });
  await expect(page.locator("#archive-format")).toBeVisible();
  await expect(page.locator("#archive-comment")).toHaveCount(0);
  await expect(page.locator("#archive-panel")).not.toContainText("no comment");
});

test("a breakdown with one group is one fact of the totals", async ({ page }) => {
  // One system and one encryption kind give no table.
  await openPanel(page, {
    entries: [
      { name: "a.txt", data: Buffer.alloc(10, 1), madeBy: 0x0a14, flags: 1 },
      { name: "b.txt", data: Buffer.alloc(20, 2), madeBy: 0x0a14, flags: 1 },
    ],
  });
  await expect(page.locator('#archive-format [data-fact="system"] dd')).toHaveText(
    "Windows (NTFS)",
  );
  await expect(page.locator('#archive-format [data-fact="encryption"] dd')).toHaveText("ZipCrypto");
  await expect(page.locator("#archive-systems")).toHaveCount(0);
  await expect(page.locator("#archive-encryption")).toHaveCount(0);
  // The methods keep their table: it also gives the compressed sizes.
  await expect(page.locator("#archive-methods tbody tr")).toHaveCount(1);
});

test("an archive with no entries has no empty breakdown tables", async ({ page }) => {
  await openPanel(page, { entries: [] });
  await expect(page.locator('#archive-totals [data-total="entries"]')).toHaveText("0");
  await expect(page.locator("#archive-totals table")).toHaveCount(0);
  await expect(page.locator('#archive-format [data-fact="system"] dd')).toHaveCount(0);
});

test("the Format section does not repeat the places of the byte map", async ({ page }) => {
  // The region list gives the central directory and the
  // end record.
  await openPanel(page, { entries: [{ name: "a.txt", data: Buffer.from("a") }] });
  const ids = await page
    .locator("#archive-format [data-fact]")
    .evaluateAll((facts) => facts.map((fact) => fact.getAttribute("data-fact")));
  // System is a fact of this section.
  expect(ids).toEqual(["zip64", "disks", "entries", "system"]);
});

test("the totals show at once, and the parse has ended when the panel says so", async ({
  page,
}) => {
  await openPanel(page, {
    entries: [
      { name: "a.txt", data: Buffer.alloc(10, 1) },
      { name: "b.txt", data: Buffer.alloc(20, 2) },
    ],
  });
  await expect(page.locator('#archive-totals [data-total="entries"]')).toHaveText("2");
  await expect(page.locator("#archive-format")).toContainText("2 found");
  await expect(page.locator("#archive-format")).not.toContainText("listed so far");
  // The waiting line is only in Byte map, and the section is not busy after it.
  await expect(page.locator("#archive-totals")).not.toContainText("Mapping");
  await expect(page.locator("#archive-map:not([aria-busy])")).toBeVisible();
});
