/*
ASSUMED API
MirrorWriter.allocatedBytes(): number
new MirrorWriter(header, send, memory, hardBytes?: number)

Count current wasm memory and the header and all allocated mirrors.
Count full allocations, including unused page and chunk space and both
view sets. Count growable buffers by byteLength, not maxByteLength.
Use the current wasm buffer after growth. Do not count old buffers twice.
STORE_KIB gives ceil(allocatedBytes / 1024), before rows are committed.
The optional hard limit lets tests use small buffers. Check the total
before an allocation. A limit error must keep the committed prefix.
The name may change. Record a reason for a change to an expected result.
*/

import { afterEach, expect, test, vi } from "vitest";
import { COLUMN_LAYOUT, HEADER_BYTES, Header, columnView } from "../contracts";
import type { Mirror } from "../contracts";
import { FakeStore } from "./fake-store";
import { MirrorWriter } from "./publish";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const store = new FakeStore(12 * 2 ** 20);
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const slots = new Int32Array(header);
  const mirrors: Mirror[] = [];
  const writer = new MirrorWriter(
    header,
    (mirror) => mirrors.push(mirror),
    () => store.memory,
  );
  const allocated = () =>
    store.memory.byteLength +
    header.byteLength +
    [...new Set(mirrors.map((mirror) => mirror.buffer))].reduce(
      (sum, buffer) => sum + buffer.byteLength,
      0,
    );
  return { store, header, slots, mirrors, writer, allocated };
}

test("the hard limit checks the sum before it sends another mirror", () => {
  const store = new FakeStore(12 * 2 ** 20);
  store.push({ name: "one", comment: "comment" });
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const hardBytes = 20 * 2 ** 20;
  const mirrors: Mirror[] = [];
  const allocated = () =>
    store.memory.byteLength +
    header.byteLength +
    mirrors.reduce((sum, mirror) => sum + mirror.buffer.byteLength, 0);
  const writer = new MirrorWriter(
    header,
    (mirror) => {
      mirrors.push(mirror);
      expect(allocated()).toBeLessThanOrEqual(hardBytes);
    },
    () => store.memory,
    hardBytes,
  );
  expect(() => writer.publish(store)).toThrow(/memory|budget|limit/i);
  expect(Atomics.load(new Int32Array(header), Header.COMMITTED_ROWS)).toBe(0);
  expect(allocated()).toBeLessThanOrEqual(hardBytes);
  expect(writer.allocatedBytes()).toBeLessThanOrEqual(hardBytes);
});

test("a new comment chunk at the hard limit keeps the old committed row", () => {
  const store = new FakeStore(12 * 2 ** 20);
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const slots = new Int32Array(header);
  const mirrors: Mirror[] = [];
  const hardBytes = 24 * 2 ** 20;
  const writer = new MirrorWriter(
    header,
    (mirror) => mirrors.push(mirror),
    () => store.memory,
    hardBytes,
  );
  store.push({ name: "kept" });
  root(store, 1);
  writer.publish(store);
  writer.publish(store);
  expect(Atomics.load(slots, Header.COMMITTED_ROWS)).toBe(1);
  const page = mirrors.find((mirror) => mirror.kind === "page")!.buffer;
  const prefix = COLUMN_LAYOUT.map((column) => columnView(page, column)[0]);
  const generation = Atomics.load(slots, Header.VIEW_GENERATION);
  const active = Atomics.load(slots, Header.ACTIVE_SET);
  store.push({ name: "not committed", comment: "allocates a full chunk" });
  root(store, 2);
  expect(() => writer.publish(store)).toThrow(/memory|budget|limit/i);
  expect(Atomics.load(slots, Header.COMMITTED_ROWS)).toBe(1);
  expect(COLUMN_LAYOUT.map((column) => columnView(page, column)[0])).toEqual(prefix);
  expect(Atomics.load(slots, Header.VIEW_GENERATION)).toBe(generation);
  expect(Atomics.load(slots, Header.ACTIVE_SET)).toBe(active);
  expect(writer.allocatedBytes()).toBeLessThanOrEqual(hardBytes);
});

