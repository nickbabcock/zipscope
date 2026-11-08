/*
ASSUMED API
StoreSource.folderCount(): number
StoreSource.folderPtr(): number
StoreSource.rollupPtr(): number
StoreSource.permutationPtr(): number
StoreSource.permutationLength(): number
StoreSource.treePtr(): number
StoreSource.treeLength(): number

StoreSource also has
folderUpdateCount(), folderUpdatesPtr(), clearFolderUpdates() and
permutationFolder(). The fixture gives no updates and lists the root.
It also has rollupVersion(), permutationVersion(), treeVersion() and
permutationLargest(). The writer copies a view only when its version
changed, so each `set` call gives new versions.
treeLength() is in tree rows of TREE_RECORD_WORDS words. The fixture
values stay in the first words, so the checks do not change.

Pointers give the current wasm data. Records have the sizes and fields in
contracts.ts. MirrorWriter.publish copies one complete view to the
inactive set. It then stores ACTIVE_SET and adds 1 to VIEW_GENERATION.
The source needs only one set. The mirrors have two sets.

These tests supply mirror bytes. hostile_tree.rs tests the archive paths.
The names may change. Record a reason for a change to an expected result.
*/

import { afterEach, expect, test, vi } from "vitest";
import { HEADER_BYTES, Header, TreeOrder } from "../contracts";
import type { Mirror } from "../contracts";
import { MirrorWriter } from "./publish";

const NONE = 0xffffffff;
const TAG = 0x80000000;
const FOLDERS = 8;
const ROLLUPS = 8192;
const PERMUTATION = 16384;
const TREE = 20480;

function source() {
  let memory = new ArrayBuffer(32768);
  let count = 0;
  let items: number[] = [];
  let visible: number[] = [];
  let total = 0;
  let version = 0;

  const fixture = {
    memory: () => memory,
    set: (folders: number, size: number, permutation: number[], tree: number[]) => {
      count = folders;
      total = size;
      items = permutation.map((value) => value >>> 0);
      visible = tree.map((value) => value >>> 0);
      const records = new Uint32Array(memory, FOLDERS, count * 4);
      const rollups = new Float64Array(memory, ROLLUPS, count * 3);
      for (let id = 0; id < count; id++) {
        records.set([id * 7, id === 0 ? 0 : 3, id === 0 ? NONE : 0, NONE], id * 4);
        rollups.set([size + id, size / 2 + id, id + 1], id * 3);
      }
      new Uint32Array(memory, PERMUTATION, items.length).set(items);
      new Uint32Array(memory, TREE, visible.length).set(visible);
      version++;
    },
    grow: () => {
      const next = new ArrayBuffer(memory.byteLength + 65536);
      new Uint8Array(next).set(new Uint8Array(memory));
      structuredClone(memory, { transfer: [memory] });
      memory = next;
    },
    api: {
      rows: () => 0,
      progress: () => 0.5,
      columnPtr: (_page: number, _column: number) => 0,
      nameChunkCount: () => 0,
      nameChunkPtr: (_chunk: number) => 0,
      nameChunkLength: (_chunk: number) => 0,
      commentChunkCount: () => 0,
      commentChunkPtr: (_chunk: number) => 0,
      commentChunkLength: (_chunk: number) => 0,
      folderCount: () => count,
      folderPtr: () => FOLDERS,
      rollupPtr: () => ROLLUPS,
      permutationPtr: () => PERMUTATION,
      // The test does not read the information words.
      permutationInfoPtr: () => PERMUTATION,
      permutationLength: () => items.length,
      treePtr: () => TREE,
      treeLength: () => visible.length,
      folderUpdateCount: () => 0,
      folderUpdatesPtr: () => 0,
      clearFolderUpdates: () => {},
      permutationFolder: () => 0,
      rollupVersion: () => version,
      permutationVersion: () => version,
      treeVersion: () => version,
      permutationLargest: () => 0,
    },
    expected: () => ({ count, total, items, visible }),
  };
  return fixture;
}

function setup() {
  const fixture = source();
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const mirrors: Mirror[] = [];
  const writer = new MirrorWriter(header, (mirror) => mirrors.push(mirror), fixture.memory);
  return { fixture, header, slots: new Int32Array(header), mirrors, writer };
}

function buffer(mirrors: Mirror[], kind: Mirror["kind"], set?: number): SharedArrayBuffer {
  const found = mirrors.filter(
    (mirror) =>
      mirror.kind === kind && (set === undefined || ("set" in mirror && mirror.set === set)),
  );
  expect(found).toHaveLength(1);
  return found[0]!.buffer;
}

