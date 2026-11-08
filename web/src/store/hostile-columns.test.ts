/*
ASSUMED API
StoreSource.commentChunkCount(): number
StoreSource.commentChunkPtr(chunk: number): number
StoreSource.commentChunkLength(chunk: number): number

These methods match the name arena methods in StoreSource.

StoreSource also gives the folder table and the
views. This source has no folders and empty views (NO_VIEWS).
The other tests use the public API and contracts.ts.
*/

import { afterEach, expect, test, vi } from "vitest";
import {
  CHUNK_BYTES,
  COLUMN_ID,
  COLUMN_LAYOUT,
  HEADER_BYTES,
  Header,
  PAGE_BYTES,
  PAGE_ROWS,
} from "../contracts";
import type { ColumnLayout, Mirror } from "../contracts";
import { MirrorWriter } from "../parse/publish";
import { MirrorReader } from "./reader";

function view(buffer: ArrayBuffer | SharedArrayBuffer, column: ColumnLayout, address: number) {
  switch (column.type) {
    case "f64":
      return new Float64Array(buffer, address, 3);
    case "u32":
      return new Uint32Array(buffer, address, 3);
    case "u16":
      return new Uint16Array(buffer, address, 3);
    case "u8":
      return new Uint8Array(buffer, address, 3);
  }
}

function source() {
  const base = 8;
  const namesAt = base + PAGE_BYTES;
  const commentsAt = namesAt + 128;
  let memory = new ArrayBuffer(commentsAt + 128);
  let rows = 1;
  const values = COLUMN_LAYOUT.map((column) => {
    let cells: number[];
    switch (column.type) {
      case "f64":
        cells = [2 ** 32 + 11, 2 ** 40 + 7, 2 ** 53 - 1];
        break;
      case "u32":
        cells = [0xffffffff, 0x80000001, 0xf1234567];
        break;
      case "u16":
        cells = [0x8001, 99, 93];
        break;
      case "u8":
        cells = [0x84, 0, 4];
        break;
    }
    if (column.id === COLUMN_ID.modified) cells = [NaN, 0, 1_700_000_001_234];
    if (column.id === COLUMN_ID.nameOffset) cells = [0, 1, 2];
    if (column.id === COLUMN_ID.nameLength) cells = [1, 1, 1];
    if (column.id === COLUMN_ID.commentOffset) cells = [0, 1, 2];
    if (column.id === COLUMN_ID.commentLength) cells = [1, 1, 1];
    view(memory, column, base + column.byteOffset).set(cells);
    return cells;
  });
  new Uint8Array(memory, namesAt, 3).set([97, 98, 99]);
  new Uint8Array(memory, commentsAt, 3).set([120, 121, 122]);
  return {
    values,
    memory: () => memory,
    rows: (count: number) => {
      rows = count;
    },
    grow: () => {
      const next = new ArrayBuffer(memory.byteLength + 65_536);
      new Uint8Array(next).set(new Uint8Array(memory));
      structuredClone(memory, { transfer: [memory] });
      memory = next;
    },
    api: {
      rows: () => rows,
      progress: () => rows / 3,
      columnPtr: (_page: number, id: number) => base + COLUMN_LAYOUT[id].byteOffset,
      nameChunkCount: () => 1,
      nameChunkPtr: (_chunk: number) => namesAt,
      nameChunkLength: (_chunk: number) => rows,
      commentChunkCount: () => 1,
      commentChunkPtr: (_chunk: number) => commentsAt,
      commentChunkLength: (_chunk: number) => rows,
      ...NO_VIEWS,
    },
  };
}

/** The view part of StoreSource, with no folders and empty views. */
const NO_VIEWS = {
  folderCount: () => 0,
  folderPtr: () => 0,
  rollupPtr: () => 0,
  folderUpdateCount: () => 0,
  folderUpdatesPtr: () => 0,
  clearFolderUpdates: () => {},
  permutationFolder: () => 0,
  permutationPtr: () => 0,
  permutationInfoPtr: () => 0,
  permutationLength: () => 0,
  treePtr: () => 0,
  treeLength: () => 0,
  rollupVersion: () => 0,
  permutationVersion: () => 0,
  treeVersion: () => 0,
  permutationLargest: () => 0,
};

