// The second window of a folder job and a zip job, through the real worker and
// the real read wasm: the check of the file for each output row, and the end of
// the window on each path. Its own file gives it a new wasm instance.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ExtractProgress,
  ExtractSkip,
  PROGRESS_BYTES,
  PROGRESS_FLAGS_OFFSET,
  State,
} from "../contracts";
import { JOB_CHECK_ROWS } from "./row-reader";
import { crc32, giveNames, header, openWorker, zip } from "./wasm-harness";
import type { Entry } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ROWS = 1400;
/** 1,400 rows of 4 KiB are more than the window of 4 MiB, and the first window
 *  holds the first 1,000 rows. The second window holds their records. */
const ROW_BYTES = 4096;
const REFUSED = "The central-directory record cannot be read: The file could not be read";
/** `RECORD_READ_BYTES` in crates/read/src/local.rs. */
const RECORD_READ_BYTES = 46 + 256;

const rowName = (row: number) => `f/row-${String(row).padStart(4, "0")}.bin`;

function rowBody(row: number): Uint8Array {
  const body = new Uint8Array(ROW_BYTES);
  new DataView(body.buffer).setUint32(0, row, true);
  return body.fill(row & 0xff, 4);
}

const ENTRIES: Entry[] = Array.from({ length: ROWS }, (_, row) => ({
  name: rowName(row),
  body: rowBody(row),
}));

/** The state of all folders of a job. With `slow`, each close waits for a turn of
 *  the event loop, so that rows are in flight when other rows start. */
interface Writes {
  slow: boolean;
  open: number;
  peak: number;
}

/** Rows that went to a folder, by name. */
class Folder {
  readonly files = new Map<string, Uint8Array>();
  readonly folders = new Map<string, Folder>();

  constructor(private readonly writes: Writes) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let folder = this.folders.get(name);
    if (folder === undefined) {
      if (options?.create !== true) throw new DOMException("No folder", "NotFoundError");
      folder = new Folder(this.writes);
      this.folders.set(name, folder);
    }
    return folder;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (options?.create !== true) throw new DOMException("No file", "NotFoundError");
    const { files, writes } = this;
    return {
      async createWritable() {
        const parts: Uint8Array[] = [];
        writes.peak = Math.max(writes.peak, ++writes.open);
        return {
          async write(bytes: Uint8Array) {
            parts.push(bytes.slice());
          },
          async close() {
            if (writes.slow) await new Promise((resolve) => setTimeout(resolve, 0));
            writes.open--;
            const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
            let at = 0;
            for (const part of parts) {
              data.set(part, at);
              at += part.length;
            }
            files.set(name, data);
          },
          async abort() {},
        };
      },
    };
  }

  async removeEntry(name: string) {
    this.files.delete(name);
  }
}

/** The files of a zip with stored entries, by name, from the central directory. */
function zipFiles(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const found = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip = view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const data =
      offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    found.set(name, bytes.subarray(data, data + size));
    at += 46 + nameLength + skip;
  }
  return found;
}

type Sink = "folder" | "folder with rows in flight" | "zip";

interface Glue {
  ReadArchive: { prototype: Record<string, (...args: never[]) => unknown> };
}

/** Opens the worker on the rows, and wraps the reads of the file. */
async function setup(entries = ENTRIES) {
  const { bytes, pages } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, entries.length), pages);
  await giveNames(
    api,
    pages,
    entries.map((entry) => entry.name),
  );
  const file = { failure: undefined as Error | undefined, reads: [] as number[] };
  const Sync = (
    globalThis as unknown as {
      FileReaderSync: { prototype: { readAsArrayBuffer(blob: unknown): ArrayBuffer } };
    }
  ).FileReaderSync;
  const read = Sync.prototype.readAsArrayBuffer;
  Sync.prototype.readAsArrayBuffer = function (blob) {
    if (file.failure !== undefined) throw file.failure;
    const bytesRead = read.call(this, blob);
    file.reads.push(bytesRead.byteLength);
    return bytesRead;
  };
  const glue = (await import("../wasm/zipscope_read.js")) as unknown as Glue;
  return { api, file, glue };
}

