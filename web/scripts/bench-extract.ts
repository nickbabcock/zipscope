// Measures extraction, the zstd copy and preview in headless Chromium: the
// reads, the bytes and the time for each row. It drives the real app with a
// disk-backed File.
//
// It wraps `FileReaderSync` in each worker of the page, from the outside,
// so that it measures any build without a change to the app. A read count is
// exact. The time is only a measure, and no limit applies to it.
//
// The folder sink is the origin private file system, because a headless run
// cannot use the native folder picker. With `--real`, it is a new real folder in
// `--dir`, with no picker: the new profile has a stored write grant for the folder,
// and CDP drops the folder on the page. Set
// ZIPSCOPE_PORT, because the grant is for one origin. The zip sink is the
// service-worker download, and the blob sink saves the zip from memory.
//
// With `--remux`, it saves a zstd copy in place of an extraction. The sink
// `picker` is the save picker, with a file of the origin private file system,
// and the sink `download` is the streamed download. The lead and the encoders
// end with the copy, so each worker sends its read counts on a broadcast
// channel after each read, and the page keeps the last counts of each worker.
// With `--verify`, Python `zipfile` reads each entry of the copy and checks its
// CRC-32.
//
// Usage:
//   node scripts/bench-extract.ts --dir <dir> --label <name> [--rows <n>]
//     [--order written|shuffled] [--stored] [--sinks folder,zip,blob] [--archive <zip>]
//     [--large] [--previews <n>] [--real] [--remux [--verify]]
//
// The browser profile and the generated archives go in `--dir`, not in the
// temporary folder, which can be a memory disk. Each
// result is one JSON line in `<dir>/results.jsonl`. Each output checksum is
// in `<dir>/<label>-<archive>-<sink>.sums`, so that two builds can be compared
// with `cmp`.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { chromium } from "@playwright/test";
import type { BrowserContext, Page, Worker } from "@playwright/test";
import { preview } from "vite";
import { openArchive, waitForOutcome } from "../e2e/listing.ts";
import { dropFolder, grantFolder } from "../e2e/real-folder.ts";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const dir = option("dir");
const label = option("label");
if (dir === undefined || label === undefined) {
  console.error("usage: bench-extract --dir <dir> --label <name> [see the file header]");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
const rowCount = Number(option("rows") ?? 100_000);
const order = option("order") ?? "written";
/** The small rows are stored, not deflated, so that a zstd copy compresses them. */
const stored = args.includes("--stored");
const remuxMode = args.includes("--remux");
const verifyCopy = args.includes("--verify");
const sinks = (option("sinks") ?? (remuxMode ? "picker,download" : "folder,zip")).split(",");
const previews = Number(option("previews") ?? 0);
const real = args.includes("--real");
/** The origin of the preview server, for the stored grant of `--real`. */
let origin = "";

const LOCAL_SIGNATURE = 0x04034b50;
const RECORD_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;

/** `length` bytes of text from a seed. The text compresses about 4 to 3. */
function text(length: number, seed: number): Buffer {
  let state = seed >>> 0 || 1;
  const random = Buffer.alloc(Math.ceil((length * 3) / 4) + 3);
  for (let i = 0; i < random.length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    random[i] = state >>> 24;
  }
  const out = Buffer.from(random.toString("base64").slice(0, length));
  // Lines of 76 characters, so that a large preview has short lines.
  for (let at = 76; at < out.length; at += 77) out[at] = 10;
  return out;
}

/** The same paths as the `generate` example, about 80 bytes. */
function rowName(index: number): string {
  const module = String(Math.floor(index / 1000)).padStart(3, "0");
  const component = String(Math.floor(index / 50) % 20).padStart(2, "0");
  const file = String(index).padStart(7, "0");
  return `project-1.2.0/src/module-${module}/component-${component}/file-${file}-generated-entry-name.txt`;
}

interface Written {
  name: Buffer;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

function localHeader(entry: Omit<Written, "offset">): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressed, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.name.length, 26);
  return header;
}

function record(entry: Written): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(RECORD_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressed, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([header, entry.name]);
}

function endRecord(count: number, size: number, offset: number): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return end;
}

/** Writes `rows` deflated rows of 1 KiB, or stored rows with `--stored`. With
 *  `shuffled`, the central directory comes in a fixed random order, not in the
 *  order of the data. */
