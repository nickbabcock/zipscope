// The archive lifecycle on Chromium: a second file offers
// Replace or Open in new tab, a replace stops all workers of the old
// archive, a job in progress stops cleanly and keeps the file of the user,
// and the new-tab handoff gives the file to a second tab of the same
// context.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page, Worker } from "@playwright/test";
import { Header, HEADER_BYTES, RESERVATION_UNIT_BYTES } from "../src/contracts.ts";
import { lifecycle } from "../src/lifecycle/strings.ts";
import { contentZip } from "./content-zip";
import { dropArchive, openArchive, waitForOutcome } from "./listing";
import { storedZip } from "./stored-zip";

/** Records each worker of the page in `window.__workers`: its number,
 *  its script and whether it stopped. */
async function logWorkers(page: Page): Promise<void> {
  await page.addInitScript((headerBytes) => {
    const log: { url: string; stopped: boolean }[] = [];
    (window as unknown as { __workers: typeof log }).__workers = log;
    // The headers that the workers sent, in order (the next
    // archive starts with no reservation).
    const headers: SharedArrayBuffer[] = [];
    (window as unknown as { __headers: typeof headers }).__headers = headers;
    const scan = (value: unknown, depth: number) => {
      if (value instanceof SharedArrayBuffer) {
        if (value.byteLength === headerBytes && !headers.includes(value)) headers.push(value);
      } else if (typeof value === "object" && value !== null && depth < 4) {
        for (const item of Object.values(value)) scan(item, depth + 1);
      }
    };
    const Native = Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const entry = { url: String(url), stopped: false };
        this.addEventListener("message", (event) => scan(event.data, 0));
        log.push(entry);
        const terminate = this.terminate.bind(this);
        this.terminate = () => {
          entry.stopped = true;
          terminate();
        };
      }
    };
  }, HEADER_BYTES);
}

/** The two halves of `RESERVED` of each header, in bytes: the parse
 *  worker and the read side. */
async function reservations(page: Page): Promise<{ parse: number; read: number }[]> {
  return page.evaluate(
    ({ slot, unit }) =>
      (window as unknown as { __headers: SharedArrayBuffer[] }).__headers.map((header) => {
        const word = Atomics.load(new Int32Array(header), slot) >>> 0;
        return { parse: (word >>> 16) * unit, read: (word & 0xffff) * unit };
      }),
    { slot: Header.RESERVED, unit: RESERVATION_UNIT_BYTES },
  );
}

/** The numbers of the workers that did not stop. */
async function liveWorkers(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    (window as unknown as { __workers: { stopped: boolean }[] }).__workers
      .map((entry, index) => (entry.stopped ? -1 : index))
      .filter((index) => index >= 0),
  );
}

function writeZip(name: string, entries: [string, number][]): string {
  const path = test.info().outputPath(name);
  writeFileSync(path, storedZip(entries));
  return path;
}

async function openFirst(page: Page, path: string): Promise<void> {
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  // The archive takes the preloaded workers, so the tests know which
  // workers are of the archive.
  await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", "true");
  await openArchive(page, path);
  expect((await waitForOutcome(page)).outcome).toBe("complete");
}

