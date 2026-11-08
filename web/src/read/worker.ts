// The read worker. It starts on the first preview of an archive, with its
// own wasm bundle, and stops when the archive closes. It gets the File and
// the shared mirrors from the UI. On open, it makes the wayfinder table in
// steps between requests.
// The table covers only committed rows. The worker writes its memory to
// `READ_KIB`, and the memory budget counts it.
import * as Comlink from "comlink";
import { HARD_BUDGET_BYTES, Marks, readReserve, State, WRAPPED_REASON } from "../contracts";
import type {
  ArchiveLayout,
  ArchiveTotals,
  EntryCheck,
  ReadChunk,
  ReadWorkerApi,
} from "../contracts";
import { WindowReaderAt } from "../parse/reader";
import { MirrorReader } from "../store/reader";
import init, { ReadArchive } from "../wasm/zipscope_read.js";
import { Extractor } from "./extract";
import { ReadMemory } from "./memory";
import { RowReaderAt } from "./row-reader";
import type { EntryStart } from "../wasm/zipscope_read.js";
import { byteMap, factsOf, totalsOf } from "./layout";
import { WayfinderScan } from "./scan";

/** The most bytes that one read decodes. */
const MAX_READ_BYTES = 16 * 1024 * 1024;
/** The most calls in a row that give no bytes. A call gives no bytes when a
 *  Zstandard frame with a larger window waits for the next call, after an
 *  empty frame. Each such call goes past a frame, and the window grows
 *  each time, so there are at most about 130 such calls (the window sizes
 *  up to 32 MiB). The limit stops a loop that does not go forward. */
const MAX_EMPTY_CALLS = 256;
/** Heap for a read in addition to its output: the decoder state, the
 *  local header and the skip buffer. */
const READ_SLACK_BYTES = 512 * 1024;
/** The heap that the read module makes free before `start`
 *  (`START_PROBE_BYTES` in crates/read/src/wasm.rs). */
const START_PROBE_BYTES = 768 * 1024;
/** The most heap that the pass leaves free for decoding: one read of
 *  16 MiB and one Zstandard window of 32 MiB, with room. */
const DECODE_KEEP_BYTES = 64 * 1024 * 1024;

let archive: ReadArchive | undefined;
let memory: ReadMemory | undefined;
let source: File | undefined;
/** The byte map, made one time. */
let layout: Promise<ArchiveLayout> | undefined;
let counted: Promise<ArchiveTotals> | undefined;
let pass: WayfinderScan | undefined;
/** The extractions. */
let extractor: Extractor | undefined;
const mirrors = new MirrorReader();
/** The check of the row that the stream decodes. */
let current: { row: number; check: EntryCheck } | undefined;
/** With `ignoreBOM`, so that the banner shows a U+FEFF at the start of a
 *  local name. If not, the local name looks the same as the true name. */
const names = new TextDecoder("utf-8", { ignoreBOM: true });

/** Waits for the next turn. A MessageChannel ping queues behind the
 *  messages that wait, so a request runs between two steps of the pass. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Throws when the row in the mirrors and the record that the read module
 *  found are not the same. The two passes read the same central directory
 *  in the same order, so this is a guard, not an expected case. */
function agree(row: number, start: EntryStart): void {
  const same =
    mirrors.value(row, "uncompressedSize") === start.uncompressedSize &&
    mirrors.value(row, "compressedSize") === start.compressedSize &&
    mirrors.value(row, "crc32") === start.crc32 &&
    mirrors.value(row, "method") === start.method &&
    mirrors.value(row, "flags") === start.flags;
  if (!same) {
    throw new Error(`The listing and the read module do not agree about row ${row}`);
  }
}

function start(target: ReadArchive, row: number, window: number): EntryCheck {
  const found = target.start(row, window);
  try {
    if (found.error === undefined) {
      agree(row, found);
    }
    const check: EntryCheck = {
      mismatches: found.mismatches,
      localName: names.decode(found.localName),
    };
    if (found.error !== undefined) check.error = found.error;
    return check;
  } finally {
    found.free();
  }
}

const STATES = ["reading", "verified", "failed"] as const;

/** The window of the reader of the byte map. The map reads one local
 *  header (30 bytes) for each row: a small window keeps the reads short
 *  when entries are large, and still holds many headers when they are
 *  small. */
const LAYOUT_WINDOW_BYTES = 8 * 1024;
/** Rows of the byte map between two yields. */
const LAYOUT_STEP = 4096;
/** The bytes of one row of the byte map in the read wasm. */
const LAYOUT_ROW_BYTES = 16;
/** Heap for the facts, the sniffer and the regions of the byte map. */
const LAYOUT_SLACK_BYTES = 256 * 1024;