function smallArchive(file: string, rows: number, shuffled: boolean): void {
  const fd = openSync(file, "w");
  const entries: Written[] = [];
  let at = 0;
  for (let index = 0; index < rows; index++) {
    const name = Buffer.from(rowName(index));
    const data = text(1024, index + 1);
    const body = stored ? data : deflateRawSync(data);
    const entry = {
      name,
      method: stored ? 0 : 8,
      crc: crc32(data),
      compressed: body.length,
      size: data.length,
    };
    const header = localHeader(entry);
    writeSync(fd, header);
    writeSync(fd, name);
    writeSync(fd, body);
    entries.push({ ...entry, offset: at });
    at += header.length + name.length + body.length;
  }
  if (shuffled) {
    let seed = 0x2545f491;
    for (let last = entries.length - 1; last > 0; last--) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      const other = seed % (last + 1);
      [entries[last], entries[other]] = [entries[other]!, entries[last]!];
    }
  }
  let size = 0;
  for (const entry of entries) {
    const bytes = record(entry);
    writeSync(fd, bytes);
    size += bytes.length;
  }
  writeSync(fd, endRecord(Math.min(rows, 0xffff), size, at));
  closeSync(fd);
}

/** The rows of the archive for a large file: first a small row, for a warm
 *  preview, then 1 GiB of stored text and 128 MiB of deflated text. */
function largeArchive(file: string): void {
  const fd = openSync(file, "w");
  const entries: Written[] = [];
  let at = 0;
  const add = (name: string, parts: Buffer[], method: number, size: number, crc: number) => {
    const nameBytes = Buffer.from(name);
    const compressed = parts.reduce((sum, part) => sum + part.length, 0);
    const entry = { name: nameBytes, method, crc, compressed, size };
    const header = localHeader(entry);
    writeSync(fd, header);
    writeSync(fd, nameBytes);
    for (const part of parts) writeSync(fd, part);
    entries.push({ ...entry, offset: at });
    at += header.length + nameBytes.length + compressed;
  };
  const small = Buffer.from("small row\n");
  add("small.txt", [small], 0, small.length, crc32(small));
  const piece = text(4 * 1024 * 1024, 7);
  let crc = 0;
  const stored: Buffer[] = [];
  for (let index = 0; index < 256; index++) {
    stored.push(piece);
    crc = crc32(piece, crc);
  }
  add("big-stored.txt", stored, 0, 256 * piece.length, crc);
  const deflatedText = text(128 * 1024 * 1024, 11);
  add(
    "big-deflated.txt",
    [deflateRawSync(deflatedText)],
    8,
    deflatedText.length,
    crc32(deflatedText),
  );
  let size = 0;
  for (const entry of entries) {
    const bytes = record(entry);
    writeSync(fd, bytes);
    size += bytes.length;
  }
  writeSync(fd, endRecord(entries.length, size, at));
  closeSync(fd);
}

/** The state that the wrap keeps in each worker. */
interface ReadLog {
  reads: number;
  bytes: number;
  ms: number;
  log: [number, number][];
  lastSlice: number;
}

/** Runs in each worker. It wraps the reads of the worker. */
function wrapReads(): void {
  const scope = self as unknown as {
    __reads?: ReadLog;
    FileReaderSync?: { prototype: { readAsArrayBuffer(blob: Blob): ArrayBuffer } };
  };
  const reader = scope.FileReaderSync?.prototype;
  if (scope.__reads !== undefined || reader === undefined) return;
  const state: ReadLog = { reads: 0, bytes: 0, ms: 0, log: [], lastSlice: 0 };
  scope.__reads = state;
  // The totals of this worker since it started, for a worker that ends
  // before the bench can ask it (the workers of a zstd copy).
  const id = Math.random().toString(36).slice(2);
  const channel = new BroadcastChannel("bench-reads");
  const total = { reads: 0, bytes: 0, ms: 0 };
  const slice = Blob.prototype.slice;
  Blob.prototype.slice = function (start, end, type) {
    state.lastSlice = start ?? 0;
    return slice.call(this, start, end, type);
  };
  const read = reader.readAsArrayBuffer;
  reader.readAsArrayBuffer = function (blob) {
    const begin = performance.now();
    const bytes = read.call(this, blob);
    const ms = performance.now() - begin;
    state.ms += ms;
    state.reads++;
    state.bytes += bytes.byteLength;
    total.reads++;
    total.bytes += bytes.byteLength;
    total.ms += ms;
    channel.postMessage({ id, url: self.location.pathname, ...total });
    if (state.log.length < 64) state.log.push([state.lastSlice, bytes.byteLength]);
    return bytes;
  };
}