test("a dropped file offers Replace or Open in new tab, and Cancel keeps the archive", async ({
  page,
}) => {
  await openFirst(page, writeZip("first.zip", [["a/one.txt", 1]]));
  await dropArchive(page, writeZip("second.zip", [["b/two.txt", 2]]));
  const dialog = page.locator("#open-choice");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#open-choice-title")).toHaveText(lifecycle.choiceTitle("second.zip"));
  await expect(page.locator("#open-choice-text")).toHaveText(lifecycle.choiceText("first.zip"));
  // One primary, with the focus.
  await expect(page.locator("#open-choice-replace")).toBeFocused();
  await expect(page.locator("#open-choice-writing")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#archive-name")).toHaveText("first.zip");
  // Each drop asks again.
  await dropArchive(page, writeZip("dropped.zip", [["c/three.txt", 3]]));
  await expect(page.locator("#open-choice-title")).toHaveText(lifecycle.choiceTitle("dropped.zip"));
  await page.locator("#open-choice-cancel").click();
  await expect(page.locator("#archive-name")).toHaveText("first.zip");
});

test("a file from the Open button replaces the archive at once", async ({ page }) => {
  // The Open button and the file picker are a deliberate
  // action, so they do not ask. Only a drop, which can be an accident,
  // asks.
  await openFirst(page, writeZip("first.zip", [["a/one.txt", 1]]));
  await openArchive(page, writeZip("second.zip", [["b/two.txt", 2]]));
  await expect(page.locator("#archive-name")).toHaveText("second.zip");
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#open-choice")).toHaveCount(0);
  // The same for a file from `showOpenFilePicker`.
  await page.evaluate(() => {
    // An empty archive: the end record only.
    const end = new Uint8Array(22);
    end.set([0x50, 0x4b, 5, 6]);
    const file = new File([end], "picked.zip");
    const handle = { kind: "file", name: file.name, getFile: async () => file };
    Object.assign(window, { showOpenFilePicker: async () => [handle] });
  });
  await page.locator("#open-button").click();
  await expect(page.locator("#archive-name")).toHaveText("picked.zip");
  await expect(page.locator("#open-choice")).toHaveCount(0);
});

test("Replace stops every worker of the old archive", async ({ page }) => {
  await logWorkers(page);
  await openFirst(page, writeZip("first.zip", [["a/one.txt", 1]]));
  // The preview starts the read worker of the first archive.
  await page.locator("#list-viewport [data-row]").filter({ hasText: "one.txt" }).first().dblclick();
  await expect(page.locator("#preview-pane")).toBeVisible();
  const old = await liveWorkers(page);
  expect(old.length).toBeGreaterThanOrEqual(2);
  // The read worker of the first archive reserved memory in its header.
  await expect.poll(async () => (await reservations(page))[0]?.read ?? 0).toBeGreaterThan(0);
  await openArchive(page, writeZip("second.zip", [["b/two.txt", 2]]));
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect(page.locator("#archive-name")).toHaveText("second.zip");
  const live = await liveWorkers(page);
  for (const index of old) expect(live, `worker ${index}`).not.toContain(index);
  // Only the parse worker of the new archive runs.
  expect(live).toHaveLength(1);
  // The new archive has its own header, and its read side starts from
  // zero: no reservation of the old archive is in its budget.
  const headers = await reservations(page);
  expect(headers).toHaveLength(2);
  expect(headers[1]!.read).toBe(0);
});

/** `length` bytes that do not compress, from a seed. */
function noise(length: number): Buffer {
  const out = Buffer.alloc(length);
  let state = 12345;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/** Stubs the save picker with a file of the origin private file system
 *  that has content already: the file of the user. */
async function stubSavePicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.assign(window, {
      showSaveFilePicker: async () => {
        const root = await navigator.storage.getDirectory();
        return root.getFileHandle("keep.bin", { create: true });
      },
    });
  });
}

async function userFile(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    return (await (await root.getFileHandle("keep.bin")).getFile()).text();
  });
}

/** Makes each write of a writable in the workers wait `ms` (or never
 *  complete, for -1), so that an extraction is still in progress. */
async function slowWrites(page: Page, ms: number): Promise<void> {
  for (const worker of page.workers()) await slowWorker(worker, ms);
}

async function slowWorker(worker: Worker, ms: number): Promise<void> {
  {
    await worker.evaluate((wait) => {
      const proto = (
        globalThis as unknown as {
          FileSystemWritableFileStream?: { prototype: { write: (...args: unknown[]) => unknown } };
        }
      ).FileSystemWritableFileStream?.prototype;
      if (proto === undefined) return;
      const write = proto.write;
      proto.write = async function (this: unknown, ...args: unknown[]) {
        await new Promise((resolve) => (wait < 0 ? undefined : setTimeout(resolve, wait)));
        return write.apply(this, args);
      };
    }, ms);
  }
}

for (const [label, wait] of [
  ["aborts its output", 1500],
  ["stops after the wait and leaves the file as it was", -1],
] as const) {
  test(`Replace during an extraction cancels it, which ${label}`, async ({ page }) => {
    await logWorkers(page);
    await stubSavePicker(page);
    const path = test.info().outputPath("big.zip");
    writeFileSync(path, contentZip([{ name: "big.bin", data: noise(16 * 2 ** 20), method: 0 }]));
    await openFirst(page, path);
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const writable = await (
        await root.getFileHandle("keep.bin", { create: true })
      ).createWritable();
      await writable.write("keep");
      await writable.close();
    });
    // The front door preloaded the read worker. Its writes are now slow.
    await expect(page.locator("#front-door")).toHaveCount(0);
    await slowWrites(page, wait);
    await page
      .locator("#list-viewport [data-row]")
      .filter({ hasText: "big.bin" })
      .first()
      .dblclick();
    await page.locator("#preview-extract").click();
    await expect(page.locator("#extract-card")).toBeVisible();
    const old = await liveWorkers(page);
    // A file from the Open button asks too, because Replace cancels the
    // job.
    await openArchive(page, writeZip("second.zip", [["b/two.txt", 2]]));
    await expect(page.locator("#open-choice-writing")).toHaveText(lifecycle.choiceWriting);
    // A loss: no primary, and Cancel has the focus.
    await expect(page.locator("#open-choice-cancel")).toBeFocused();
    await page.locator("#open-choice-replace").click();
    expect((await waitForOutcome(page)).outcome).toBe("complete");
    await expect(page.locator("#extract-card")).toHaveCount(0);
    // All workers of the old archive stop: at once after the abort, or
    // after the wait of the session (JOB_STOP_MS).
    await expect
      .poll(async () => (await liveWorkers(page)).filter((index) => old.includes(index)), {
        timeout: 15_000,
      })
      .toEqual([]);
    expect(await userFile(page)).toBe("keep");
  });
}