function active(slots: Int32Array): number {
  const set = Atomics.load(slots, Header.ACTIVE_SET);
  expect([0, 1]).toContain(set);
  return set;
}

function lengthSlot(kind: "permutation" | "tree", set: number): number {
  return kind === "permutation"
    ? set === 0
      ? Header.PERMUTATION_LENGTH_0
      : Header.PERMUTATION_LENGTH_1
    : set === 0
      ? Header.TREE_LENGTH_0
      : Header.TREE_LENGTH_1;
}

function assertView(
  mirrors: Mirror[],
  slots: Int32Array,
  set: number,
  expected: ReturnType<ReturnType<typeof source>["expected"]>,
) {
  const rollups = new Float64Array(buffer(mirrors, "rollups", set));
  for (let id = 0; id < expected.count; id++) {
    expect(Array.from(rollups.subarray(id * 3, id * 3 + 3))).toEqual([
      expected.total + id,
      expected.total / 2 + id,
      id + 1,
    ]);
  }
  for (const [kind, values] of [
    ["permutation", expected.items],
    ["tree", expected.visible],
  ] as const) {
    const length = Atomics.load(slots, lengthSlot(kind, set)) >>> 0;
    expect(length).toBe(values.length);
    expect(Array.from(new Uint32Array(buffer(mirrors, kind, set), 0, length))).toEqual(values);
  }
}

afterEach(() => vi.restoreAllMocks());

test("one generation publishes all view bytes and lengths in the inactive set", () => {
  const { fixture, slots, mirrors, writer } = setup();
  fixture.set(3, 2 ** 40 + 18, [TAG | 1, 0, TAG | 2], [TAG | 1, TAG | 2]);
  const initialSet = active(slots);
  const initialGeneration = Atomics.load(slots, Header.VIEW_GENERATION);
  const events: string[] = [];
  const store = Atomics.store.bind(Atomics);
  const add = Atomics.add.bind(Atomics);
  const onStore = (view: Int32Array, index: number, value: number) => {
    if (view.buffer === slots.buffer && index === Header.ACTIVE_SET) {
      expect(value).toBe(1 - initialSet);
      assertView(mirrors, slots, value, fixture.expected());
      events.push("active");
    }
    return store(view, index, value);
  };
  const onAdd = (view: Int32Array, index: number, value: number) => {
    if (view.buffer === slots.buffer && index === Header.VIEW_GENERATION) {
      expect(value).toBe(1);
      expect(active(slots)).toBe(1 - initialSet);
      assertView(mirrors, slots, active(slots), fixture.expected());
      events.push("generation");
    }
    return add(view, index, value);
  };
  vi.spyOn(Atomics, "store").mockImplementation(onStore as typeof Atomics.store);
  vi.spyOn(Atomics, "add").mockImplementation(onAdd as typeof Atomics.add);
  writer.publish(fixture.api);
  expect(events).toEqual(["active", "generation"]);
  expect(Atomics.load(slots, Header.VIEW_GENERATION)).toBe(initialGeneration + 1);
  expect(Atomics.load(slots, Header.FOLDER_COUNT)).toBe(3);
  const folders = new Uint32Array(buffer(mirrors, "folders"), 0, 12);
  expect(Array.from(folders)).toEqual([0, 0, NONE, NONE, 7, 3, 0, NONE, 14, 3, 0, NONE]);
});

test("the next publish keeps the old active set and replaces shorter lengths", () => {
  const { fixture, slots, mirrors, writer } = setup();
  fixture.set(3, 101, [0, TAG | 1, 1, TAG | 2, 2], [TAG | 1, TAG | 2]);
  writer.publish(fixture.api);
  const oldSet = active(slots);
  const generation = Atomics.load(slots, Header.VIEW_GENERATION);
  const oldBuffers = ["rollups", "permutation", "tree"].map((kind) => {
    const shared = buffer(mirrors, kind as Mirror["kind"], oldSet);
    return { shared, bytes: new Uint8Array(shared).slice() };
  });
  fixture.set(3, 203, [TAG | 2], []);
  writer.publish(fixture.api);
  expect(active(slots)).toBe(1 - oldSet);
  expect(Atomics.load(slots, Header.VIEW_GENERATION)).toBe(generation + 1);
  for (const old of oldBuffers) expect(new Uint8Array(old.shared)).toEqual(old.bytes);
  assertView(mirrors, slots, active(slots), fixture.expected());
  fixture.set(3, 307, [], []);
  writer.publish(fixture.api);
  expect(active(slots)).toBe(oldSet);
  expect(Atomics.load(slots, Header.VIEW_GENERATION)).toBe(generation + 2);
  assertView(mirrors, slots, active(slots), fixture.expected());
});