/** A worker that stopped gives no answer, so a call has a limit. */
const limited = <T>(call: Promise<T>, fallback: T): Promise<T> =>
  Promise.race([
    call.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), 5000).unref()),
  ]);

const reset = (worker: Worker) =>
  limited(
    worker.evaluate(() => {
      const state = (self as unknown as { __reads?: ReadLog }).__reads;
      if (state !== undefined) {
        state.reads = 0;
        state.bytes = 0;
        state.ms = 0;
        state.log = [];
      }
    }),
    undefined,
  );

const snapshot = (worker: Worker) =>
  limited(
    worker.evaluate(() => (self as unknown as { __reads?: ReadLog }).__reads ?? null),
    null,
  );

const note = (text: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${text}`);

async function resetReads(page: Page): Promise<void> {
  await Promise.all(page.workers().map(reset));
}

async function totalReads(page: Page): Promise<ReadLog> {
  const parts = await Promise.all(page.workers().map(snapshot));
  const total: ReadLog = { reads: 0, bytes: 0, ms: 0, log: [], lastSlice: 0 };
  for (const part of parts) {
    if (part === null) continue;
    total.reads += part.reads;
    total.bytes += part.bytes;
    total.ms += part.ms;
    total.log.push(...part.log);
  }
  return total;
}

/** The largest resident memory of the renderers of a profile, in MiB: the peak
 *  and the size now. */
function rendererMemory(profile: string): { peakMiB: number; nowMiB: number } {
  let peak = 0;
  let now = 0;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const line = readFileSync(`/proc/${name}/cmdline`, "utf8");
      if (!line.includes("--type=renderer")) continue;
      // A renderer has no profile in its command line, so its parent decides.
      const parent = /^PPid:\s+(\d+)/m.exec(readFileSync(`/proc/${name}/status`, "utf8"))?.[1];
      const zygote = readFileSync(`/proc/${parent}/cmdline`, "utf8");
      const ancestor = /^PPid:\s+(\d+)/m.exec(readFileSync(`/proc/${parent}/status`, "utf8"))?.[1];
      const browser = readFileSync(`/proc/${ancestor}/cmdline`, "utf8");
      const owner = zygote.includes(profile) || browser.includes(profile);
      if (!owner) continue;
      const status = readFileSync(`/proc/${name}/status`, "utf8");
      peak = Math.max(peak, Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1] ?? 0) / 1024);
      now = Math.max(now, Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) / 1024);
    } catch {
      // A process can end while the loop reads it.
    }
  }
  return { peakMiB: Math.round(peak), nowMiB: Math.round(now) };
}

function emit(result: Record<string, unknown>): void {
  const line = JSON.stringify({ label, ...result });
  appendFileSync(path.join(dir!, "results.jsonl"), `${line}\n`);
  console.log(line);
}

function perRow(reads: ReadLog, rows: number, ms: number) {
  return {
    rows,
    ms: Math.round(ms),
    msPerRow: Number((ms / rows).toFixed(3)),
    reads: reads.reads,
    readsPerRow: Number((reads.reads / rows).toFixed(4)),
    readMiB: Math.round(reads.bytes / 2 ** 20),
    kibPerRow: Number((reads.bytes / 1024 / rows).toFixed(1)),
    readMs: Math.round(reads.ms),
    readMsPerRead: Number((reads.ms / Math.max(1, reads.reads)).toFixed(3)),
  };
}

/** Makes a new browser with a profile in `dir`. With `grant`, `folder` is a new real
 *  folder that the profile can write to. */
async function browser(grant = false): Promise<{
  context: BrowserContext;
  profile: string;
  page: Page;
  folder: string;
}> {
  const profile = path.resolve(dir!, `profile-${randomUUID()}`);
  const folder = path.resolve(dir!, `real-${randomUUID()}`);
  if (grant) {
    mkdirSync(folder);
    grantFolder(profile, folder, origin);
  }
  const context = await chromium.launchPersistentContext(profile, {
    channel: process.env.BENCH_CHANNEL ?? "chromium",
    headless: true,
    acceptDownloads: true,
    downloadsPath: path.join(profile, "downloads"),
    viewport: { width: 1440, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("worker", (worker) => void worker.evaluate(wrapReads).catch(() => {}));
  return { context, profile, page, folder };
}

/** The picker stub or the removed pickers of a sink. `zip` is the download of
 *  the service worker. `blob` has no service worker, so it saves from memory. */
async function setSink(page: Page, sink: string): Promise<void> {
  await page.addInitScript((selected) => {
    if (selected === "folder") {
      Object.assign(window, {
        showDirectoryPicker: async () => {
          const held = (window as unknown as { __realFolder?: FileSystemDirectoryHandle })
            .__realFolder;
          if (held !== undefined) return held;
          const root = await navigator.storage.getDirectory();
          return root.getDirectoryHandle("out", { create: true });
        },
      });
      return;
    }
    for (const name of ["showSaveFilePicker", "showDirectoryPicker"]) {
      Object.defineProperty(window, name, { value: undefined, configurable: true });
    }
    if (selected === "blob") {
      Object.defineProperty(Navigator.prototype, "serviceWorker", {
        get: () => undefined,
        configurable: true,
      });
    }
  }, sink);
}

/** Gives one line for each output file: its path and SHA-256, sorted. It runs
 *  on the page, in small steps, so that a large folder fits. */
async function folderSums(page: Page): Promise<string[]> {
  const lines = await page.evaluate(async () => {
    const out: string[] = [];
    const hex = (bytes: ArrayBuffer) =>
      Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const walk = async (folder: FileSystemDirectoryHandle, prefix: string) => {
      for await (const [name, handle] of (
        folder as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
      ).entries()) {
        if (handle.kind === "directory") {
          out.push(`${prefix}${name}/ -`);
          await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`);
        } else {
          const file = await (handle as FileSystemFileHandle).getFile();
          const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
          out.push(`${prefix}${name} ${hex(digest)}`);
        }
      }
    };
    const root = await navigator.storage.getDirectory();
    await walk(await root.getDirectoryHandle("out"), "");
    return out;
  });
  return lines.sort();
}