test("Replace during a zstd copy cancels it and leaves the file as it was", async ({ page }) => {
  await logWorkers(page);
  await stubSavePicker(page);
  const path = test.info().outputPath("copy.zip");
  writeFileSync(
    path,
    contentZip(
      Array.from({ length: 8 }, (_, index) => ({
        name: `part-${index}.bin`,
        data: noise(2 * 2 ** 20),
        method: 0 as const,
      })),
    ),
  );
  await openFirst(page, path);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const writable = await (
      await root.getFileHandle("keep.bin", { create: true })
    ).createWritable();
    await writable.write("keep");
    await writable.close();
  });
  // The preview takes the preloaded read worker, so all workers are of
  // the archive.
  await page
    .locator("#list-viewport [data-row]")
    .filter({ hasText: "part-0.bin" })
    .first()
    .dblclick();
  await expect(page.locator("#preview-extract")).toBeVisible();
  // The write workers start with the copy. Their writes never complete.
  page.on("worker", (worker) => void slowWorker(worker, -1).catch(() => {}));
  await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
  await page.locator("#archive-remux #remux-button").click();
  await page.locator("#remux-confirm").click();
  await expect(page.locator("#remux-card")).toBeVisible();
  await expect.poll(async () => (await liveWorkers(page)).length).toBeGreaterThan(2);
  const old = await liveWorkers(page);
  await openArchive(page, writeZip("second.zip", [["b/two.txt", 2]]));
  await expect(page.locator("#open-choice-writing")).toHaveText(lifecycle.choiceWriting);
  await page.locator("#open-choice-replace").click();
  expect((await waitForOutcome(page)).outcome).toBe("complete");
  await expect
    .poll(async () => (await liveWorkers(page)).filter((index) => old.includes(index)), {
      timeout: 15_000,
    })
    .toEqual([]);
  expect(await userFile(page)).toBe("keep");
});

test("Open in new tab gives the file to a new tab, and this tab keeps its archive", async ({
  page,
  context,
}) => {
  await openFirst(page, writeZip("first.zip", [["a/one.txt", 1]]));
  await dropArchive(page, writeZip("second.zip", [["b/two.txt", 2]]));
  const opened = context.waitForEvent("page");
  await page.locator("#open-choice-new-tab").click();
  const tab = await opened;
  await expect(tab.locator("#archive-name")).toHaveText("second.zip");
  expect((await waitForOutcome(tab)).outcome).toBe("complete");
  // The address bar shows `/`, and a reload does not wait again.
  expect(new URL(tab.url()).pathname + new URL(tab.url()).hash).toBe("/");
  await expect(page.locator("#archive-name")).toHaveText("first.zip");
  await expect(page.locator("#open-choice")).toHaveCount(0);
});

test.describe("after the preload", () => {
  test.use({ serviceWorkers: "block" });

  test("Open in new tab does not need the channel chunk from the network", async ({
    page,
    context,
  }) => {
    await openFirst(page, writeZip("first.zip", [["a/one.txt", 1]]));
    // Only the requests of this tab: the new tab loads the page as usual.
    await page.route("**/assets/handoff-*.js", (route) => route.abort());
    await dropArchive(page, writeZip("second.zip", [["b/two.txt", 2]]));
    const opened = context.waitForEvent("page");
    await page.locator("#open-choice-new-tab").click();
    const tab = await opened;
    // Before the new tab shows its drop zone (`RECEIVE_MS`, 5 s).
    await expect(tab.locator("#archive-name")).toHaveText("second.zip", { timeout: 4000 });
  });
});

