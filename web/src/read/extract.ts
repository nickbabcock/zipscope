// Extraction in the read worker. The worker makes the plan of
// an extraction from the names in the mirrors, and then writes the files
// of the plan to the sink that the UI gives: a file or a folder of the
// File System Access API, or a stream to a service-worker download (one
// entry, or one zip of a folder), or a Blob.
//
// All data goes through the verifying reader. A file that does not verify
// is not kept: a file handle is aborted, a file in a folder is removed, a
// zip gets the entry only after a first pass verified it, and a stream of
// one entry stops with an error, so that the browser marks the download
// as failed.
//
// A folder job writes small rows at the same time, and it decodes one row at a
// time (see `FLIGHT_ROWS`).
import {
  EXTRACT_CONFIRM_BYTES,
  isBombLike,
  ExtractProgress,
  ExtractSkip,
  LocalMismatch,
  MAX_REPORT_ITEMS,
  Marks,
  PROGRESS_FLAGS_OFFSET,
  State,
  WRAPPED_REASON,
} from "../contracts";
import type {
  ExtractItem,
  ExtractPlanInfo,
  ExtractReport,
  ExtractSink,
  ExtractTarget,
} from "../contracts";
import type { MirrorReader } from "../store/reader";
import {
  ExtractPlan,
  isLink,
  releaseHeap,
  reserveHeap,
  safeFileName,
  safeFileRenamed,
  zipEstimate,
} from "../wasm/zipscope_read.js";
import type { EntryStart, ReadArchive } from "../wasm/zipscope_read.js";
import type { ReadMemory } from "./memory";
import { PortWriter, Stopped } from "./port";
import type { RowReaderAt } from "./row-reader";
import { integers } from "../format";

/** The most bytes that one decode or zip step writes. */
const STEP_BYTES = 4 * 1024 * 1024;
/** Heap for a step in addition to its output (see `READ_SLACK_BYTES` in
 *  worker.ts). */
const SLACK_BYTES = 512 * 1024;
/** The room of a step: its output, which wasm-bindgen can copy one time,
 *  and the slack. */
const STEP_ROOM_BYTES = 2 * STEP_BYTES + SLACK_BYTES;
/** The most calls in a row that give no bytes (see worker.ts). */
const MAX_EMPTY_CALLS = 256;
/** Rows of the plan between two yields. */
const PLAN_STEP = 4096;
/** The most bytes that the heap grows in one call before a zip starts
 *  (below `READ_CALL_GROWTH_BYTES`). */
const RESERVE_STEP_BYTES = 32 * 1024 * 1024;

const ZSTD_METHODS = new Set([20, 93]);
/** The number of times to try again to remove a file of a failed row, and
 *  the wait before the first try again. Each wait is longer. */
const REMOVE_RETRIES = 8;
const REMOVE_WAIT_MS = 5;
/** The most rows of a folder job that write at the same time. The cost of a small
 *  file is calls to the browser, and the browser can do them at the same time. A
 *  real folder also waits for the network at each file of some types. These waits
 *  overlap, so 8 rows are faster than 4 there. The name check and the create go one
 *  at a time, so all other files get no more gain above 4 rows. */
const FLIGHT_ROWS = 8;
/** A row that declares more than this does not overlap: it waits for the rows in
 *  flight and then decodes as it writes, so that it holds one step in memory. A row
 *  never decodes more than it declares (`Stream::read` in crates/read), so the rows
 *  in flight hold at most 4 MiB. */
const FLIGHT_ROW_BYTES = 512 * 1024;

export interface ExtractDeps {
  archive: ReadArchive;
  /** The reader of `archive`. A folder job and a zip job use its second window. */
  reader: RowReaderAt;
  limits: ReadMemory;
  mirrors: MirrorReader;
  nextTurn: () => Promise<void>;
  /** Throws when the mirrors and the record of a row do not agree. */
  agree: (row: number, start: EntryStart) => void;
  /** The archive file name. */
  archiveName: string;
}

/** A plan that the worker keeps until `extract` or `dropPlan`. */
interface Kept {
  info: ExtractPlanInfo;
  /** The folder plan, or undefined for one entry. */
  plan?: ExtractPlan;
  /** The row of one entry. */
  row?: number;
  /** The skipped and renamed items of the plan. */
  items: ExtractItem[];
  more: number;
}

/** Why one row was not written. */
class RowFailure extends Error {
  constructor(
    readonly skip: ExtractSkip,
    message: string,
  ) {
    super(message);
  }
}

const ended = (state: State) =>
  state === State.COMPLETE || state === State.CANCELLED || state === State.FAILED;