test("all column types keep exact values after growth and a second batch", () => {
  const store = source();
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const mirrors: Mirror[] = [];
  const writer = new MirrorWriter(header, (mirror) => mirrors.push(mirror), store.memory);
  writer.publish(store.api);
  const page = mirrors.find((mirror) => mirror.kind === "page");
  expect(page).toBeDefined();
  if (page === undefined) throw new Error("The page is missing");
  for (const column of COLUMN_LAYOUT) {
    expect(view(page.buffer, column, column.byteOffset)[0]).toBe(store.values[column.id][0]);
  }
  store.grow();
  store.rows(3);
  writer.publish(store.api);
  writer.publish(store.api);
  expect(Atomics.load(new Int32Array(header), Header.COMMITTED_ROWS)).toBe(3);
  expect(mirrors.filter((mirror) => mirror.kind === "page")).toHaveLength(1);
  for (const column of COLUMN_LAYOUT) {
    expect(Array.from(view(page.buffer, column, column.byteOffset))).toEqual(
      store.values[column.id],
    );
  }
});

test("comment bytes are mirrored once and grow independently from name bytes", () => {
  const store = source();
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const mirrors: Mirror[] = [];
  const writer = new MirrorWriter(header, (mirror) => mirrors.push(mirror), store.memory);
  writer.publish(store.api);
  const comments = mirrors.find((mirror) => mirror.kind === "commentChunk");
  const names = mirrors.find((mirror) => mirror.kind === "nameChunk");
  expect(comments).toBeDefined();
  expect(names).toBeDefined();
  if (comments === undefined || names === undefined) throw new Error("An arena is missing");
  expect(comments.buffer).not.toBe(names.buffer);
  expect(comments.buffer.byteLength).toBe(CHUNK_BYTES);
  expect(new Uint8Array(comments.buffer)[0]).toBe(120);
  store.grow();
  store.rows(3);
  writer.publish(store.api);
  writer.publish(store.api);
  expect(Array.from(new Uint8Array(comments.buffer, 0, 3))).toEqual([120, 121, 122]);
  expect(Array.from(new Uint8Array(names.buffer, 0, 3))).toEqual([97, 98, 99]);
  expect(mirrors.filter((mirror) => mirror.kind === "commentChunk")).toHaveLength(1);
  expect(Atomics.load(new Int32Array(header), Header.COMMENT_CHUNK_COUNT)).toBe(1);
});

afterEach(() => vi.unstubAllGlobals());

test("a hostile visible name is copied into an ordinary buffer before decode", () => {
  const NativeDecoder = TextDecoder;
  const inputs: Uint8Array[] = [];
  class SharedRejectingDecoder extends NativeDecoder {
    override decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string {
      if (ArrayBuffer.isView(input)) {
        expect(input.buffer).toBeInstanceOf(ArrayBuffer);
        inputs.push(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
      }
      return super.decode(input, options);
    }
  }
  vi.stubGlobal("TextDecoder", SharedRejectingDecoder);
  const reader = new MirrorReader();
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const page = new SharedArrayBuffer(PAGE_BYTES);
  const chunk = new SharedArrayBuffer(CHUNK_BYTES);
  const text = "<img src=x onerror=alert(1)>\0/עברית/\u202etxt.exe/猫";
  const bytes = new TextEncoder().encode(text);
  new Uint8Array(chunk).fill(0xff, 0, bytes.length + 4);
  new Uint8Array(chunk, 2, bytes.length).set(bytes);
  new Uint32Array(page, COLUMN_LAYOUT[COLUMN_ID.nameOffset].byteOffset, PAGE_ROWS)[0] = 2;
  new Uint32Array(page, COLUMN_LAYOUT[COLUMN_ID.nameLength].byteOffset, PAGE_ROWS)[0] =
    bytes.length;
  reader.attach(header);
  reader.receive({ kind: "page", index: 0, buffer: page });
  reader.receive({ kind: "nameChunk", index: 0, buffer: chunk });
  Atomics.store(new Int32Array(header), Header.COMMITTED_ROWS, 1);
  expect(inputs).toHaveLength(0);
  expect(reader.visibleRows()).toBe(1);
  expect(inputs).toHaveLength(0);
  expect(reader.name(0)).toBe(text);
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toEqual(bytes);
  new Uint8Array(chunk, 2, bytes.length).fill(0);
  expect(inputs[0]).toEqual(bytes);
});