/** True when `COMMITTED_ROWS` does not change any more. */
function ended(state: State): boolean {
  return state === State.COMPLETE || state === State.CANCELLED || state === State.FAILED;
}

/**
 * Counts the totals of the listed rows, with no byte map. It reads no bytes
 * of the file for its rows, so the panel has the method table long before the
 * map of a large archive.
 */
async function countTotals(
  target: ReadArchive,
  limits: ReadMemory,
  file: File,
): Promise<ArchiveTotals> {
  const rows = Math.min(mirrors.committedRows(), mirrors.pageRows());
  const locals = new WindowReaderAt(file, new FileReaderSync(), LAYOUT_WINDOW_BYTES);
  const records = new WindowReaderAt(file, new FileReaderSync(), LAYOUT_WINDOW_BYTES);
  try {
    limits.arm();
    target.layoutStart(locals, records, rows, false);
    limits.publish();
    for (let row = 0; row < rows; row++) {
      target.layoutAdd(
        mirrors.value(row, "localHeaderOffset"),
        mirrors.value(row, "compressedSize"),
        mirrors.value(row, "uncompressedSize"),
        mirrors.value(row, "crc32"),
        mirrors.value(row, "flags"),
        mirrors.value(row, "method"),
        mirrors.value(row, "encryption"),
        mirrors.value(row, "versionMadeBy"),
      );
      if ((row + 1) % LAYOUT_STEP === 0) {
        limits.publish();
        await nextTurn();
        limits.arm();
      }
    }
    limits.arm();
    target.layoutFinish();
    const totals = target.layoutTotals();
    limits.publish();
    if (totals === undefined) throw new Error("The read module gave no totals");
    return totalsOf(totals);
  } finally {
    target.layoutFinish();
    locals.close();
    records.close();
  }
}

/** Maps the bytes of the file and counts the totals of the listed rows,
 *  in steps of `LAYOUT_STEP` rows with a yield between them. */
async function mapBytes(
  target: ReadArchive,
  limits: ReadMemory,
  file: File,
): Promise<ArchiveLayout> {
  const state = mirrors.state();
  const rows = Math.min(mirrors.committedRows(), mirrors.pageRows());
  // Two readers: one for the local headers and one for the central
  // directory, so that each window stays in its part of the file.
  const locals = new WindowReaderAt(file, new FileReaderSync(), LAYOUT_WINDOW_BYTES);
  const records = new WindowReaderAt(file, new FileReaderSync(), LAYOUT_WINDOW_BYTES);
  const noRoom = "The memory limit leaves no room for the byte map";
  let error: string | undefined;
  try {
    limits.arm();
    if (!limits.fits(rows * LAYOUT_ROW_BYTES + LAYOUT_SLACK_BYTES)) {
      error = noRoom;
    }
    // The totals count also when the rows of the map do not fit.
    if (!target.layoutStart(locals, records, rows, error === undefined)) {
      error = noRoom;
    }
    limits.publish();
    for (let row = 0; row < rows; row++) {
      const mapped = target.layoutAdd(
        mirrors.value(row, "localHeaderOffset"),
        mirrors.value(row, "compressedSize"),
        mirrors.value(row, "uncompressedSize"),
        mirrors.value(row, "crc32"),
        mirrors.value(row, "flags"),
        mirrors.value(row, "method"),
        mirrors.value(row, "encryption"),
        mirrors.value(row, "versionMadeBy"),
      );
      if (!mapped) error ??= noRoom;
      if ((row + 1) % LAYOUT_STEP === 0) {
        limits.publish();
        await nextTurn();
        limits.arm();
      }
    }
    limits.arm();
    const vector = target.layoutFinish();
    const totals = target.layoutTotals();
    limits.publish();
    if (totals === undefined) throw new Error("The read module gave no totals");
    return {
      state,
      totals: totalsOf(totals),
      map:
        error === undefined && vector !== undefined
          ? byteMap(vector)
          : { ok: false, error: error ?? noRoom },
    };
  } finally {
    // A failed step leaves no rows in the read wasm.
    target.layoutFinish();
    locals.close();
    records.close();
  }
}

/**
 * Loads the wasm one time. `warm` and `open` can both wait for it. A
 * second `init` call before the first one completes would make a second
 * instance and replace the exports, while objects of the first instance
 * still exist. A failed load is tried again on the next call.
 */