/** The last segment of a folder path, or the archive name without its
 *  extension for the whole archive. */
function folderBase(path: string, archiveName: string): string {
  const last = path.split(/[/\\]/).findLast((part) => part !== "");
  return last ?? (archiveName.replace(/\.zip$/i, "") || "archive");
}

/** Where the bytes of a stream or Blob sink go. */
interface ByteSink {
  write(bytes: Uint8Array): Promise<void>;
  end(): Promise<void>;
  fail(message: string): void;
}

export class Extractor {
  private readonly plans = new Map<number, Kept>();
  private nextId = 1;
  private busy = false;

  constructor(private readonly deps: ExtractDeps) {}

  /** Makes the plan of a target. */
  async plan(target: ExtractTarget): Promise<ExtractPlanInfo> {
    const { mirrors } = this.deps;
    const id = this.nextId++;
    if (target.kind === "entry") {
      return this.planEntry(id, target.row);
    }
    if (!ended(mirrors.state())) {
      throw new Error("Zipscope can extract a folder when the listing has ended");
    }
    const { limits } = this.deps;
    limits.arm();
    const plan = new ExtractPlan(target.path);
    const info: ExtractPlanInfo = {
      id,
      target,
      name: safeFileName(folderBase(target.path, this.deps.archiveName), "folder"),
      files: 0,
      folders: 0,
      bytes: 0,
      compressed: 0,
      large: 0,
      bombs: 0,
      largest: 0,
      skipped: 0,
      renamed: 0,
    };
    try {
      const rows = mirrors.visibleRows();
      for (let row = 0; row < rows; row++) {
        const name = mirrors.name(row);
        // The planner compares names in NFC; the read wasm has no
        // normalization tables.
        const added = plan.add(
          row,
          name,
          name.normalize("NFC"),
          mirrors.value(row, "externalAttributes"),
          mirrors.value(row, "method"),
          mirrors.value(row, "flags"),
        );
        if (added === 1) {
          const bytes = mirrors.value(row, "uncompressedSize");
          const compressed = mirrors.value(row, "compressedSize");
          info.bytes += bytes;
          info.compressed += compressed;
          info.largest = Math.max(info.largest, bytes);
          if (bytes > EXTRACT_CONFIRM_BYTES) info.large++;
          if (isBombLike(bytes, compressed)) info.bombs++;
        }
        if ((row + 1) % PLAN_STEP === 0) {
          limits.publish();
          await this.deps.nextTurn();
          limits.arm();
        }
      }
      // The items of the plan copy texts from the read wasm, which can
      // fail at the memory limit: then the plan is freed too.
      info.files = plan.files();
      info.folders = plan.folders() - 1;
      const kept: Kept = { info, plan, items: [], more: 0 };
      this.planItems(kept);
      info.skipped = plan.skipped();
      info.renamed = kept.items.length + kept.more - info.skipped;
      const estimate = zipEstimate(info.files + info.folders, plan.pathBytes());
      if (!limits.fits(estimate)) {
        info.zipError = `The memory limit leaves no room for the zip of ${integers.format(info.files)} files`;
      }
      this.plans.set(id, kept);
      return info;
    } catch (error) {
      plan.free();
      throw error;
    } finally {
      limits.publish();
    }
  }

  private planEntry(id: number, row: number): ExtractPlanInfo {
    const { mirrors } = this.deps;
    if (!Number.isSafeInteger(row) || row < 0 || row >= mirrors.visibleRows()) {
      throw new Error(`Row ${row} is not listed`);
    }
    const name = mirrors.name(row);
    const bytes = mirrors.value(row, "uncompressedSize");
    const compressed = mirrors.value(row, "compressedSize");
    const info: ExtractPlanInfo = {
      id,
      target: { kind: "entry", row },
      name: safeFileName(name, "entry"),
      files: 1,
      folders: 0,
      bytes,
      compressed,
      large: bytes > EXTRACT_CONFIRM_BYTES ? 1 : 0,
      bombs: isBombLike(bytes, compressed) ? 1 : 0,
      largest: bytes,
      skipped: 0,
      renamed: 0,
    };
    const kept: Kept = { info, row, items: [], more: 0 };
    const method = mirrors.value(row, "method");
    const flags = mirrors.value(row, "flags");
    let skip: ExtractSkip | undefined;
    if (isLink(mirrors.value(row, "externalAttributes"))) skip = ExtractSkip.LINK;
    else if (/[/\\]$/.test(name)) skip = ExtractSkip.NO_NAME;
    else if ((flags & 1) !== 0 || method === 99) skip = ExtractSkip.ENCRYPTED;
    else if (![0, 8, 20, 93].includes(method)) skip = ExtractSkip.METHOD;
    if (skip !== undefined) {
      info.files = 0;
      info.skipped = 1;
      kept.items.push({ row, name, skip });
    } else {
      // The report names a renamed entry with its archive name and its
      // output name.
      const renamed = safeFileRenamed(name, "entry");
      if (renamed !== 0) {
        kept.items.push({ row, name, path: info.name, renamed });
        info.renamed = 1;
      }
    }
    this.plans.set(id, kept);
    return info;
  }