test("the tree order goes to the set with its tree, so the old set keeps the old order", () => {
  const { fixture, slots, mirrors, writer } = setup();
  let order: number = TreeOrder.ARCHIVE;
  const api = Object.assign(fixture.api, { treeOrder: () => order });
  const orderOf = (set: number) =>
    Atomics.load(slots, set === 0 ? Header.TREE_ORDER_0 : Header.TREE_ORDER_1);
  fixture.set(3, 1, [], [TAG | 2, TAG | 1]);
  writer.publish(api);
  const oldSet = active(slots);
  expect(orderOf(oldSet)).toBe(TreeOrder.ARCHIVE);
  const oldTree = new Uint8Array(buffer(mirrors, "tree", oldSet)).slice();
  order = TreeOrder.NAME;
  fixture.set(3, 1, [], [TAG | 1, TAG | 2]);
  writer.publish(api);
  expect(active(slots)).toBe(1 - oldSet);
  expect(orderOf(1 - oldSet)).toBe(TreeOrder.NAME);
  expect(orderOf(oldSet)).toBe(TreeOrder.ARCHIVE);
  expect(new Uint8Array(buffer(mirrors, "tree", oldSet))).toEqual(oldTree);
  assertView(mirrors, slots, active(slots), fixture.expected());
});

test("folder and view mirrors grow in place across detached wasm memory", () => {
  const { fixture, slots, mirrors, writer } = setup();
  fixture.set(2, 5, [TAG | 1], [TAG | 1]);
  writer.publish(fixture.api);
  fixture.set(2, 7, [TAG | 1], [TAG | 1]);
  writer.publish(fixture.api);
  const originals = mirrors.slice();
  const oldMemory = fixture.memory();
  fixture.grow();
  expect(oldMemory.byteLength).toBe(0);
  const items = Array.from({ length: 300 }, (_, id) => (TAG | (id % 96)) >>> 0);
  fixture.set(96, 2 ** 42 + 12, items, items.slice(0, 200));
  writer.publish(fixture.api);
  fixture.set(96, 2 ** 42 + 24, items.slice(0, 280), items.slice(0, 190));
  writer.publish(fixture.api);
  expect(mirrors).toEqual(originals);
  expect(Atomics.load(slots, Header.FOLDER_COUNT)).toBe(96);
  expect(buffer(mirrors, "folders").byteLength).toBeGreaterThanOrEqual(96 * 16);
  expect(Array.from(new Uint32Array(buffer(mirrors, "folders"), 95 * 16, 4))).toEqual([
    665,
    3,
    0,
    NONE,
  ]);
  for (const set of [0, 1]) {
    for (const kind of ["rollups", "permutation", "tree"] as const) {
      expect(buffer(mirrors, kind, set).growable).toBe(true);
    }
  }
  expect(buffer(mirrors, "folders").growable).toBe(true);
  assertView(mirrors, slots, active(slots), fixture.expected());
});

test("a view change without new entry rows still publishes rollups and indices", () => {
  const { fixture, slots, mirrors, writer } = setup();
  fixture.set(2, 13, [TAG | 1], [TAG | 1]);
  writer.publish(fixture.api);
  const generation = Atomics.load(slots, Header.VIEW_GENERATION);
  const rows = Atomics.load(slots, Header.COMMITTED_ROWS);
  fixture.set(2, 17, [0], []);
  writer.publish(fixture.api);
  expect(Atomics.load(slots, Header.COMMITTED_ROWS)).toBe(rows);
  expect(Atomics.load(slots, Header.VIEW_GENERATION)).toBe(generation + 1);
  assertView(mirrors, slots, active(slots), fixture.expected());
});

test("store memory includes all allocated folder and mutable view mirrors", () => {
  const { fixture, slots, mirrors, writer } = setup();
  fixture.set(96, 29, [TAG | 1], [TAG | 1]);
  writer.publish(fixture.api);
  fixture.set(96, 31, [TAG | 2], []);
  writer.publish(fixture.api);
  for (const set of [0, 1]) {
    buffer(mirrors, "rollups", set);
    buffer(mirrors, "permutation", set);
    buffer(mirrors, "tree", set);
  }
  // The store memory also counts the 256-byte header, as hostile-memory.test.ts
  // requires. This adds the header; it does not weaken the check.
  const allocated = mirrors.reduce(
    (sum, mirror) => sum + mirror.buffer.byteLength,
    fixture.memory().byteLength + slots.byteLength,
  );
  expect(Atomics.load(slots, Header.STORE_KIB)).toBe(Math.ceil(allocated / 1024));
});