let loading: ReturnType<typeof init> | undefined;
function load(): ReturnType<typeof init> {
  loading ??= init().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

const api: ReadWorkerApi = {
  async warm() {
    await load();
  },
  async open(file, header, pages, options) {
    if (archive !== undefined) {
      throw new Error("This worker already has an archive");
    }
    const wasm = await load();
    source = file;
    mirrors.attach(header);
    const hard = options?.budget?.hard ?? HARD_BUDGET_BYTES;
    // Reserve the memory that the worker has now, then let the allocator
    // of the read wasm reserve each growth before it.
    const limits = new ReadMemory(header, () => wasm.memory.buffer, hard);
    globalThis.__zipscopeReadMemory = limits.growth;
    memory = limits;
    const publish = () => limits.publish();
    pages.forEach((buffer, index) => {
      if (buffer !== undefined) mirrors.receive({ kind: "page", index, buffer });
    });
    // The reader stays open until the worker stops.
    const reader = new RowReaderAt(file, new FileReaderSync());
    limits.arm();
    const opened = ReadArchive.open(reader, reader.records, file.size);
    archive = opened;
    publish();
    const keep = Math.min(DECODE_KEEP_BYTES, readReserve(hard) / 2);
    // Each scan step sets the cap first.
    const scanTarget = {
      rows: () => opened.rows(),
      scanState: () => opened.scanState(),
      tableBytes: () => opened.tableBytes(),
      capacity: () => opened.capacity(),
      growth: (count: number) => opened.growth(count),
      scan: (count: number) => {
        limits.arm();
        return opened.scan(count);
      },
    };
    pass = new WayfinderScan(scanTarget, mirrors, (bytes) => limits.fits(bytes), keep, publish);
    void pass.resume(nextTurn);
    extractor = new Extractor({
      archive: opened,
      reader,
      limits,
      mirrors,
      nextTurn,
      agree,
      archiveName: file.name,
    });
  },

  async settled() {
    await pass?.settled();
  },

  async page(index, buffer) {
    mirrors.receive({ kind: "page", index, buffer });
    void pass?.resume(nextTurn);
  },

  async read(row, offset, bytes) {
    if (archive === undefined || memory === undefined || pass === undefined) {
      throw new Error("No archive is open");
    }
    if (!Number.isSafeInteger(row) || row < 0 || row >= mirrors.committedRows()) {
      throw new Error(`Row ${row} is not listed`);
    }
    // The parse decides the place of a row, and only here: a row with this
    // mark is not at the offset that the read module reads.
    if ((mirrors.value(row, "marks") & Marks.WRAPPED_OFFSET) !== 0) {
      const check: EntryCheck = { mismatches: 0, localName: "", error: WRAPPED_REASON };
      return {
        row,
        bytes: new Uint8Array(0),
        offset,
        state: "failed",
        error: WRAPPED_REASON,
        check,
      };
    }
    const target = archive;
    const limits = memory;
    void pass.resume(nextTurn);
    /** A failed chunk that keeps the stream, so a later read can go on. */
    const refused = (error: string): ReadChunk => {
      const check = current?.row === row ? current.check : { mismatches: 0, localName: "" };
      return { row, bytes: new Uint8Array(0), offset, state: "failed", error, check };
    };
    // A read asks for no more than the declared rest (the read module
    // does the same). The output can be copied one time when wasm-bindgen
    // gives it to JS, so count it two times.
    const rest = Math.max(0, mirrors.value(row, "uncompressedSize") - offset);
    const step = Math.min(Math.max(0, bytes), MAX_READ_BYTES);
    const needed = 2 * Math.min(step, rest) + READ_SLACK_BYTES;
    // The table grows to the row only while the room of this read stays
    // free above the wasm memory: the start of the stream, the read and
    // the slack of its window (see `window` below). The free heap below
    // the wasm memory can be in small parts, so it does not count.
    const keep = START_PROBE_BYTES + needed + READ_SLACK_BYTES;
    if (
      !pass.reach(row, (growth) => limits.fitsAbove(growth + keep)) &&
      pass.stopped !== undefined
    ) {
      return refused(pass.stopped);
    }
    if (!limits.fits(needed)) {
      return refused("The memory limit leaves no room to decode this entry");
    }
    // A Zstandard window takes the heap that the read leaves free. The
    // limit is read again for each step, because the store can grow, and
    // the decoder applies it to each frame that starts.
    const window = () => Math.max(0, limits.free() - needed - READ_SLACK_BYTES);
    const resumes =
      current?.row === row && target.streamRow() === row && target.produced() <= offset;
    if (!resumes || current === undefined) {
      current = undefined;
      limits.arm();
      current = { row, check: start(target, row, window()) };
      limits.publish();
    }
    const { check } = current;
    if (check.error !== undefined) {
      return { row, bytes: new Uint8Array(0), offset, state: "failed", error: check.error, check };
    }
    // Each wasm call allocates at most one table chunk or one new
    // Zstandard window (READ_CALL_GROWTH_BYTES). A call can end early at a
    // frame boundary, so loop over calls. Before each call, set the cap
    // again; after it, publish the memory, so that the parse worker sees
    // the growth of each call.
    const reading = () => target.streamState() === 0;
    let empty = 0;
    while (target.produced() < offset && reading() && empty < MAX_EMPTY_CALLS) {
      limits.arm();
      const skipped = target.skip(offset - target.produced(), window());
      limits.publish();
      empty = skipped === 0 ? empty + 1 : 0;
    }
    const reached = target.produced();
    const parts: Uint8Array[] = [];
    let length = 0;
    if (reached === offset) {
      empty = 0;
      while (length < step && reading() && empty < MAX_EMPTY_CALLS) {
        limits.arm();
        const part = target.read(step - length, window());
        limits.publish();
        empty = part.length === 0 ? empty + 1 : 0;
        parts.push(part);
        length += part.length;
      }
    }
    const data = parts.length === 1 ? parts[0]! : new Uint8Array(length);
    if (parts.length !== 1) {
      let at = 0;
      for (const part of parts) {
        data.set(part, at);
        at += part.length;
      }
    }
    const state = STATES[target.streamState()] ?? "failed";
    // A failed stream starts again on the next read: the memory limit can
    // leave more room later.
    if (state === "failed") current = undefined;
    limits.publish();
    const chunk: ReadChunk = { row, bytes: data, offset: reached, state, check };
    const error = target.streamError();
    if (state === "failed" && error !== undefined) chunk.error = error;
    return Comlink.transfer(chunk, [data.buffer]);
  },

  async facts() {
    if (archive === undefined || memory === undefined) {
      throw new Error("No archive is open");
    }
    memory.arm();
    try {
      const vector = archive.facts();
      return factsOf(vector, archive.comment());
    } finally {
      memory.publish();
    }
  },

  async layout() {
    if (archive === undefined || memory === undefined || source === undefined) {
      throw new Error("No archive is open");
    }
    if (!ended(mirrors.state())) {
      throw new Error("The listing has not ended");
    }
    const { target, limits, file } = { target: archive, limits: memory, file: source };
    // One pass at a time: the two passes use one builder in the read wasm.
    layout ??= (counted ?? Promise.resolve())
      .catch(() => {})
      .then(() => mapBytes(target, limits, file));
    return layout;
  },

  async totals() {
    if (archive === undefined || memory === undefined || source === undefined) {
      throw new Error("No archive is open");
    }
    if (!ended(mirrors.state())) {
      throw new Error("The listing has not ended");
    }
    // A panel that opens again while the map runs does not wait for the map.
    if (counted !== undefined) return counted;
    if (layout !== undefined) return (await layout).totals;
    counted = countTotals(archive, memory, source);
    return counted;
  },

  async names(index, buffer) {
    mirrors.receive({ kind: "nameChunk", index, buffer });
  },

  async plan(target) {
    if (extractor === undefined || pass === undefined) throw new Error("No archive is open");
    // The plan and the extraction locate rows: the table must reach them.
    const rows = mirrors.visibleRows();
    const last = target.kind === "entry" ? Math.min(target.row, rows - 1) : rows - 1;
    if (last >= 0) await reachAll(last);
    return extractor.plan(target);
  },

  async extract(plan, sink, progress) {
    if (extractor === undefined) throw new Error("No archive is open");
    return extractor.extract(plan, sink, progress);
  },

  async dropPlan(plan) {
    extractor?.drop(plan);
  },
};

/** Grows the wayfinder table to `row` in steps, with a yield between
 *  steps. */
async function reachAll(row: number): Promise<void> {
  const target = pass;
  const limits = memory;
  if (target === undefined || limits === undefined) return;
  void target.resume(nextTurn);
  await target.settled();
  const fits = (growth: number) => limits.fitsAbove(growth + START_PROBE_BYTES);
  if (!target.reach(row, fits) && target.stopped !== undefined) {
    throw new Error(target.stopped);
  }
}

Comlink.expose(api);