  /** Lists the skipped rows and the renames of a folder plan. */
  private planItems(kept: Kept): void {
    const plan = kept.plan!;
    const { mirrors } = this.deps;
    const add = (item: ExtractItem) => {
      if (kept.items.length < MAX_REPORT_ITEMS) kept.items.push(item);
      else kept.more++;
    };
    const skipped = plan.skipped();
    for (let index = 0; index < skipped; index++) {
      const row = plan.skippedRow(index);
      add({ row, name: mirrors.name(row), skip: plan.skippedReason(index) as ExtractSkip });
    }
    const folders = plan.folders();
    for (let index = 1; index < folders; index++) {
      const renamed = plan.folderRenamed(index);
      if (renamed === 0) continue;
      add({
        row: -1,
        name: plan.folderSource(index),
        path: plan.folderPath(index),
        renamed,
      });
    }
    const files = plan.files();
    for (let index = 0; index < files; index++) {
      const renamed = plan.fileRenamed(index);
      if (renamed === 0) continue;
      const row = plan.fileRow(index);
      add({ row, name: mirrors.name(row), path: filePath(plan, index), renamed });
    }
  }

  /** Frees a plan. */
  drop(id: number): void {
    this.plans.get(id)?.plan?.free();
    this.plans.delete(id);
  }

  /** Writes the files of a plan. */
  async extract(id: number, sink: ExtractSink, buffer: SharedArrayBuffer): Promise<ExtractReport> {
    const kept = this.plans.get(id);
    if (kept === undefined) throw new Error(`No plan ${id}`);
    if (this.busy) throw new Error("An extraction is in progress");
    this.busy = true;
    this.plans.delete(id);
    const job = new Job(this.deps, kept, buffer);
    try {
      return await job.run(sink);
    } finally {
      kept.plan?.free();
      this.busy = false;
    }
  }
}

function filePath(plan: ExtractPlan, index: number): string {
  return plan.folderPath(plan.fileFolder(index)) + plan.fileName(index);
}

/** The raw segments of a name, as the planner splits it: on `/` and `\`,
 *  without empty segments. */
const rawSegments = (name: string) => name.split(/[/\\]/).filter((part) => part !== "");

/** The path of a folder of the plan in the archive, with a `/` at the
 *  end, as `folderSource` gives it. The planner keeps this path only for a
 *  renamed folder. For a folder that is not renamed, this function makes
 *  it as the planner does: from the name of the row of the folder, it
 *  takes the segments of the folder of the plan and then the kept
 *  segments (without `.`) down to the folder. Thus a failed folder and its
 *  files show the same kind of path in the report.
 *
 *  This is a copy of the `source` closure in `Planner::add`
 *  (`crates/read/src/sanitize.rs`). If you change one of the two, change
 *  the other. The tests in `extract-folder-wasm.test.ts` check that the
 *  two agree. */
function folderSource(
  plan: ExtractPlan,
  index: number,
  folder: string,
  mirrors: MirrorReader,
): string {
  const source = plan.folderSource(index);
  if (source !== "") return source;
  const row = plan.folderRow(index);
  if (row === 0xffffffff) return plan.folderPath(index);
  let depth = 0;
  for (let parent = plan.folderParent(index); parent !== 0; parent = plan.folderParent(parent)) {
    depth++;
  }
  const prefix = rawSegments(folder).length;
  const kept = rawSegments(mirrors.name(row)).filter(
    (part, position) => position < prefix || part !== ".",
  );
  return `${kept.slice(0, prefix + depth + 1).join("/")}/`;
}

/** One run of `extract`. */
class Job {
  private readonly values: Float64Array;
  private readonly flags: Int32Array;
  private readonly report: ExtractReport;