function root(store: FakeStore, rows: number) {
  store.setViews({
    folders: [0, 0, 0xffffffff, 0xffffffff],
    rollups: [0, 0, rows],
    permutation: Array.from({ length: rows }, (_, row) => row),
    permutationFolder: 0,
    tree: [],
  });
}

test("memory includes full name and comment chunks, pages, header and both view sets", () => {
  const h = setup();
  h.store.push({ name: "a", comment: "c" });
  root(h.store, 1);
  h.writer.publish(h.store);
  h.writer.publish(h.store);
  expect(h.mirrors.map((mirror) => mirror.kind)).toEqual(
    expect.arrayContaining([
      "page",
      "nameChunk",
      "commentChunk",
      "folders",
      "rollups",
      "permutation",
      "tree",
    ]),
  );
  expect(h.mirrors.filter((mirror) => mirror.kind === "rollups")).toHaveLength(2);
  expect(h.writer.allocatedBytes()).toBe(h.allocated());
  expect(Atomics.load(h.slots, Header.STORE_KIB)).toBe(Math.ceil(h.allocated() / 1024));
});

test("memory uses current wasm bytes and current growable lengths without double counting", () => {
  const h = setup();
  h.store.push({ name: "before" });
  root(h.store, 1);
  h.writer.publish(h.store);
  const before = h.writer.allocatedBytes();
  const oldMemory = h.store.memory;
  h.store.grow(oldMemory.byteLength + 65536);
  structuredClone(oldMemory, { transfer: [oldMemory] });
  expect(oldMemory.byteLength).toBe(0);
  root(h.store, 1);
  h.writer.publish(h.store);
  expect(h.writer.allocatedBytes()).toBe(h.allocated());
  expect(h.writer.allocatedBytes()).toBeGreaterThan(before);
  h.writer.publish(h.store);
  const stable = h.writer.allocatedBytes();
  h.writer.publish(h.store);
  expect(h.writer.allocatedBytes()).toBe(stable);
  const originalBuffers = h.mirrors.map((mirror) => mirror.buffer);
  h.store.setViews({
    folders: Array.from({ length: 5000 }, (_, id) => [
      0,
      0,
      id === 0 ? 0xffffffff : 0,
      0xffffffff,
    ]).flat(),
    rollups: Array.from({ length: 15_000 }, () => 0),
    permutation: [0],
    permutationFolder: 0,
    tree: Array.from({ length: 20_000 }, () => 0),
  });
  h.writer.publish(h.store);
  h.writer.publish(h.store);
  expect(h.mirrors.map((mirror) => mirror.buffer)).toEqual(originalBuffers);
  expect(h.writer.allocatedBytes()).toBeGreaterThan(stable);
  expect(h.writer.allocatedBytes()).toBe(h.allocated());
  expect(Atomics.load(h.slots, Header.STORE_KIB)).toBe(Math.ceil(h.allocated() / 1024));
  const reserved = h.mirrors.reduce((sum, mirror) => sum + mirror.buffer.maxByteLength, 0);
  expect(h.writer.allocatedBytes()).toBeLessThan(reserved);
});

test("the memory counter is current when the committed row count is stored", () => {
  const h = setup();
  h.store.push({ name: "visible", comment: "also allocated" });
  root(h.store, 1);
  const store = Atomics.store.bind(Atomics);
  let commits = 0;
  const observe = (slots: Int32Array, index: number, value: number) => {
    if (slots.buffer === h.header && index === Header.COMMITTED_ROWS) {
      expect(value).toBe(1);
      expect(h.writer.allocatedBytes()).toBe(h.allocated());
      expect(Atomics.load(slots, Header.STORE_KIB)).toBe(Math.ceil(h.allocated() / 1024));
      commits++;
    }
    return store(slots, index, value);
  };
  vi.spyOn(Atomics, "store").mockImplementation(observe as typeof Atomics.store);
  h.writer.publish(h.store);
  expect(commits).toBe(1);
});