async function fileSum(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The lines of `folderSums`, for a real folder. */
async function realSums(folder: string, prefix = ""): Promise<string[]> {
  const lines: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const at = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      lines.push(`${prefix}${entry.name}/ -`, ...(await realSums(at, `${prefix}${entry.name}/`)));
    } else {
      lines.push(`${prefix}${entry.name} ${await fileSum(at)}`);
    }
  }
  return lines;
}

async function extract(server: string, archive: string, sink: string, rows: number): Promise<void> {
  const name = path.basename(archive, ".zip");
  const realFolder = real && sink === "folder";
  const { context, profile, page, folder } = await browser(realFolder);
  try {
    await setSink(page, sink);
    await page.goto(server);
    if (realFolder) await dropFolder(context, page, folder);
    await openArchive(page, archive);
    const listed = await waitForOutcome(page, 600_000);
    if (listed.outcome !== "complete") throw new Error(`listing: ${listed.status}`);
    note(`${name} ${sink}: listed`);
    const planStart = performance.now();
    await page.locator("#folder-extract").click();
    await page.locator("#extract-confirm").waitFor({ timeout: 600_000 });
    const planMs = performance.now() - planStart;
    await resetReads(page);
    note(`${name} ${sink}: planned in ${Math.round(planMs)} ms`);
    let download = sink === "folder" ? undefined : page.waitForEvent("download", { timeout: 0 });
    let start = performance.now();
    await page.locator("#extract-confirm").click();
    // A clean job ends on the card, and a job with report items in the dialog.
    const summary = page.locator("#extraction-report, #extract-summary");
    // The app asks to save from memory when no service worker can stream, or
    // when the browser does not ask for the first bytes in time.
    const memory = page.locator("#extract-confirm", { hasText: "Save from memory" });
    const first = await Promise.race([
      summary
        .first()
        .waitFor({ timeout: 0 })
        .then(() => "summary"),
      memory.waitFor({ timeout: 0 }).then(() => "memory"),
    ]);
    let fellBackMs: number | undefined;
    if (first === "memory") {
      fellBackMs = Math.round(performance.now() - start);
      note(`${name} ${sink}: asks to save from memory after ${fellBackMs} ms`);
      await resetReads(page);
      download = page.waitForEvent("download", { timeout: 0 });
      start = performance.now();
      await memory.click();
      await summary.first().waitFor({ timeout: 0 });
    }
    const ms = performance.now() - start;
    note(`${name} ${sink}: extracted in ${Math.round(ms)} ms`);
    const reads = await totalReads(page);
    const summaryText = await summary.first().textContent();
    const counts = await page
      .locator("#extract-counts")
      .textContent({ timeout: 1000 })
      .catch(() => null);
    const items = await page.locator("#extract-report tbody tr[data-row]").count();
    const sums = path.join(dir!, `${label}-${name}-${sink}.sums`);
    if (sink === "folder") {
      const lines = realFolder ? (await realSums(folder)).sort() : await folderSums(page);
      writeFileSync(sums, `${lines.join("\n")}\n`);
    } else {
      const file = await (await download!).path();
      writeFileSync(sums, `${await fileSum(file)} zip\n`);
    }
    emit({
      kind: "extract",
      archive: name,
      sink,
      ...perRow(reads, rows, ms),
      planMs: Math.round(planMs),
      ...(fellBackMs === undefined ? {} : { fellBackMs }),
      summary: summaryText,
      counts,
      items,
      memory: rendererMemory(profile),
      firstReads: reads.log.slice(0, 24),
    });
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The read totals of one worker, from the broadcast channel. */
interface WorkerReads {
  url: string;
  reads: number;
  bytes: number;
  ms: number;
}

/** The kind of a worker, from the name of its script: `lead`, `encoder`,
 *  `worker` (the read worker) or another name. */
const workerKind = (url: string) => /([a-z]+)-[\w-]*\.js$/.exec(url)?.[1] ?? url;

/** Saves a zstd copy of `archive` through `sink` (`picker` or `download`). */
async function remux(server: string, archive: string, sink: string, rows: number): Promise<void> {
  const name = path.basename(archive, ".zip");
  const { context, profile, page } = await browser();
  try {
    await page.addInitScript((selected) => {
      const totals: Record<string, unknown> = {};
      Object.assign(window, { __workerReads: totals });
      new BroadcastChannel("bench-reads").onmessage = (event: MessageEvent<{ id: string }>) => {
        totals[event.data.id] = event.data;
      };
      if (selected === "picker") {
        Object.assign(window, {
          showSaveFilePicker: async (options: { suggestedName: string }) => {
            const root = await navigator.storage.getDirectory();
            return root.getFileHandle(options.suggestedName, { create: true });
          },
        });
      } else {
        Object.defineProperty(window, "showSaveFilePicker", {
          value: undefined,
          configurable: true,
        });
      }
    }, sink);
    await page.goto(server);
    await openArchive(page, archive);
    const listed = await waitForOutcome(page, 600_000);
    if (listed.outcome !== "complete") throw new Error(`listing: ${listed.status}`);
    note(`${name} ${sink}: listed`);
    await page.locator("#tree-viewport [role=treeitem]:not([hidden])").first().click();
    await page.locator("#archive-remux #remux-button").click();
    await page.locator("#remux-confirm").waitFor({ timeout: 600_000 });
    // The counts of the workers that exist now (the parse and read workers)
    // do not count.
    const before: Record<string, WorkerReads> = await page.evaluate(() =>
      structuredClone(
        (window as unknown as { __workerReads: Record<string, WorkerReads> }).__workerReads,
      ),
    );
    const download =
      sink === "download" ? page.waitForEvent("download", { timeout: 0 }) : undefined;
    const start = performance.now();
    await page.locator("#remux-confirm").click();
    const samples: [number, string][] = [];
    const sampler = setInterval(() => {
      void page
        .locator("#remux-detail")
        .textContent({ timeout: 1000 })
        .then((detail) => {
          const at = Math.round((performance.now() - start) / 1000);
          samples.push([at, detail ?? ""]);
          note(`${name} ${sink}: ${at} s: ${detail}`);
        })
        .catch(() => {});
    }, 30_000);
    // A copy that is smaller, with no row left out, shows its report in the
    // card only. Other reports are a dialog with `#remux-summary`.
    try {
      await page.locator("#remux-report").first().waitFor({ timeout: 0 });
    } finally {
      clearInterval(sampler);
    }
    const ms = performance.now() - start;
    note(`${name} ${sink}: copied in ${Math.round(ms)} ms`);
    // The last messages of a worker that ended can come a little later.
    await page.waitForTimeout(1000);
    const after: Record<string, WorkerReads> = await page.evaluate(() =>
      structuredClone(
        (window as unknown as { __workerReads: Record<string, WorkerReads> }).__workerReads,
      ),
    );
    const byKind: Record<string, { workers: number; reads: number; MiB: number; readMs: number }> =
      {};
    const total: ReadLog = { reads: 0, bytes: 0, ms: 0, log: [], lastSlice: 0 };
    for (const [id, now] of Object.entries(after)) {
      const old = before[id];
      const reads = now.reads - (old?.reads ?? 0);
      const bytes = now.bytes - (old?.bytes ?? 0);
      const readMs = now.ms - (old?.ms ?? 0);
      const kind = workerKind(now.url);
      const entry = (byKind[kind] ??= { workers: 0, reads: 0, MiB: 0, readMs: 0 });
      entry.workers++;
      entry.reads += reads;
      entry.MiB += bytes / 2 ** 20;
      entry.readMs += readMs;
      total.reads += reads;
      total.bytes += bytes;
      total.ms += readMs;
    }
    for (const entry of Object.values(byKind)) {
      entry.MiB = Math.round(entry.MiB);
      entry.readMs = Math.round(entry.readMs);
    }
    const summaryText = await page.locator("#remux-report").last().textContent();
    const outcome = await page.locator("#remux-report").first().getAttribute("data-state");
    const copy = path.join(dir!, `${label}-${name}-${sink}.zip`);
    if (sink === "download") {
      await (await download!).saveAs(copy);
    } else {
      // Save the file of the private file system with a download from a
      // Blob URL.
      const saved = page.waitForEvent("download", { timeout: 0 });
      await page.evaluate(async (file) => {
        const root = await navigator.storage.getDirectory();
        const blob = await (await root.getFileHandle(file)).getFile();
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = file;
        link.click();
      }, `${name}-zstd.zip`);
      await (await saved).saveAs(copy);
    }
    const sum = await fileSum(copy);
    writeFileSync(path.join(dir!, `${label}-${name}-${sink}.sums`), `${sum} copy\n`);
    let verified: string | undefined;
    if (verifyCopy) {
      verified = execFileSync("python3", ["-I", "-c", VERIFY_PY, copy, archive], {
        encoding: "utf8",
        maxBuffer: 1 << 20,
      }).trim();
    }
    emit({
      kind: "remux",
      archive: name,
      sink,
      outcome,
      ...perRow(total, rows, ms),
      rowsPerSecond: Math.round(rows / (ms / 1000)),
      byKind,
      summary: summaryText,
      copyBytes: statSync(copy).size,
      sha256: sum,
      verified,
      samples,
      memory: rendererMemory(profile),
    });
    rmSync(copy, { force: true });
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

/** Reads each entry of the copy (argument 1) and of the archive (argument 2)
 *  with Python `zipfile`, which checks the CRC-32 of each entry. The names,
 *  the order and the data must be the same. */
const VERIFY_PY = `
import sys, zipfile
copy = zipfile.ZipFile(sys.argv[1])
source = zipfile.ZipFile(sys.argv[2])
a = copy.infolist()
b = source.infolist()
assert [i.filename for i in a] == [i.filename for i in b], "names or order differ"
methods = {}
for x, y in zip(a, b):
    assert copy.read(x) == source.read(y), x.filename
    methods[x.compress_type] = methods.get(x.compress_type, 0) + 1
print(f"{len(a)} entries read and equal, methods {methods}")
`;

/** Opens the preview of a row and waits for its text. */
async function openPreview(page: Page, name: string, marker?: string): Promise<number> {
  await resetReads(page);
  const start = performance.now();
  await page.locator('#list-viewport [data-part="label"]', { hasText: name }).first().dblclick();
  const shown = page.locator("#preview-text");
  if (marker !== undefined) {
    await page.locator("#preview-text", { hasText: marker }).first().waitFor({ timeout: 120_000 });
  } else {
    await shown.waitFor({ timeout: 120_000 });
  }
  return performance.now() - start;
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/** The preview of the rows of the archive for a large file. */
async function largePreview(server: string, archive: string): Promise<void> {
  const { context, profile, page } = await browser();
  try {
    await page.goto(server);
    await openArchive(page, archive);
    const listed = await waitForOutcome(page, 600_000);
    if (listed.outcome !== "complete") throw new Error(`listing: ${listed.status}`);
    // The first preview starts the worker: leave it out of the samples.
    await openPreview(page, "small.txt", "small row");
    const rounds = 9;
    for (const [name, seed] of [
      ["big-stored.txt", 7],
      ["big-deflated.txt", 11],
    ] as const) {
      const marker = text(40, seed).toString();
      const times: number[] = [];
      let reads: ReadLog | undefined;
      for (let round = 0; round < rounds; round++) {
        await openPreview(page, "small.txt", "small row");
        times.push(await openPreview(page, name, marker));
        reads = await totalReads(page);
      }
      emit({
        kind: "preview",
        archive: path.basename(archive),
        row: name,
        msMedian: Number(median(times).toFixed(1)),
        msAll: times.map((time) => Math.round(time)),
        reads: reads!.reads,
        readMiB: Number((reads!.bytes / 2 ** 20).toFixed(2)),
        firstReads: reads!.log.slice(0, 12),
        memory: rendererMemory(profile),
      });
    }
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

/** Previews rows of a listed folder of a small-row archive, one after another. */
async function smallPreviews(server: string, archive: string, count: number): Promise<void> {
  const { context, profile, page } = await browser();
  try {
    await page.goto(server);
    await openArchive(page, archive);
    const listed = await waitForOutcome(page, 600_000);
    if (listed.outcome !== "complete") throw new Error(`listing: ${listed.status}`);
    // The tree starts with one folder chain down to the first files.
    for (const folder of ["module-000", "component-00"]) {
      await page
        .locator('#list-viewport [data-part="label"]', { hasText: folder })
        .first()
        .dblclick();
      await page.waitForTimeout(500);
    }
    const labels = await page.locator('#list-viewport [data-part="label"]').allTextContents();
    const files = labels.filter((one) => one.endsWith(".txt"));
    if (files.length < 2) throw new Error(`no files to preview: ${labels.join()}`);
    const contents = (index: number) =>
      text(40, Number(/file-(\d+)/.exec(files[index]!)![1]) + 1).toString();
    await openPreview(page, files[0]!, contents(0));
    const times: number[] = [];
    let reads = 0;
    let bytes = 0;
    for (let index = 1; index <= count; index++) {
      const at = index % files.length;
      times.push(await openPreview(page, files[at]!, contents(at)));
      const now = await totalReads(page);
      reads += now.reads;
      bytes += now.bytes;
    }
    emit({
      kind: "small-preview",
      archive: path.basename(archive),
      previews: times.length,
      msMedian: Number(median(times).toFixed(1)),
      readsPerPreview: Number((reads / times.length).toFixed(2)),
      kibPerPreview: Number((bytes / 1024 / times.length).toFixed(1)),
      memory: rendererMemory(profile),
    });
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

const port = process.env.ZIPSCOPE_PORT;
const server = await preview({
  configFile: new URL("../vite.config.ts", import.meta.url).pathname,
  preview: { port: Number(port ?? 0), strictPort: port !== undefined, open: false },
  logLevel: "warn",
});
try {
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error("the preview server has no local URL");
  origin = new URL(url).origin;
  const given = option("archive");
  if (args.includes("--large")) {
    const file = path.resolve(dir, "large.zip");
    if (!existsSync(file)) largeArchive(file);
    if (!remuxMode) await largePreview(url, file);
    for (const sink of sinks) {
      if (remuxMode) await remux(url, file, sink, 3);
      else await extract(url, file, sink, 3);
    }
  } else if (given !== undefined) {
    const rows = Number(option("rows") ?? 1);
    for (const sink of sinks) {
      if (remuxMode) await remux(url, path.resolve(given), sink, rows);
      else await extract(url, path.resolve(given), sink, rows);
    }
  } else {
    const file = path.resolve(dir, `small-${rowCount}-${order}${stored ? "-stored" : ""}.zip`);
    if (!existsSync(file)) smallArchive(file, rowCount, order === "shuffled");
    if (previews > 0) await smallPreviews(url, file, previews);
    for (const sink of sinks) {
      if (remuxMode) await remux(url, file, sink, rowCount);
      else await extract(url, file, sink, rowCount);
    }
  }
} finally {
  await server.close();
}
