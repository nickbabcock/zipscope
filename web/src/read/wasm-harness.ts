// Test helpers for the read worker with the real read wasm. Each test file
// mocks Comlink itself, because `vi.mock` must be in the test file. The
// wasm instance stays for all tests of one file, and its memory does not
// shrink, so put budget tests in their own files.
import { vi } from "vitest";
import {
  CHUNK_BYTES,
  COLUMN_ID,
  COLUMN_LAYOUT,
  HEADER_BYTES,
  Header,
  PAGE_BYTES,
  PAGE_ROWS,
  RESERVATION_UNIT_BYTES,
  columnView,
} from "../contracts";
import { units } from "../memory";
import type { ColumnName, ReadWorkerApi, State } from "../contracts";
import type { SyncBlobReader } from "../parse/reader";

/** A file that the stub `FileReaderSync` reads at once. */
export class BytesFile {
  constructor(readonly bytes: Uint8Array) {}
  get size(): number {
    return this.bytes.length;
  }
  slice(start?: number, end?: number): BytesFile {
    return new BytesFile(this.bytes.subarray(start, end));
  }
}

export function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

export interface Entry {
  name: string;
  /** The uncompressed data. */
  body: Uint8Array;
  /** The bytes after the local header. The default is `body`, stored. */
  data?: Uint8Array;
  method?: number;
  /** The uncompressed size in the central directory. */
  size?: number;
}

export const encoder = new TextEncoder();

/**
 * Returns an archive with the entries, then `extra` more records that all
 * point to the local header of the first entry. The mirror pages get the
 * values of each row. `page` is the first page.
 */
export function zip(
  entries: Entry[],
  extra = 0,
): { bytes: Uint8Array; page: SharedArrayBuffer; pages: SharedArrayBuffer[] } {
  const pages = Array.from(
    { length: Math.max(1, Math.ceil((entries.length + extra) / PAGE_ROWS)) },
    () => new SharedArrayBuffer(PAGE_BYTES),
  );
  const column = (name: ColumnName, row: number) =>
    columnView(pages[Math.floor(row / PAGE_ROWS)]!, COLUMN_LAYOUT[COLUMN_ID[name]]!);
  const records = entries.map((entry) => ({
    ...entry,
    name: encoder.encode(entry.name),
    data: entry.data ?? entry.body,
    method: entry.method ?? 0,
    size: entry.size ?? entry.body.length,
    crc: crc32(entry.body),
    offset: 0,
  }));
  const locals = records.reduce((sum, r) => sum + 30 + r.name.length + r.data.length, 0);
  const total = records.length + extra;
  const extraName = encoder.encode("x/0000000");
  const directory =
    records.reduce((sum, r) => sum + 46 + r.name.length, 0) + extra * (46 + extraName.length);
  const bytes = new Uint8Array(locals + directory + 22);
  const view = new DataView(bytes.buffer);
  let at = 0;
  for (const record of records) {
    record.offset = at;
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 8, record.method, true);
    view.setUint32(at + 14, record.crc, true);
    view.setUint32(at + 18, record.data.length, true);
    view.setUint32(at + 22, record.size, true);
    view.setUint16(at + 26, record.name.length, true);
    bytes.set(record.name, at + 30);
    bytes.set(record.data, at + 30 + record.name.length);
    at += 30 + record.name.length + record.data.length;
  }
  const central = (row: number, r: (typeof records)[number]) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 10, r.method, true);
    view.setUint32(at + 16, r.crc, true);
    view.setUint32(at + 20, r.data.length, true);
    view.setUint32(at + 24, r.size, true);
    view.setUint16(at + 28, r.name.length, true);
    view.setUint32(at + 42, r.offset, true);
    bytes.set(r.name, at + 46);
    at += 46 + r.name.length;
    const index = row % PAGE_ROWS;
    column("uncompressedSize", row)[index] = r.size;
    column("localHeaderOffset", row)[index] = r.offset;
    column("compressedSize", row)[index] = r.data.length;
    column("crc32", row)[index] = r.crc;
    column("method", row)[index] = r.method;
    column("flags", row)[index] = 0;
  };
  records.forEach((record, row) => central(row, record));
  for (let index = 0; index < extra; index++) {
    central(records.length + index, { ...records[0]!, name: extraName });
  }
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, Math.min(total, 0xffff), true);
  view.setUint16(at + 10, Math.min(total, 0xffff), true);
  view.setUint32(at + 12, directory, true);
  view.setUint32(at + 16, locals, true);
  return { bytes, page: pages[0]!, pages };
}

/** A header of a parse worker that ended at `state` with `committed`
 *  rows. */
export function header(state: State, committed: number): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(HEADER_BYTES);
  const slots = new Int32Array(buffer);
  slots[Header.STATE] = state;
  slots[Header.COMMITTED_ROWS] = committed;
  return buffer;
}

/** Loads the worker module again and opens an archive. `expose` is the
 *  mock of `Comlink.expose` in the test file. */
export async function openWorker(
  expose: ReturnType<typeof vi.fn>,
  bytes: Uint8Array,
  slots: SharedArrayBuffer,
  page: SharedArrayBuffer | readonly SharedArrayBuffer[],
  hard?: number,
) {
  vi.resetModules();
  expose.mockClear();
  vi.stubGlobal(
    "FileReaderSync",
    class {
      readAsArrayBuffer(file: BytesFile) {
        return file.bytes.slice().buffer;
      }
    },
  );
  const workerPath = "./worker";
  await import(workerPath);
  const api = expose.mock.calls.at(-1)![0] as ReadWorkerApi;
  const options = hard === undefined ? undefined : { budget: { soft: hard, hard } };
  const pages = Array.isArray(page) ? page : [page];
  await api.open(new BytesFile(bytes) as unknown as File, slots, pages, options);
  return api;
}