async function extract(sink: Sink, api: Awaited<ReturnType<typeof setup>>["api"]) {
  const plan = await api.plan({ kind: "folder", path: "f/" });
  const progress = new SharedArrayBuffer(PROGRESS_BYTES);
  if (sink !== "zip") {
    const writes = { slow: sink !== "folder", open: 0, peak: 0 };
    const root = new Folder(writes);
    const report = await api.extract(
      plan.id,
      { kind: "directory", handle: root as unknown as FileSystemDirectoryHandle, name: "f" },
      progress,
    );
    return { report, files: root.folders.get("f")!.files, peak: writes.peak };
  }
  const report = await api.extract(plan.id, { kind: "blob" }, progress);
  const files = zipFiles(new Uint8Array(await report.blob!.arrayBuffer()));
  return { report, files, peak: 0 };
}

/** Each written row has the bytes of the listing, and they are the first rows. */
function expectFirstRows(files: Map<string, Uint8Array>, count: number) {
  expect(files.size).toBe(count);
  for (let row = 0; row < count; row++) {
    const data = files.get(rowName(row).slice(2));
    expect(data).toBeDefined();
    expect(crc32(data!)).toBe(crc32(rowBody(row)));
  }
}

const notReadable = () => new DOMException("The file changed", "NotReadableError");

describe.each<Sink>(["folder", "folder with rows in flight", "zip"])(
  "the check of the file, to a %s",
  (sink) => {
    test("no change: the output has all rows, with one check for 256 output rows", async () => {
      const { api, file } = await setup();
      const { report, files, peak } = await extract(sink, api);
      expect(report.outcome).toBe("complete");
      expect(report.items).toEqual([]);
      expectFirstRows(files, ROWS);
      if (sink === "folder with rows in flight") expect(peak).toBe(8);
      // The reads of the plan come before the job, and the pass of the central
      // directory asks for more than one record.
      const checks = file.reads.filter((length) => length === RECORD_READ_BYTES);
      expect(checks).toHaveLength(Math.ceil(ROWS / JOB_CHECK_ROWS));
      expect(file.reads.length).toBeLessThan(Math.ceil(ROWS / JOB_CHECK_ROWS) + 10);
    }, 120_000);

    test.each([
      // The check of the first row finds the change.
      { before: 0, written: 0 },
      // The check does not fill a window. In a folder job, the second row fills
      // the second window, and this fill finds the change. In a zip, the second
      // pass of the first row filled it, so the change stays until the next check.
      { before: 1, written: sink === "zip" ? 256 : 1 },
      { before: 2, written: 256 },
      // The check of a later row finds the change, and its row writes nothing.
      { before: 256, written: 256 },
      { before: 300, written: 512 },
      // The true limit: row 256 passed its check, and then 255 rows start.
      { before: 257, written: 512 },
      { before: 512, written: 512 },
    ])(
      "a change before row $before starts leaves the first $written rows",
      async ({ before, written }) => {
        const { api, file } = await setup();
        const { RowReaderAt: Reader } = await import("./row-reader");
        const start = Reader.prototype.startJobRow;
        let row = 0;
        Reader.prototype.startJobRow = function () {
          if (row === before) file.failure = notReadable();
          row++;
          start.call(this);
        };
        const { report, files } = await extract(sink, api);
        expectFirstRows(files, written);
        expect(written === 0 || before + JOB_CHECK_ROWS > written).toBe(true);
        expect(report.written).toBe(written);
        expect(report.outcome).toBe("complete");
        expect(report.items.length + report.more).toBe(ROWS - written);
        for (const item of report.items) {
          expect(item.skip).toBe(ExtractSkip.LOCAL_HEADER);
          expect(item.detail).toBe(REFUSED);
        }
      },
      120_000,
    );
  },
);

