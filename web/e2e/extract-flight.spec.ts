// Small rows of a folder job in flight, on Chromium with the real file steps of the
// origin private file system. The picker gives a folder of that file system. A patch
// in the read worker joins digits in a file name, as a file system joins names that
// the plan does not join. The tests use no time limits for the job.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { contentZip } from "./content-zip";
import type { ContentEntry } from "./content-zip";
import { openArchive, waitForOutcome } from "./listing";

const COLLISION = "A file with the same name was written before (a name collision)";

async function open(page: Page, entries: ContentEntry[]) {
  await page.addInitScript(() => {
    Object.assign(window, {
      showDirectoryPicker: async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle("out", { create: true });
      },
    });
  });
  const path = test.info().outputPath("flight.zip");
  writeFileSync(path, contentZip(entries));
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openArchive(page, path);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
}

/** The files of the job, by path below the output folder. */
async function files(page: Page, folder: string): Promise<Record<string, string>> {
  return page.evaluate(async (name) => {
    const out: Record<string, string> = {};
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      for await (const [entry, handle] of (
        dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
      ).entries()) {
        if (handle.kind === "directory") {
          await walk(handle as FileSystemDirectoryHandle, `${prefix}${entry}/`);
        } else {
          out[`${prefix}${entry}`] = await (
            await (handle as FileSystemFileHandle).getFile()
          ).text();
        }
      }
    };
    const root = await navigator.storage.getDirectory();
    await walk(await (await root.getDirectoryHandle("out")).getDirectoryHandle(name), "");
    return out;
  }, folder);
}

async function extractFolder(page: Page, label: string) {
  await page
    .locator("#list-viewport [data-row]:not([hidden])")
    .filter({ hasText: label })
    .first()
    .click({ button: "right" });
  await page.locator('#row-menu [data-action="extract"]').click();
  await page.locator("#extract-confirm").click();
}

/** The patch of the read worker. The writes of a job go only through it. In a file
 *  name, each match of `pattern` becomes `to`, before the browser sees the name. */
const patchNames = ([pattern, to]: [string, string]) => {
  const scope = self as unknown as { __joined?: boolean };
  if (scope.__joined) return;
  scope.__joined = true;
  const proto = FileSystemDirectoryHandle.prototype;
  const joined = (name: string) => name.replace(new RegExp(pattern, "g"), to);
  const get = proto.getFileHandle;
  proto.getFileHandle = function (name, options) {
    return get.call(this, joined(name), options);
  };
  const remove = proto.removeEntry;
  proto.removeEntry = function (name, options) {
    return remove.call(this, joined(name), options);
  };
};

/** Gives the patch to each new worker. */
function joinNames(page: Page, pattern: string, to: string) {
  page.on("worker", (worker) => {
    void worker.evaluate(patchNames, [pattern, to] as [string, string]).catch(() => {});
  });
}

/** Gives the patch to each worker that is there now. */
async function joinNamesNow(page: Page, pattern: string, to: string) {
  await Promise.all(
    page
      .workers()
      .map((worker) =>
        worker.evaluate(patchNames, [pattern, to] as [string, string]).catch(() => {}),
      ),
  );
}

/** The rows of `j/`: two rows for each letter, whose names differ in a digit. */
const LETTERS = Array.from(
  { length: 40 },
  (_, index) =>
    `n${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}`,
);

test("two rows with one name in flight give one file and one failed row", async ({ page }) => {
  joinNames(page, "[0-9]", "#");
  const entries = LETTERS.flatMap((letter): ContentEntry[] => [
    { name: `j/${letter}1.txt`, data: Buffer.from(`first ${letter}`) },
    { name: `j/${letter}2.txt`, data: Buffer.from(`second ${letter}`) },
  ]);
  await open(page, [
    ...entries,
    // The bad row is alone with its name, and the row after it writes.
    { name: "j/bad.txt", data: Buffer.from("bad crc data"), crc: 0x12345678 },
    { name: "j/good.txt", data: Buffer.from("good") },
    { name: "top.txt", data: Buffer.from("t") },
  ]);
  await joinNamesNow(page, "[0-9]", "#");
  await extractFolder(page, "j");
  await expect(page.locator("#extract-summary")).toContainText("Extracted 41 of 82 files");
  const report = page.locator("#extract-report tbody tr[data-row]");
  await expect(report).toHaveCount(41);
  const shown = await report.evaluateAll((items) =>
    items.map((item) => [item.querySelector("td")!.textContent, item.textContent]),
  );
  // The items come in row order, also when the rows end in another order.
  expect(shown.map(([name]) => name)).toEqual([
    ...LETTERS.map((letter) => `j/${letter}2.txt`),
    "j/bad.txt",
  ]);
  for (const [, row] of shown.slice(0, LETTERS.length)) expect(row).toContain(COLLISION);
  const expected: Record<string, string> = { "good.txt": "good" };
  for (const letter of LETTERS) expected[`${letter}#.txt`] = `first ${letter}`;
  expect(await files(page, "j")).toEqual(expected);
});