export const readBytes = (slots: SharedArrayBuffer) =>
  (Atomics.load(new Int32Array(slots), Header.READ_KIB) >>> 0) * 1024;

export const MiB = 2 ** 20;

/** Sets the store memory of the parse worker: `STORE_KIB`, and the parse
 *  half of `RESERVED`, as the parse worker reserves it. The read half
 *  stays. */
export function setStore(slots: SharedArrayBuffer, bytes: number): void {
  const view = new Int32Array(slots);
  Atomics.store(view, Header.STORE_KIB, Math.ceil(bytes / 1024));
  for (;;) {
    const raw = Atomics.load(view, Header.RESERVED);
    const next = (units(bytes) << 16) | ((raw >>> 0) & 0xffff);
    if (Atomics.compareExchange(view, Header.RESERVED, raw, next) === raw) return;
  }
}

/** The memory that the budget counts: `STORE_KIB` and `READ_KIB`. */
export const total = (slots: SharedArrayBuffer) =>
  (Atomics.load(new Int32Array(slots), Header.STORE_KIB) >>> 0) * 1024 + readBytes(slots);

/** The two reservations in `RESERVED`, in bytes: the parse worker and the
 *  read worker. */
export function reserved(slots: SharedArrayBuffer): { store: number; read: number } {
  const word = Atomics.load(new Int32Array(slots), Header.RESERVED) >>> 0;
  return {
    store: (word >>> 16) * RESERVATION_UNIT_BYTES,
    read: (word & 0xffff) * RESERVATION_UNIT_BYTES,
  };
}

/** A Zstandard frame of RLE blocks of `a`, with a window of `2^log`. */
export function rleFrame(log: number, blocks: number, block: number): Uint8Array {
  const frame = new Uint8Array(6 + blocks * 4);
  new DataView(frame.buffer).setUint32(0, 0xfd2fb528, true);
  frame[5] = (log - 10) << 3;
  for (let index = 0; index < blocks; index++) {
    const value = (index + 1 === blocks ? 1 : 0) | (1 << 1) | (block << 3);
    frame.set([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, 0x61], 6 + index * 4);
  }
  return frame;
}

/** Joins byte arrays. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Writes the names of the rows to a name chunk and the name columns. */
/** Writes the names of the rows to name chunks and the name columns. A
 *  name does not cross a chunk boundary, as in the store. */
export async function giveNames(api: ReadWorkerApi, pages: SharedArrayBuffer[], names: string[]) {
  const chunks: SharedArrayBuffer[] = [new SharedArrayBuffer(CHUNK_BYTES)];
  let at = 0;
  names.forEach((name, row) => {
    const encoded = encoder.encode(name);
    if ((at % CHUNK_BYTES) + encoded.length > CHUNK_BYTES) {
      at = chunks.length * CHUNK_BYTES;
      chunks.push(new SharedArrayBuffer(CHUNK_BYTES));
    }
    new Uint8Array(chunks.at(-1)!).set(encoded, at % CHUNK_BYTES);
    const page = pages[Math.floor(row / PAGE_ROWS)]!;
    columnView(page, COLUMN_LAYOUT[COLUMN_ID.nameOffset]!)[row % PAGE_ROWS] = at;
    columnView(page, COLUMN_LAYOUT[COLUMN_ID.nameLength]!)[row % PAGE_ROWS] = encoded.length;
    at += encoded.length;
  });
  for (const [index, chunk] of chunks.entries()) await api.names(index, chunk);
}

/**
 * Opens the real core wasm on `bytes`, as the parse worker does: it
 * reserves the store memory and the slack on the header of `slots`, and
 * sets the growth hook of the core allocator. Call `openWorker` first: it
 * stubs `FileReaderSync`. Each test file gets its own instance.
 */
export async function openCore(slots: SharedArrayBuffer, bytes: Uint8Array, hard: number) {
  const core = await import("../wasm/zipscope_core.js");
  const { StoreReservation } = await import("../parse/memory");
  const { WindowReaderAt } = await import("../parse/reader");
  const { STORE_GROWTH_SLACK_BYTES, readReserve } = await import("../contracts");
  const wasm = await core.default();
  const memory = () => wasm.memory.buffer;
  const reservation = new StoreReservation(slots, hard, readReserve(hard), memory, {
    bytes: STORE_GROWTH_SLACK_BYTES,
    left: core.memorySlack,
  });
  core.setMemorySlack(STORE_GROWTH_SLACK_BYTES);
  globalThis.__zipscopeStoreMemory = reservation.growth;
  // `openWorker` stubs `FileReaderSync`, which the DOM types do not have.
  const Sync = (globalThis as unknown as { FileReaderSync: new () => SyncBlobReader })
    .FileReaderSync;
  const reader = new WindowReaderAt(new BytesFile(bytes) as unknown as File, new Sync());
  const parser = core.Parser.open(reader, bytes.length, 1n);
  return { parser, reservation, memory, memoryFull: core.memoryFull };
}