test("a new tab without an answer shows its drop zone", async ({ page, context }) => {
  // A tab that listens on the channel but does not send the file.
  const other = await context.newPage();
  await other.goto("/");
  const id = crypto.randomUUID();
  await other.evaluate((name) => {
    const channel = new BroadcastChannel(name);
    (window as unknown as { __seen: unknown[] }).__seen = [];
    channel.onmessage = (event) => {
      (window as unknown as { __seen: unknown[] }).__seen.push(event.data);
      // Messages that are not a valid file: the new tab ignores them.
      const base = { zipscope: "handoff", version: 1, id: event.data.id, kind: "file" };
      channel.postMessage({ ...base, file: "not a file" });
      channel.postMessage({ ...base, version: 2, file: new File(["PK"], "evil.zip") });
    };
  }, `zipscope-handoff:${id}`);
  await page.goto(`/#handoff=${id}`);
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "receiving");
  await expect(page.locator("#receiving-text")).toHaveText(lifecycle.receiving);
  await expect(page.locator("#front-door")).toHaveAttribute("data-state", "first", {
    timeout: 10_000,
  });
  await expect(page.locator("#archive-name")).toHaveCount(0);
  const seen = await other.evaluate(() => (window as unknown as { __seen: unknown[] }).__seen);
  expect(seen[0]).toEqual({ zipscope: "handoff", version: 1, kind: "ready", id });
  expect(seen.some((data) => (data as { kind: string }).kind === "ack")).toBe(false);
});

test.describe("the choice chunk does not load", () => {
  test.use({ serviceWorkers: "block" });

  test.beforeEach(async ({ page }) => {
    await page.route("**/assets/OpenChoice-*.js", (route) => route.abort());
  });

  test("for a drop, the browser asks, and OK replaces", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", /^(true|false)$/);
    await openArchive(page, writeZip("first.zip", [["a/one.txt", 1]]));
    expect((await waitForOutcome(page)).outcome).toBe("complete");
    const dialogs: { type: string; message: string }[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      void dialog.accept();
    });
    await dropArchive(page, writeZip("second.zip", [["b/two.txt", 2]]));
    await expect(page.locator("#archive-name")).toHaveText("second.zip");
    expect(dialogs).toEqual([
      {
        type: "confirm",
        message: `${lifecycle.choiceTitle("second.zip")}\n${lifecycle.choiceText("first.zip")}`,
      },
    ]);
  });

  test("a file from the Open button replaces with no question", async ({ page }) => {
    // With no job, a chosen file needs no choice, so it
    // does not need the chunk either.
    await page.goto("/");
    await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", /^(true|false)$/);
    await openArchive(page, writeZip("first.zip", [["a/one.txt", 1]]));
    expect((await waitForOutcome(page)).outcome).toBe("complete");
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.type());
      void dialog.dismiss();
    });
    await openArchive(page, writeZip("second.zip", [["b/two.txt", 2]]));
    await expect(page.locator("#archive-name")).toHaveText("second.zip");
    expect(dialogs).toEqual([]);
  });

  test("during an extraction, the browser says that the archive stays", async ({ page }) => {
    await stubSavePicker(page);
    // The writes of each worker never complete, so the job stays in
    // progress.
    page.on("worker", (worker) => void slowWorker(worker, -1).catch(() => {}));
    const path = test.info().outputPath("big.zip");
    writeFileSync(path, contentZip([{ name: "big.bin", data: noise(16 * 2 ** 20), method: 0 }]));
    await page.goto("/");
    await expect(page.locator("#front-door")).toHaveAttribute("data-preloaded", /^(true|false)$/);
    await openArchive(page, path);
    expect((await waitForOutcome(page)).outcome).toBe("complete");
    await slowWrites(page, -1);
    await page
      .locator("#list-viewport [data-row]")
      .filter({ hasText: "big.bin" })
      .first()
      .dblclick();
    await page.locator("#preview-extract").click();
    await expect(page.locator("#extract-card")).toBeVisible();
    const dialogs: { type: string; message: string }[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      // OK, as a user who presses Enter.
      void dialog.accept();
    });
    await openArchive(page, writeZip("second.zip", [["b/two.txt", 2]]));
    await expect.poll(() => dialogs.length).toBe(1);
    // The file did not open, so the title does not say "Open".
    expect(dialogs[0]).toEqual({
      type: "alert",
      message: `${lifecycle.choiceKeptTitle("second.zip")}\n${lifecycle.choiceKept("big.zip")}`,
    });
    await expect(page.locator("#archive-name")).toHaveText("big.zip");
    await expect(page.locator("#extract-card")).toBeVisible();
  });
});