  constructor(
    private readonly deps: ExtractDeps,
    private readonly kept: Kept,
    buffer: SharedArrayBuffer,
  ) {
    this.values = new Float64Array(buffer, 0, 4);
    this.flags = new Int32Array(buffer, PROGRESS_FLAGS_OFFSET, 2);
    this.values[ExtractProgress.TOTAL_BYTES] = kept.info.bytes;
    this.values[ExtractProgress.TOTAL_FILES] = kept.info.files;
    this.report = {
      outcome: "complete",
      written: 0,
      bytes: 0,
      items: [...kept.items],
      more: kept.more,
    };
  }

  private cancelled = () => Atomics.load(this.flags, ExtractProgress.CANCEL) !== 0;

  private checkCancel(): void {
    if (this.cancelled()) throw new Stopped("The extraction was cancelled");
  }

  private add(item: ExtractItem): void {
    if (this.report.items.length < MAX_REPORT_ITEMS) this.report.items.push(item);
    else this.report.more++;
  }

  private progress(bytes: number, files = 0): void {
    this.values[ExtractProgress.BYTES]! += bytes;
    this.values[ExtractProgress.FILES]! += files;
  }

  async run(sink: ExtractSink): Promise<ExtractReport> {
    try {
      if (this.kept.row !== undefined) {
        await this.runEntry(this.kept.row, sink);
      } else if (sink.kind === "directory") {
        await this.withJobWindow(() => this.runFolder(sink.handle, sink.name));
      } else if (sink.kind === "file") {
        throw new Error("A folder cannot go to one file");
      } else {
        await this.withJobWindow(() => this.runZip(sink));
      }
    } catch (error) {
      if (error instanceof Stopped) {
        this.report.outcome = "cancelled";
      } else {
        this.report.outcome = "failed";
        this.report.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.deps.limits.publish();
    }
    return this.report;
  }

  /** Runs a folder job or a zip job with the second window of the reader, and
   *  frees the window when the job ends, on each path. */
  private async withJobWindow(run: () => Promise<void>): Promise<void> {
    const { archive, reader } = this.deps;
    archive.setJobRecords(reader.startJob());
    try {
      await run();
    } finally {
      archive.setJobRecords(undefined);
      reader.endJob();
    }
  }

  /** The Zstandard window of a step: the free heap less the step. */
  private window(): number {
    return Math.max(0, this.deps.limits.free() - STEP_ROOM_BYTES - SLACK_BYTES);
  }

  /** Decodes one row and gives each part to `write`. Throws a
   *  `RowFailure` when the row cannot be decoded or does not verify. */
  /** `open` runs after the checks of the row passed, before the first
   *  byte: a file is made only for a row whose local header agrees. */
  private async decode(
    row: number,
    open: () => Promise<(bytes: Uint8Array) => Promise<void> | void>,
  ): Promise<number> {
    const { archive, limits, mirrors } = this.deps;
    // The parse decides the place of a row, and only here: a row with this
    // mark is not at the offset that the read module reads.
    if ((mirrors.value(row, "marks") & Marks.WRAPPED_OFFSET) !== 0) {
      throw new RowFailure(ExtractSkip.LOCAL_HEADER, WRAPPED_REASON);
    }
    if (!limits.fits(STEP_ROOM_BYTES)) {
      throw new RowFailure(
        ExtractSkip.MEMORY,
        "The memory limit leaves no room to decode this entry",
      );
    }
    limits.arm();
    const reader = archive.openEntry(row, this.window());
    limits.publish();
    try {
      const info = reader.info();
      try {
        if (info.error !== undefined) {
          // No local header, or no record: the entry is skipped before
          // decoding, as a local header that does not agree.
          const skip = /memory limit/.test(info.error)
            ? ExtractSkip.MEMORY
            : /local header|record|cannot be found/.test(info.error)
              ? ExtractSkip.LOCAL_HEADER
              : ExtractSkip.VERIFY;
          throw new RowFailure(skip, info.error);
        }
        this.deps.agree(row, info);
        if ((info.mismatches & (LocalMismatch.NAME | LocalMismatch.SIZES)) !== 0) {
          throw new RowFailure(
            ExtractSkip.LOCAL_HEADER,
            "The local header does not agree with the central directory",
          );
        }
      } finally {
        info.free();
      }
      const write = await open();
      let total = 0;
      let empty = 0;
      for (;;) {
        this.checkCancel();
        if (!limits.fits(STEP_ROOM_BYTES)) {
          throw new RowFailure(
            ExtractSkip.MEMORY,
            "The memory limit leaves no room to decode this entry",
          );
        }
        limits.arm();
        const part = reader.read(STEP_BYTES, this.window());
        limits.publish();
        const state = reader.state();
        if (part.length > 0) {
          empty = 0;
          total += part.length;
          this.progress(part.length);
          await write(part);
        } else if (++empty > MAX_EMPTY_CALLS && state === 0) {
          throw new RowFailure(ExtractSkip.VERIFY, "Decoding did not go forward");
        }
        if (state === 1) return total;
        if (state === 2) {
          const message = reader.error() ?? "Decoding failed";
          const skip = /memory limit/.test(message) ? ExtractSkip.MEMORY : ExtractSkip.VERIFY;
          throw new RowFailure(skip, message);
        }
      }
    } finally {
      reader.free();
    }
  }

  /** Adds a failed row to the report. `note` goes after the reason. */
  private failRow(row: number, error: unknown, path?: string, note?: string): void {
    const { mirrors } = this.deps;
    const item: ExtractItem = { row, name: mirrors.name(row) };
    if (error instanceof RowFailure) {
      item.skip = error.skip;
      item.detail = error.message;
    } else {
      item.skip = ExtractSkip.WRITE;
      item.detail = error instanceof Error ? error.message : String(error);
    }
    if (path !== undefined) item.path = path;
    if (note !== undefined) item.detail = `${item.detail!.replace(/\.$/, "")}. ${note}`;
    this.add(item);
  }

  /** One entry to a file handle, a stream or a Blob. */
  private async runEntry(row: number, sink: ExtractSink): Promise<void> {
    if (this.kept.info.files === 0) {
      // The plan skipped the entry; the report lists why.
      this.report.outcome = "failed";
      this.report.error = "Zipscope does not extract this entry";
      if (sink.kind === "stream") new PortWriter(sink.port, () => {}).fail(this.report.error);
      return;
    }
    this.report.output = this.kept.info.name;
    /** Records a row that did not write. A cancel stays a cancel. */
    const failed = (error: unknown) => {
      if (error instanceof Stopped) throw error;
      this.failRow(row, error);
      this.report.outcome = "failed";
      this.report.error = error instanceof Error ? error.message : String(error);
      this.progress(0, 1);
    };
    if (sink.kind === "file") {
      let writable: FileSystemWritableFileStream | undefined;
      try {
        await this.decode(row, async () => {
          const target = await sink.handle.createWritable();
          writable = target;
          return (bytes) => target.write(bytes as Uint8Array<ArrayBuffer>);
        });
        await writable!.close();
      } catch (error) {
        // `abort` drops the written bytes and keeps the file as it was.
        // The picker can give a file that has the data of the user, so the
        // worker never removes it.
        const open = writable as FileSystemWritableFileStream | undefined;
        await open?.abort().catch(() => {});
        failed(error);
        return;
      }
    } else {
      const out = this.byteSink(sink);
      try {
        await this.decode(row, async () => (bytes) => out.write(bytes));
        await out.end();
      } catch (error) {
        out.fail(error instanceof Error ? error.message : String(error));
        failed(error);
        return;
      }
    }
    this.report.written = 1;
    this.report.bytes = this.values[ExtractProgress.BYTES]!;
    this.progress(0, 1);
  }

  /** The stream or Blob output. */
  private byteSink(sink: ExtractSink): ByteSink & { blob?: () => Blob } {
    if (sink.kind === "stream") {
      const writer = new PortWriter(sink.port, () =>
        Atomics.store(this.flags, ExtractProgress.STARTED, 1),
      );
      return {
        write: (bytes) => writer.write(bytes, this.cancelled),
        end: () => writer.end(this.cancelled),
        fail: (message) => writer.fail(message),
      };
    }
    // A Blob keeps its parts in browser storage, not in the wasm memory.
    const parts: Blob[] = [];
    Atomics.store(this.flags, ExtractProgress.STARTED, 1);
    return {
      write: async (bytes) => {
        parts.push(new Blob([bytes as Uint8Array<ArrayBuffer>]));
      },
      end: async () => {
        this.report.blob = new Blob(parts);
      },
      fail: () => {
        parts.length = 0;
      },
    };
  }

  /** A folder to a directory handle. */
  private async runFolder(root: FileSystemDirectoryHandle, base: string): Promise<void> {
    const plan = this.kept.plan!;
    const target = this.kept.info.target;
    const planFolder = target.kind === "folder" ? target.path : "";
    const output = await uniqueFolder(root, base);
    this.report.output = output.name;
    const handles: (FileSystemDirectoryHandle | undefined)[] = [output];
    const folders = plan.folders();
    for (let index = 1; index < folders; index++) {
      this.checkCancel();
      const parent = handles[plan.folderParent(index)];
      // The files of a folder whose parent was not made fail on their own.
      if (parent === undefined) continue;
      const name = plan.folderName(index);
      try {
        // As for a file: in the new output folder, a name that is there
        // can only come from a collision that the plan did not see. Never
        // join the folder into it; its files then fail.
        if (await folderExists(parent, name)) {
          throw new Error("A folder with the same name was made before (a name collision)");
        }
        handles[index] = await parent.getDirectoryHandle(name, { create: true });
      } catch (error) {
        handles[index] = undefined;
        this.add({
          row: -1,
          name: folderSource(plan, index, planFolder, this.deps.mirrors),
          path: plan.folderPath(index),
          skip: ExtractSkip.WRITE,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const files = plan.files();
    // The rows in flight, in row order. A promise never rejects, and it resolves
    // when the file of the row is complete or is removed. Its value adds the row to
    // the report.
    const flight: Promise<() => void>[] = [];
    // The rows go to the report in row order, so the report does not change when
    // they end in another order.
    const retire = async () => (await flight.shift()!)();
    // The name checks and the creates go one at a time, in row order.
    let named: Promise<unknown> = Promise.resolve();
    const inTurn = (step: () => Promise<FileSystemFileHandle>) => {
      const result = named.then(step);
      named = result.then(
        () => {},
        () => {},
      );
      return result;
    };
    try {
      for (let index = 0; index < files; index++) {
        while (flight.length >= FLIGHT_ROWS) await retire();
        this.checkCancel();
        const row = plan.fileRow(index);
        const name = plan.fileName(index);
        const path = filePath(plan, index);
        const folder = handles[plan.fileFolder(index)];
        if (folder === undefined) {
          const commit = () => {
            this.failRow(
              row,
              new RowFailure(ExtractSkip.WRITE, "Its folder could not be made"),
              path,
            );
            this.progress(0, 1);
          };
          flight.push(Promise.resolve(commit));
          continue;
        }
        this.deps.reader.startJobRow();
        if (this.deps.mirrors.value(row, "uncompressedSize") > FLIGHT_ROW_BYTES) {
          while (flight.length > 0) await retire();
          const commit = await this.writeRow(row, folder, name, path, async (open) => {
            await this.decode(row, open);
          });
          commit();
          continue;
        }
        // Decode before the first file step, with no other row in decode. Thus
        // the reads of the rows come in row order, as with one row at a time, and
        // the wasm has one stream.
        const parts: Uint8Array[] = [];
        let opened = false;
        let failure: { error: unknown } | undefined;
        try {
          await this.decode(row, async () => {
            opened = true;
            return (part) => {
              parts.push(part);
            };
          });
        } catch (error) {
          if (error instanceof Stopped) throw error;
          failure = { error };
        }
        if (failure !== undefined && !opened) {
          const { error } = failure;
          const commit = () => {
            this.failRow(row, error, path);
            this.progress(0, 1);
          };
          flight.push(Promise.resolve(commit));
          continue;
        }
        // A row that fails in its decode does the file steps too, in the same
        // order as a row that decodes as it writes. Thus a name collision and a
        // failed write give the same report item.
        flight.push(
          this.writeRow(
            row,
            folder,
            name,
            path,
            async (open) => {
              const write = await open();
              for (const part of parts) await write(part);
              if (failure !== undefined) throw failure.error;
            },
            inTurn,
            [...flight],
          ),
        );
      }
    } finally {
      // A stop starts no more rows. Each row in flight ends and goes to the report,
      // so the report counts each file, and no partial file stays.
      await Promise.allSettled(flight);
      while (flight.length > 0) await retire();
    }
  }

  /**
   * Does the file steps of one row, and gives the function that adds the row to
   * the report. `fill` writes the bytes through its argument, which makes the file.
   * A failed row is aborted and removed before the function returns. Only a stop
   * rejects, and only a row that decodes as it writes can see a stop.
   */
  private async writeRow(
    row: number,
    folder: FileSystemDirectoryHandle,
    name: string,
    path: string,
    fill: (open: () => Promise<(bytes: Uint8Array) => Promise<void>>) => Promise<void>,
    inTurn: (step: () => Promise<FileSystemFileHandle>) => Promise<FileSystemFileHandle> = (step) =>
      step(),
    earlier: readonly Promise<unknown>[] = [],
  ): Promise<() => void> {
    let writable: FileSystemWritableFileStream | undefined;
    let made = false;
    try {
      await fill(async () => {
        const handle = await inTurn(() => makeFile(folder, name, earlier));
        made = true;
        const target = await handle.createWritable();
        writable = target;
        return (bytes) => target.write(bytes as Uint8Array<ArrayBuffer>);
      });
      await writable!.close();
      return () => {
        this.report.written++;
        this.report.bytes += this.deps.mirrors.value(row, "uncompressedSize");
        this.progress(0, 1);
      };
    } catch (error) {
      const open = writable as FileSystemWritableFileStream | undefined;
      await open?.abort().catch(() => {});
      // Remove the file before the row goes into the report: when the
      // report shows, no file of a failed row stays.
      const removed = !made || (await removeFile(folder, name));
      if (error instanceof Stopped) throw error;
      return () => {
        this.failRow(
          row,
          error,
          path,
          removed ? undefined : "The file that was made for it could not be removed",
        );
        this.progress(0, 1);
      };
    }
  }

  /** A folder as one zip, to a stream or a Blob. */
  private async runZip(sink: ExtractSink): Promise<void> {
    const plan = this.kept.plan!;
    const { archive, limits, mirrors } = this.deps;
    const out = this.byteSink(sink);
    this.report.output = `${this.kept.info.name}.zip`;
    const files = plan.files();
    const folders = plan.folders();
    try {
      // Grow the heap for the central directory before the zip starts, in
      // steps, so that no later call grows it by much.
      const estimate = zipEstimate(files + folders, plan.pathBytes());
      if (!limits.fits(estimate)) {
        throw new Error(
          `The memory limit leaves no room for the zip of ${integers.format(files)} files`,
        );
      }
      const target = limits.memoryBytes() + estimate;
      while (limits.memoryBytes() < target) {
        limits.arm();
        const step = Math.min(RESERVE_STEP_BYTES, target - limits.memoryBytes());
        const held = reserveHeap(step);
        limits.publish();
        if (!held) break;
        await this.deps.nextTurn();
      }
      releaseHeap();
      limits.arm();
      archive.zipBegin(files + folders);
      limits.publish();
      const drain = async () => {
        while (archive.zipPending() > 0) {
          await out.write(archive.zipTake(STEP_BYTES));
        }
      };
      for (let index = 1; index < folders; index++) {
        this.checkCancel();
        const row = plan.folderRow(index);
        const modified = row === 0xffffffff ? NaN : mirrors.value(row, "modified");
        limits.arm();
        archive.zipFolder(plan.folderPath(index), modified);
        limits.publish();
        await drain();
      }
      for (let index = 0; index < files; index++) {
        this.checkCancel();
        const row = plan.fileRow(index);
        const path = filePath(plan, index);
        // The two passes of a row are one row for the check of the file.
        this.deps.reader.startJobRow();
        // The first pass verifies the data, so that the zip never gets an
        // entry whose data is wrong.
        try {
          await this.decode(row, async () => () => {});
        } catch (error) {
          if (error instanceof Stopped) throw error;
          this.failRow(row, error, path);
          this.progress(0, 1);
          continue;
        }
        const decode = ZSTD_METHODS.has(mirrors.value(row, "method"));
        limits.arm();
        archive.zipFile(row, path, decode, mirrors.value(row, "modified"), this.window());
        limits.publish();
        let empty = 0;
        for (;;) {
          this.checkCancel();
          limits.arm();
          const pending = archive.zipPending();
          const done = archive.zipStep(STEP_BYTES, this.window());
          limits.publish();
          empty = archive.zipPending() === pending ? empty + 1 : 0;
          await drain();
          if (done) break;
          if (empty > MAX_EMPTY_CALLS) throw new Error("The zip did not go forward");
        }
        this.report.written++;
        this.report.bytes += mirrors.value(row, "uncompressedSize");
        this.progress(0, 1);
      }
      limits.arm();
      archive.zipFinish();
      limits.publish();
      await drain();
      await out.end();
    } catch (error) {
      out.fail(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      archive.zipEnd();
      limits.publish();
    }
  }
}

/**
 * The name check and the create of a file. The output folder is new, so a name
 * that is there already can only come from a collision that the plan did not see.
 * Never open it: a missed collision gives a failed row, not a file that replaces
 * a written file.
 *
 * A name that is there can be the name of a row in flight, and this row can fail
 * and remove its file. Then wait for the `earlier` rows and check again, so that
 * the result is the same as with one row at a time. Only the file system decides if
 * two names are one file, so this code does not compare the names of two rows.
 *
 * `createWritable` makes a swap file in the folder, and it does not go in the turn
 * of the name steps. A row that a file system joins with a swap file of a row in
 * flight can then find no file and open this swap file. The row can then write over
 * the other row, with no error. Thus each row waits for the `earlier` rows before its
 * check, and only a plain name does not wait (see `isPlainName`).
 */
async function makeFile(
  folder: FileSystemDirectoryHandle,
  name: string,
  earlier: readonly Promise<unknown>[],
): Promise<FileSystemFileHandle> {
  if (!isPlainName(name)) await Promise.all(earlier);
  if (await exists(folder, name)) {
    await Promise.all(earlier);
    if (await exists(folder, name)) {
      throw new RowFailure(
        ExtractSkip.WRITE,
        "A file with the same name was written before (a name collision)",
      );
    }
  }
  return folder.getFileHandle(name, { create: true });
}

/** The longest plain name. A file system can cut a long name, and a cut name can
 *  have lost the end of a swap name. */
const PLAIN_NAME_CHARS = 128;
/**
 * The characters of a plain name: ASCII letters, digits, `_`, `-`, `.`, a space, and
 * punctuation that has no known use to join two names. These stay out:
 * - `%`, because a layer that decodes a name a second time can change `%72` to `r`,
 *   and `SWAP_NAME_PART` cannot see this.
 * - `~`, because a file system uses it in short names.
 * - The characters that the plan changes, and all characters that are not ASCII. A
 *   file system can ignore or change them.
 */
const PLAIN_NAME = /^[A-Za-z0-9_\-. ()[\]+,=@#&'!$;^{}`]+$/;
/** Windows removes a last dot or space. A file system can also make a file with a
 *  first dot next to another file. A first space goes with these, because the browser
 *  refuses it on a real folder. */
const NOT_PLAIN_ENDS = /^[ .]|[ .]$/;
/**
 * A swap file of Chromium has `.crswap` in its name, in `<name>.crswap` or
 * `<name>.1.crswap`. A file system can change the case or cut the end of it. A layer
 * can remove a space or other punctuation, so this ignores punctuation between the
 * letters. Thus `a.c rswap` and `a.c(r)swap` wait.
 */
const SWAP_NAME_PART = /c[^a-z0-9]*r[^a-z0-9]*s/i;

/**
 * True when the file `name` can overlap the swap files of earlier rows. This is a
 * list of what can overlap, and all other names wait. A false result only makes the
 * row slower. The rule uses the swap name of Chromium, and `web/e2e/swap-name.spec.ts`
 * fails when this swap name changes in the Chromium of the tests.
 */
export function isPlainName(name: string): boolean {
  return (
    name.length <= PLAIN_NAME_CHARS &&
    PLAIN_NAME.test(name) &&
    !NOT_PLAIN_ENDS.test(name) &&
    !SWAP_NAME_PART.test(name)
  );
}

/** True when `folder` has an entry `name`: a file, or a folder. */
async function exists(folder: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await folder.getFileHandle(name);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return false;
    // A folder with this name, or another error: do not write here.
    return true;
  }
}

/**
 * Removes the file `name` of a failed row from `folder`. Returns false when
 * the file stays.
 *
 * Chromium can keep the lock of a writable for a short time after its
 * `abort()` promise resolves. Then `removeEntry` fails with
 * NoModificationAllowedError, most often when the row failed before its
 * first byte. Thus try again after a short wait, until the lock is free.
 */
async function removeFile(folder: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await folder.removeEntry(name);
      return true;
    } catch (error) {
      if (!(error instanceof DOMException)) return false;
      if (error.name === "NotFoundError") return true;
      if (error.name !== "NoModificationAllowedError" || attempt >= REMOVE_RETRIES) return false;
    }
    await new Promise((resolve) => setTimeout(resolve, REMOVE_WAIT_MS << attempt));
  }
}

/** True when `folder` has an entry `name`: a folder, or a file. */
async function folderExists(folder: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await folder.getDirectoryHandle(name);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return false;
    // A file with this name, or another error: do not make it here.
    return true;
  }
}

/** Makes a new folder `base` in `root`, or `base (2)` and so on when the
 *  name is used, so that an extraction never writes into a folder that
 *  has files. */
async function uniqueFolder(
  root: FileSystemDirectoryHandle,
  base: string,
): Promise<FileSystemDirectoryHandle> {
  for (let number = 1; number < 10_000; number++) {
    const name = number === 1 ? base : `${base} (${number})`;
    try {
      await root.getDirectoryHandle(name);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        return root.getDirectoryHandle(name, { create: true });
      }
      // A file with this name: try the next name.
      if (!(error instanceof DOMException && error.name === "TypeMismatchError")) throw error;
    }
  }
  throw new Error("No free folder name");
}