test("a row with the name of the swap file of a row in flight writes all its bytes", async ({
  page,
}) => {
  // Chromium makes `<name>.crswap` for each writable. The second row of each pair
  // has this name, and it comes while the first row is in flight.
  const entries = LETTERS.flatMap((letter): ContentEntry[] => [
    { name: `w/${letter}.txt`, data: Buffer.from(`file ${letter}`) },
    { name: `w/${letter}.txt.crswap`, data: Buffer.from(`row with a swap name ${letter}`) },
  ]);
  await open(page, [...entries, { name: "top.txt", data: Buffer.from("t") }]);
  await extractFolder(page, "w");
  await expect(page.locator("#extract-summary, #extraction-report").first()).toContainText(
    `Extracted ${entries.length} of ${entries.length} files`,
  );
  const expected: Record<string, string> = {};
  for (const letter of LETTERS) {
    expected[`${letter}.txt`] = `file ${letter}`;
    expected[`${letter}.txt.crswap`] = `row with a swap name ${letter}`;
  }
  expect(await files(page, "w")).toEqual(expected);
});

test("a row that a file system joins with a swap file writes all its bytes", async ({ page }) => {
  // The patch removes U+FE0F, as a file system that ignores this code point. The name
  // of the row is not a swap name, but the browser sees the name of the swap file of
  // the row before it. A real join has no lock in the browser, and this patch has the
  // lock. So a row that does not wait fails, and no other row changes here. The reproduction
  // of a real join needs an LD_PRELOAD shim in the browser process.
  // U+FE0F follows a letter that is not ASCII, because the plan replaces it after ASCII.
  joinNames(page, "\ufe0f", "");
  const entries = LETTERS.flatMap((letter): ContentEntry[] => [
    { name: `v/${letter}\u00e9.txt`, data: Buffer.from(`file ${letter}`) },
    { name: `v/${letter}\u00e9\ufe0f.txt.crswap`, data: Buffer.from(`other row ${letter}`) },
  ]);
  await open(page, [...entries, { name: "top.txt", data: Buffer.from("t") }]);
  await joinNamesNow(page, "\ufe0f", "");
  await extractFolder(page, "v");
  await expect(page.locator("#extract-summary, #extraction-report").first()).toContainText(
    `Extracted ${entries.length} of ${entries.length} files`,
  );
  const expected: Record<string, string> = {};
  for (const letter of LETTERS) {
    expected[`${letter}\u00e9.txt`] = `file ${letter}`;
    expected[`${letter}\u00e9.txt.crswap`] = `other row ${letter}`;
  }
  expect(await files(page, "v")).toEqual(expected);
});

test("a stop with rows in flight leaves the first rows, each with all of its bytes", async ({
  page,
}) => {
  // The worker counts its open writables, so that the test knows when the job ended.
  const count = () => {
    const scope = self as unknown as { __open?: number };
    if (scope.__open !== undefined) return;
    scope.__open = 0;
    const handle = FileSystemFileHandle.prototype;
    const create = handle.createWritable;
    handle.createWritable = async function (options) {
      const writable = await create.call(this, options);
      scope.__open!++;
      return writable;
    };
    const stream = FileSystemWritableFileStream.prototype;
    const end = (method: "close" | "abort") => {
      const original = WritableStream.prototype[method];
      Object.defineProperty(stream, method, {
        configurable: true,
        writable: true,
        value: async function (this: WritableStream, reason?: unknown) {
          try {
            return await original.call(this, reason);
          } finally {
            scope.__open!--;
          }
        },
      });
    };
    end("close");
    end("abort");
  };
  page.on("worker", (worker) => void worker.evaluate(count).catch(() => {}));
  const ROWS = 3000;
  const body = (row: number) => `the bytes of row ${row}\n`.repeat(40);
  const entries: ContentEntry[] = Array.from({ length: ROWS }, (_, row) => ({
    name: `s/r${String(row).padStart(5, "0")}.txt`,
    data: Buffer.from(body(row)),
  }));
  await open(page, [...entries, { name: "top.txt", data: Buffer.from("t") }]);
  await Promise.all(page.workers().map((worker) => worker.evaluate(count).catch(() => {})));
  await extractFolder(page, "s");
  const onDisk = () =>
    page.evaluate(async () => {
      try {
        const root = await navigator.storage.getDirectory();
        const out = await (await root.getDirectoryHandle("out")).getDirectoryHandle("s");
        let total = 0;
        for await (const _ of (out as unknown as { keys(): AsyncIterable<string> }).keys()) {
          total++;
        }
        return total;
      } catch {
        return 0;
      }
    });
  await expect.poll(onDisk, { intervals: [10] }).toBeGreaterThan(20);
  // The close of the card is the stop. The card shows no report after it.
  await page.locator("#extract-card-close").click();
  const open_ = () =>
    Promise.all(
      page
        .workers()
        .map((worker) =>
          worker
            .evaluate(() => (self as unknown as { __open?: number }).__open ?? 0)
            .catch(() => 0),
        ),
    );
  await expect.poll(async () => (await open_()).reduce((sum, one) => sum + one, 0)).toBe(0);
  const found = await files(page, "s");
  const kept = Object.keys(found).filter((name) => !name.endsWith(".crswap"));
  expect(kept.length).toBeLessThan(ROWS);
  // No swap file stays. The files are the first rows, so no row in flight is lost,
  // and each has all of its bytes.
  expect(kept).toHaveLength(Object.keys(found).length);
  for (let row = 0; row < kept.length; row++) {
    expect(found[`r${String(row).padStart(5, "0")}.txt`]).toBe(body(row));
  }
});
