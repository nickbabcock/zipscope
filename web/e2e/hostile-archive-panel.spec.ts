/*
ASSUMED API
Keep #archive-panel as the panel root.
Add these test selectors. The implementer can change the names.
  #archive-comment: the decoded archive comment as text
  #archive-totals [data-field="ratio"]: the overall ratio
  #archive-build: the build git SHA, in text or in title
  #archive-regions [data-kind="prelude"|"gap"|"epilogue"]:
      data-offset and data-size as exact decimal byte counts
      a button with an accessible name "View <region> hex" (it names
      its region)
      a button with an accessible name "Extract <region>" (as above)
  #archive-region-hex: the selected region as hex
  #archive-health [data-finding="<existing finding id>"]:
      a button or a link that opens that finding in #health-panel
      One link, #archive-health-link, opens
      #health-panel with all findings.

Use the existing formatRatio convention: compressed / uncompressed.
Show a dash for an empty archive. Do not average entry ratios.
The build SHA comes from the build, not from the archive or file name.
*/
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { panelZip } from "./panel-zip";
import type { PanelEntry, PanelZipOptions } from "./panel-zip";
import { openArchive, root, waitForOutcome } from "./listing";

async function open(
  page: Page,
  entries: PanelEntry[],
  options: PanelZipOptions = {},
  name = "panel.zip",
) {
  const fixture = panelZip(entries, options);
  const file = test.info().outputPath(name);
  writeFileSync(file, fixture.bytes);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openArchive(page, file);
  const outcome = await waitForOutcome(page);
  expect(outcome.outcome, outcome.status).toBe("complete");
  await page.locator("#location button").first().click();
  await expect(page.locator("#archive-panel")).toBeVisible();
  return fixture;
}

test("archive comments stay text and use UTF-8 or CP437", async ({ page }) => {
  const html =
    '<img id="archive-injected" src=x onerror="window.__archivePwned=1"><script>window.__archivePwned=2</script>';
  await open(page, [{ name: "a", body: Buffer.alloc(0), flags: 0x800 }], {
    comment: Buffer.from(`caf\x82 ${html}`, "latin1"),
  });
  // #archive-comment is the section, with its title;
  // the decoded text is #archive-comment-text.
  const comment = page.locator("#archive-comment-text");
  await expect(comment).toHaveText(`café ${html}`);
  await expect(page.locator("#archive-injected")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as { __archivePwned?: number }).__archivePwned),
  ).toBeUndefined();

  const next = test.info().outputPath("utf8.zip");
  writeFileSync(next, panelZip([], { comment: Buffer.from("日本語 café") }).bytes);
  await openArchive(page, next);
  await waitForOutcome(page);
  await page.locator("#location button").first().click();
  await expect(comment).toHaveText("日本語 café");
  await expect(comment).not.toContainText("<img");
});

test("unaccounted regions show absolute offsets and extract the exact raw bytes", async ({
  page,
}) => {
  const fixture = await open(page, [{ name: "a", body: Buffer.from("entry bytes") }], {
    prelude: Buffer.from([0x00, 0xff, 0x50, 0x4b, 0x03, 0x04]),
    gap: Buffer.from([0x01, 0x00, 0xfe, 0x47, 0x41, 0x50]),
    comment: Buffer.from("not part of the tail"),
    epilogue: Buffer.from([0x02, 0x00, 0xfd, 0x54, 0x41, 0x49, 0x4c]),
  });
  for (const kind of ["prelude", "gap", "epilogue"] as const) {
    const expected = fixture.ranges[kind];
    // The region list is #byte-map-regions, one tbody
    // for each region.
    const row = page.locator(`#byte-map-regions tbody[data-kind="${kind}"]`);
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-offset", String(expected.offset));
    await expect(row).toHaveAttribute("data-size", String(expected.bytes.length));
    await row.getByRole("button", { name: /^View .* hex$/ }).click();
    // Each region row has its own hex view, so the
    // views of earlier rows can stay open; take the view of this row.
    const hex = row.locator('[data-part="hex"]');
    await expect(hex).toBeVisible();
    const firstBytes = Array.from(expected.bytes.subarray(0, 3), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(" ");
    await expect(hex).toContainText(firstBytes);
    const pending = page.waitForEvent("download");
    await row.getByRole("button", { name: /^Extract / }).click();
    const download = await pending;
    expect(await download.failure()).toBeNull();
    const path = await download.path();
    expect(path).not.toBeNull();
    expect(readFileSync(path!)).toEqual(expected.bytes);
  }
});

test("the Archive panel links to the list of every existing health finding", async ({ page }) => {
  await open(
    page,
    [
      // The ratio rule needs at least 16 MiB, so
      // the claimed size is 16 MiB in place of 1,001 bytes.
      { name: "same", body: Buffer.from("a"), size: 2 ** 24, flags: 1 },
      { name: "same", body: Buffer.from("b") },
    ],
    {
      declared: 9,
      prelude: Buffer.from("prefix"),
      epilogue: Buffer.from("tail"),
    },
  );
  // Read the ids from the health panel. This also covers new findings.
  await page.locator("#health-toggle").click();
  await expect(page.locator("#health-panel")).toBeVisible();
  const ids = await page
    .locator("#health-panel [data-finding]")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-finding")!));
  for (const id of [
    "count-mismatch",
    "bomb-ratio",
    "duplicate-names",
    "prelude",
    "epilogue",
    "encrypted",
  ]) {
    expect(ids).toContain(id);
  }
  await page.locator("#health-toggle").click();
  // The Archive panel has one link to the health
  // list, not one link for each finding. The link opens the list with
  // every finding.
  await expect(page.locator("#health-panel")).toBeHidden();
  const link = page.locator("#archive-health-link");
  await expect(link).toHaveText(`Show ${ids.length} findings in the health list`);
  await link.click();
  for (const id of ids) {
    await expect(page.locator(`#health-panel [data-finding="${id}"]`)).toBeVisible();
  }
});

test("the footer identifies the build when the archive contains a false SHA", async ({ page }) => {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const fake = sha.startsWith("deadbee")
    ? "0000000000000000000000000000000000000000"
    : "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  await open(
    page,
    [{ name: fake, body: Buffer.alloc(0) }],
    {
      comment: Buffer.from(`Build ${fake}`),
      epilogue: Buffer.from(fake),
    },
    `${fake}.zip`,
  );
  const build = page.locator("#archive-build");
  await expect(build).toBeVisible();
  const text = `${await build.textContent()} ${await build.getAttribute("title")}`;
  expect(text).toMatch(new RegExp(sha.slice(0, 7), "i"));
  expect(text).not.toContain(fake);
});