describe("a change between the two passes of a row of a zip", () => {
  test("the row comes from the windows, and the next check finds the change", async () => {
    const { api, file, glue } = await setup();
    const original = glue.ReadArchive.prototype.zipFile!;
    glue.ReadArchive.prototype.zipFile = function (this: unknown, ...args: never[]) {
      if ((args[0] as unknown as number) === 256) file.failure = notReadable();
      return original.apply(this, args);
    } as never;
    const { report, files } = await extract("zip", api);
    expectFirstRows(files, 512);
    expect(report.items.length + report.more).toBe(ROWS - 512);
    expect(report.outcome).toBe("complete");
  }, 120_000);

  test("when no window holds the record, the job fails with the error of the file", async () => {
    const { api, file, glue } = await setup();
    const original = glue.ReadArchive.prototype.zipFile!;
    glue.ReadArchive.prototype.zipFile = function (this: unknown, ...args: never[]) {
      // The first row made its record read with a check, so no window has it.
      if ((args[0] as unknown as number) === 0) file.failure = notReadable();
      return original.apply(this, args);
    } as never;
    const plan = await api.plan({ kind: "folder", path: "f/" });
    const report = await api.extract(
      plan.id,
      { kind: "blob" },
      new SharedArrayBuffer(PROGRESS_BYTES),
    );
    expect(report.outcome).toBe("failed");
    expect(report.error).toBe(REFUSED);
    expect(report.blob).toBeUndefined();
  }, 120_000);
});

describe("the second window ends with the job", () => {
  async function spies() {
    const { RowReaderAt: Reader } = await import("./row-reader");
    return {
      start: vi.spyOn(Reader.prototype, "startJob"),
      end: vi.spyOn(Reader.prototype, "endJob"),
    };
  }

  const few = ENTRIES.slice(0, 8);

  test("after the job ends in the normal way", async () => {
    const { api } = await setup(few);
    const { start, end } = await spies();
    const { report } = await extract("zip", api);
    expect(report.outcome).toBe("complete");
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  }, 60_000);

  test("after a cancel", async () => {
    const { api } = await setup(few);
    const { start, end } = await spies();
    const plan = await api.plan({ kind: "folder", path: "f/" });
    const progress = new SharedArrayBuffer(PROGRESS_BYTES);
    new Int32Array(progress, PROGRESS_FLAGS_OFFSET, 2)[ExtractProgress.CANCEL] = 1;
    const report = await api.extract(plan.id, { kind: "blob" }, progress);
    expect(report.outcome).toBe("cancelled");
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  }, 60_000);

  test("after a failure of the job", async () => {
    const { api } = await setup(few);
    const { start, end } = await spies();
    const plan = await api.plan({ kind: "folder", path: "f/" });
    const root = {
      getDirectoryHandle: async () => {
        throw new Error("The disk is gone");
      },
    };
    const report = await api.extract(
      plan.id,
      { kind: "directory", handle: root as unknown as FileSystemDirectoryHandle, name: "f" },
      new SharedArrayBuffer(PROGRESS_BYTES),
    );
    expect(report.outcome).toBe("failed");
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  }, 60_000);

  test("a single entry and a preview have no second window", async () => {
    const { api, file } = await setup(few);
    const { start } = await spies();
    const plan = await api.plan({ kind: "entry", row: 1 });
    const report = await api.extract(
      plan.id,
      { kind: "blob" },
      new SharedArrayBuffer(PROGRESS_BYTES),
    );
    expect(report.written).toBe(1);
    file.reads = [];
    const chunk = await api.read(2, 0, 1024);
    expect(chunk.check.error).toBeUndefined();
    expect(file.reads).toContain(RECORD_READ_BYTES);
    expect(start).not.toHaveBeenCalled();
  }, 60_000);
});
