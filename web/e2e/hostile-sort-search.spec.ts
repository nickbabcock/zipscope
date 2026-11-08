import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { waitForOutcome, LISTING_ROWS } from "./listing";
import { gate, pauseBetweenBatches } from "./parse-gate";

interface Entry {
  name: string;
  size?: number;
  compressed?: number;
  method?: number;
  modified?: number;
}

// The local headers have no data. The directory has inspection metadata.
function archive(entries: Entry[], badRow?: number): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [row, entry] of entries.entries()) {
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name);
    const extra = Buffer.alloc(entry.modified === undefined ? 0 : 9);
    if (entry.modified !== undefined) {
      extra.writeUInt16LE(0x5455);
      extra.writeUInt16LE(5, 2);
      extra[4] = 1;
      extra.writeUInt32LE(entry.modified, 5);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(row === badRow ? 0x02034b50 : 0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.method ?? 0, 10);
    central.writeUInt32LE(entry.compressed ?? 0, 20);
    central.writeUInt32LE(entry.size ?? 0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name, extra);
    offset += local.length + name.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function open(page: Page, entries: Entry[], badRow?: number) {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "sort-search.zip",
    mimeType: "application/zip",
    buffer: archive(entries, badRow),
  });
  return waitForOutcome(page);
}

const rows = (page: Page) => page.locator(LISTING_ROWS);
const names = (page: Page) =>
  rows(page)
    .locator('[data-part="label"]')
    .evaluateAll((labels) => labels.map((label) => (label as HTMLElement).title));

test("slash focuses search and Escape restores the folder after global results", async ({
  page,
}) => {
  const outcome = await open(page, [
    { name: "selected/other" },
    { name: "hidden/needle/" },
    { name: "hidden/needle/child" },
    { name: "needle" },
    { name: "needle" },
  ]);
  expect(outcome.outcome).toBe("complete");
  const selected = page.locator('#tree-viewport [role="treeitem"]').filter({ hasText: "selected" });
  await selected.locator('[data-part="label"]').click();
  await expect.poll(() => names(page)).toEqual(["selected/other"]);
  await page.keyboard.press("/");
  const search = page.getByRole("searchbox");
  await expect(search).toBeFocused();
  await search.fill("nEeDlE");
  await expect
    .poll(async () => (await names(page)).sort())
    .toEqual(["hidden/needle/", "hidden/needle/child", "needle", "needle"]);
  expect(
    await rows(page).evaluateAll((elements) =>
      elements.every((row) => (row as HTMLElement).dataset.kind === "entry"),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect.poll(() => names(page)).toEqual(["selected/other"]);
});

test("search and sort still work after a terminal directory error", async ({ page }) => {
  const outcome = await open(
    page,
    [{ name: "z-hit" }, { name: "a-hit" }, { name: "bad-hit" }, { name: "tail-hit" }],
    2,
  );

  expect(outcome.outcome).toBe("failed");
  expect(outcome.rows).toBe(2);
  const search = page.getByRole("searchbox");
  await search.fill("tail");
  await expect(rows(page)).toHaveCount(0);
  await search.fill("HIT");
  await expect.poll(async () => (await names(page)).sort()).toEqual(["a-hit", "z-hit"]);
  // Archive order is z-hit, a-hit. Wait for each sorted result before
  // the next click, so that no order is read before its sort arrives.
  const header = page.getByRole("columnheader", { name: "Name", exact: true });
  await header.click();
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  await expect.poll(() => names(page)).toEqual(["a-hit", "z-hit"]);
  await header.click();
  await expect(header).toHaveAttribute("aria-sort", "descending");
  await expect.poll(() => names(page)).toEqual(["z-hit", "a-hit"]);
});

test("search and sort run between batches and the last batch is sorted", async ({ page }) => {
  await pauseBetweenBatches(page);
  const count = 2049;
  const entries = Array.from({ length: count }, (_, i) => ({
    name: `${i % 2 === 0 ? "needle" : "other"}-${String((i * 73 + 913) % count).padStart(4, "0")}`,
  }));
  await page.goto("/");
  // An archive gets the preloaded parse worker only
  // after its wasm loaded.
  await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "true");
  await page.locator("#file-input").setInputFiles({
    name: "during-parse.zip",
    mimeType: "application/zip",
    buffer: archive(entries),
  });
  await expect.poll(() => gate(page)).toBe(1);
  await gate(page, true);
  await expect.poll(() => gate(page)).toBe(2);
  await expect(page.locator("#row-count")).not.toHaveText("0");
  const parsed = Number((await page.locator("#row-count").textContent())!.replaceAll(",", ""));
  expect(parsed).toBeGreaterThan(0);
  expect(parsed).toBeLessThan(count);
  const search = page.getByRole("searchbox");
  await search.fill("NEEDLE");
  const table = page.locator("#list-viewport");
  await expect(table).toHaveAttribute("aria-rowcount", String(Math.ceil(parsed / 2) + 1));
  await expect
    .poll(async () => {
      const shown = await names(page);
      return shown.length > 1 && shown.every((name) => name.startsWith("needle"));
    })
    .toBe(true);
  const before = await names(page);
  // No next batch can run while these requests are pending.
  await page.getByRole("columnheader", { name: "Name", exact: true }).click();
  await expect(page.getByText(/sorting/i).first()).toBeVisible();
  const ascending = entries
    .slice(0, parsed)
    .filter((entry) => entry.name.startsWith("needle"))
    .map((entry) => entry.name)
    .sort();
  await expect
    .poll(async () => {
      const shown = await names(page);
      return (
        shown.length > 1 &&
        JSON.stringify(shown) !== JSON.stringify(before) &&
        [ascending, [...ascending].reverse()].some((order) =>
          shown.every((name, index) => name === order[index]),
        )
      );
    })
    .toBe(true);
  const descending = (await names(page))[0] === ascending.at(-1);
  expect(await gate(page)).toBe(2);
  // Release steps until the listing
  // completes. Before, the loop released at most eight steps. The gate
  // holds each self-ping: the batches, and also the merge and check steps.
  // The batch size and the merge interval come from the clock, so under
  // load the 2,049 rows need more steps (at 64 rows for each batch, 33
  // batches). The bound only stops a loop that does not go forward. The
  // expectations of the test do not change.
  for (let batch = 0; batch < 256; batch++) {
    if ((await page.locator("#status").textContent())?.includes("Listed in")) break;
    const waits = await gate(page, true);
    await expect
      .poll(
        async () =>
          (await gate(page)) > waits ||
          (await page.locator("#status").textContent())!.includes("Listed in"),
      )
      .toBe(true);
  }
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  const expected = entries
    .filter((entry) => entry.name.startsWith("needle"))
    .map((entry) => entry.name)
    .sort();
  if (descending) expected.reverse();
  await expect(table).toHaveAttribute("aria-rowcount", String(expected.length + 1));
  await expect
    .poll(async () => {
      const shown = await names(page);
      return shown.length > 0 && shown.every((name, index) => name === expected[index]);
    })
    .toBe(true);
});
