// The folder table and the double-buffered views, from the worker side to
// the UI side, in one thread.
import { describe, expect, test } from "vitest";
import {
  CHUNK_BYTES,
  FOLDER_CHUNK_RECORDS,
  FOLDER_TAG,
  HEADER_BYTES,
  Header,
  NONE,
  PAGE_ROWS,
} from "../contracts";
import type { Mirror } from "../contracts";
import { FakeStore } from "../parse/fake-store";
import type { FakeViews } from "../parse/fake-store";
import { MemoryLimitError } from "../parse/budget";
import { MirrorWriter, VIEW_START_MAX_BYTES } from "../parse/publish";
import { MirrorReader } from "./reader";

function setup(memoryBytes = 2 * CHUNK_BYTES + PAGE_ROWS * 8 + 65536) {
  const store = new FakeStore(memoryBytes);
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const reader = new MirrorReader();
  reader.attach(header);
  const sent: Mirror[] = [];
  const all: Mirror[] = [];
  const writer = new MirrorWriter(
    header,
    (mirror) => {
      sent.push(mirror);
      all.push(mirror);
    },
    () => store.memory,
  );
  /** The bytes of the wasm memory, the header and the mirror `buffers`. */
  const bytesOf = (buffers: Iterable<SharedArrayBuffer>) =>
    store.memory.byteLength +
    header.byteLength +
    [...new Set(buffers)].reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const deliver = (filter: (mirror: Mirror) => boolean = () => true) => {
    const rest: Mirror[] = [];
    for (const mirror of sent.splice(0)) {
      if (filter(mirror)) {
        reader.receive(mirror);
      } else {
        rest.push(mirror);
      }
    }
    sent.push(...rest);
  };
  return { store, header: new Int32Array(header), reader, writer, sent, all, bytesOf, deliver };
}

/** Views for rows "a/x" and "b": folders root and "a". */
function views(nameOffset: number, extra: Partial<FakeViews> = {}): FakeViews {
  return {
    folders: [0, 0, NONE, NONE, nameOffset, 1, 0, NONE],
    rollups: [30, 15, 2, 10, 5, 1],
    permutation: [(FOLDER_TAG | 1) >>> 0, 1],
    permutationFolder: 0,
    tree: [FOLDER_TAG, 0, 1, 1, (FOLDER_TAG | 1) >>> 0, 1, 1, 1],
    ...extra,
  };
}

describe("views", () => {
  test("round-trip folders, rollups, the permutation and the tree", () => {
    const { store, reader, writer, deliver } = setup();
    store.queue(["a/x", "b"]);
    store.parse(2);
    store.setViews(views(0));
    expect(reader.views()).toBeUndefined();
    writer.publish(store);
    deliver();
    const set = reader.views()!;
    expect(set.folder).toBe(0);
    expect(Array.from(set.permutation)).toEqual([(FOLDER_TAG | 1) >>> 0, 1]);
    expect(set.treeRows).toBe(2);
    expect(MirrorReader.rollup(set, 1)).toEqual([10, 5, 1]);
    expect(MirrorReader.rollup(set, 1 << 20)).toBeUndefined();
    expect(reader.visibleFolders()).toBe(2);
    expect(reader.folderName(1)).toBe("a");
    expect(reader.folderName(0)).toBe("");
    expect(reader.folderParent(1)).toBe(0);
    expect(reader.folderRow(1)).toBe(NONE);
    expect(reader.stable(set)).toBe(true);
  });

  test("alternates the sets and bumps the generation", () => {
    const { store, header, reader, writer, deliver } = setup();
    store.queue(["a/x", "b"]);
    store.parse(2);
    store.setViews(views(0));
    writer.publish(store);
    deliver();
    const first = reader.views()!;
    store.setViews(views(0, { permutation: [1], permutationFolder: 1 }));
    writer.publish(store);
    expect(reader.stable(first)).toBe(false);
    const second = reader.views()!;
    expect(second.set).toBe(1 - first.set);
    expect(second.folder).toBe(1);
    expect(Array.from(second.permutation)).toEqual([1]);
    expect(Atomics.load(header, Header.VIEW_GENERATION)).toBe(first.generation + 1);
  });

  test("has no views until the view buffers arrive", () => {
    const { store, reader, writer, deliver } = setup();
    store.queue(["a/x"]);
    store.parse(1);
    store.setViews(views(0));
    writer.publish(store);
    deliver((mirror) => mirror.kind !== "tree");
    expect(reader.views()).toBeUndefined();
    deliver();
    expect(reader.views()).toBeDefined();
  });

  test("clamps folders to those whose name chunk arrived", () => {
    const { store, reader, writer, deliver } = setup();
    const long = "x".repeat(60_000);
    const perChunk = Math.floor(CHUNK_BYTES / long.length);
    store.queue(Array.from({ length: perChunk + 1 }, () => long));
    store.parse(perChunk + 1);
    // Folder 2 is a slice of the first name in chunk 1.
    store.setViews(views(0, { folders: [...views(0).folders, 1 << 22, 3, 0, NONE] }));
    writer.publish(store);
    deliver((mirror) => !(mirror.kind === "nameChunk" && mirror.index === 1));
    expect(reader.visibleFolders()).toBe(2);
    deliver();
    expect(reader.visibleFolders()).toBe(3);
  });

  test("copies a record again when its explicit row changes", () => {
    const { store, reader, writer, deliver } = setup();
    store.queue(["a/x", "a/"]);
    store.parse(2);
    store.setViews(views(0));
    writer.publish(store);
    deliver();
    expect(reader.folderRow(1)).toBe(NONE);
    const later = views(0);
    later.folders[7] = 1;
    store.setViews({ ...later, updates: [1] });
    writer.publish(store);
    expect(reader.folderRow(1)).toBe(1);
    expect(store.folderUpdateCount()).toBe(0);
  });

  test("publishes the largest row size of the listing", () => {
    const { store, reader, writer, deliver } = setup();
    store.queue(["a/x", "b"]);
    store.parse(2);
    store.setViews(views(0, { largest: 2 ** 40 + 3 }));
    writer.publish(store);
    deliver();
    // A float32 keeps about seven digits, enough for a size bar.
    expect(reader.views()!.largest / (2 ** 40 + 3)).toBeCloseTo(1, 6);
  });

  test("copies a view to a set only when its version changed", () => {
    const { store, reader, writer, deliver } = setup();
    store.queue(["a/x", "b"]);
    store.parse(2);
    store.setViews(views(0));
    writer.publish(store);
    writer.publish(store);
    deliver();
    // Change the wasm bytes without a new version: the next write to the
    // same set does not copy them.
    new Uint32Array(store.memory, store.permutationPtr(), 2).set([7, 7]);
    writer.publish(store);
    expect(Array.from(reader.views()!.permutation)).toEqual([(FOLDER_TAG | 1) >>> 0, 1]);
    // A new version is copied.
    store.setViews(views(0, { permutation: [1, 0] }));
    writer.publish(store);
    expect(Array.from(reader.views()!.permutation)).toEqual([1, 0]);
  });

  test("a small archive reserves little address space", () => {
    // Safari reserves the address space of `maxByteLength` when it makes a
    // growable buffer. Nine buffers of the hard stop took all of it on iOS,
    // so that the demo could not open.
    const { store, writer, sent } = setup();
    const all: Mirror[] = [];
    store.queue(["a/x", "b"]);
    store.parse(2);
    store.setViews(views(0));
    writer.publish(store);
    writer.publish(store);
    all.push(...sent);
    const reserved = all.reduce(
      (sum, mirror) => sum + (mirror.buffer.growable ? mirror.buffer.maxByteLength : 0),
      0,
    );
    expect(all.filter((mirror) => mirror.buffer.growable)).toHaveLength(9);
    expect(reserved).toBeLessThanOrEqual(9 * VIEW_START_MAX_BYTES);
  });

  test("a view past its maxByteLength moves to a new buffer, and the UI waits for it", () => {
    const { store, reader, writer, sent, deliver } = setup(48 * 2 ** 20);
    store.queue(["a/x", "b"]);
    store.parse(2);
    store.setViews(views(0));
    writer.publish(store);
    deliver();
    const small = reader.views()!;
    expect(reader.viewsPending()).toBe(false);
    // More words than the first buffer can hold.
    const length = VIEW_START_MAX_BYTES / 4 + 1000;
    const permutation = Array.from({ length }, (_, i) => i);
    store.setViews(views(0, { permutation }));
    writer.publish(store);
    const moved = sent.filter((mirror) => mirror.kind === "permutation");
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ set: 1 - small.set });
    expect(moved[0]!.buffer.maxByteLength).toBeGreaterThanOrEqual(length * 4);
    expect(moved[0]!.buffer.maxByteLength).toBeLessThanOrEqual(8 * VIEW_START_MAX_BYTES);
    // The set is published, but its new buffers have not arrived.
    expect(reader.views()).toBeUndefined();
    expect(reader.viewsPending()).toBe(true);
    deliver();
    const large = reader.views()!;
    expect(large.set).toBe(1 - small.set);
    expect(large.permutation.length).toBe(length);
    expect(large.permutation[length - 1]).toBe(length - 1);
    expect(reader.viewsPending()).toBe(false);
    // The other set moves on its next write too, and gets every view.
    writer.publish(store);
    deliver();
    const other = reader.views()!;
    expect(other.set).toBe(small.set);
    expect(other.permutation.length).toBe(length);
    expect(other.permutation[1000]).toBe(1000);
    expect(MirrorReader.rollup(other, 1)).toEqual([10, 5, 1]);
    expect(other.treeRows).toBe(2);
  });

  test("a set waits for a moved buffer also after a shorter listing", () => {
    const { store, reader, writer, all, bytesOf, deliver } = setup(48 * 2 ** 20);
    store.queue(["a/x", "b"]);
    store.parse(2);
    store.setViews(views(0, { permutation: [11, 12] }));
    writer.publish(store);
    writer.publish(store);
    deliver();
    const first = reader.views()!.set;
    // The permutation of the other set moves to a new buffer, which does not
    // arrive during the next publishes.
    const length = VIEW_START_MAX_BYTES / 4 + 1000;
    store.setViews(views(0, { permutation: Array.from({ length }, (_, i) => i) }));
    writer.publish(store);
    expect(reader.views()).toBeUndefined();
    store.setViews(views(0, { permutation: [21, 22] }));
    writer.publish(store);
    expect(reader.views()!.set).toBe(first);
    expect(Array.from(reader.views()!.permutation)).toEqual([21, 22]);
    // A short listing in the moved set: the old buffer could hold it, but it
    // has the older listing [11, 12].
    store.setViews(views(0, { permutation: [31, 32] }));
    writer.publish(store);
    expect(reader.views()).toBeUndefined();
    expect(reader.viewsPending()).toBe(true);
    // The old buffer stays in the count while the UI can hold it: the
    // count is every buffer that was sent.
    const held = writer.allocatedBytes();
    expect(held).toBe(bytesOf(all.map((mirror) => mirror.buffer)));
    writer.publish(store);
    writer.publish(store);
    expect(writer.allocatedBytes()).toBe(held);
    deliver();
    expect(reader.views()!.set).toBe(1 - first);
    expect(Array.from(reader.views()!.permutation)).toEqual([31, 32]);
    // The UI has the new buffer: the count gives back the old one, with no
    // publish. It is now the buffers that the UI has.
    expect(writer.allocatedBytes()).toBeLessThan(held);
    const live = new Map<string, SharedArrayBuffer>();
    for (const mirror of all) {
      live.set(`${mirror.kind}:${"set" in mirror ? mirror.set : mirror.index}`, mirror.buffer);
    }
    expect(writer.allocatedBytes()).toBe(bytesOf(live.values()));
  });

  test("the folder table grows in chunks, and the rollups wait for their buffer", () => {
    const { store, reader, writer, sent, deliver } = setup(48 * 2 ** 20);
    store.queue(["a/x"]);
    store.parse(1);
    store.setViews(views(0));
    writer.publish(store);
    deliver();
    // Folders past the first chunk, and rollups past the first buffer.
    const count = FOLDER_CHUNK_RECORDS + 100;
    const folders = Array.from({ length: count }, (_, id) =>
      id === 0 ? [0, 0, NONE, NONE] : [0, 1, id - 1, NONE],
    ).flat();
    const rollups = Array.from({ length: count }, (_, id) => [id, 0, 1]).flat();
    store.setViews(views(0, { folders, rollups }));
    writer.publish(store);
    expect(sent.filter((mirror) => mirror.kind === "folders")).toHaveLength(1);
    // Without the rollups buffer, the set waits. Without the second folder
    // chunk, the folders clamp to the first chunk.
    deliver((mirror) => mirror.kind !== "rollups" && mirror.kind !== "folders");
    expect(reader.views()).toBeUndefined();
    expect(reader.visibleFolders()).toBe(FOLDER_CHUNK_RECORDS);
    // With the rollups but not the new folder chunk, the set still waits:
    // it can name a folder in that chunk.
    deliver((mirror) => mirror.kind === "rollups");
    expect(reader.views()).toBeUndefined();
    expect(reader.viewsPending()).toBe(true);
    deliver();
    const set = reader.views()!;
    expect(MirrorReader.rollup(set, count - 1)).toEqual([count - 1, 0, 1]);
    expect(reader.visibleFolders()).toBe(count);
    expect(reader.folderParent(count - 1)).toBe(count - 2);
    expect(reader.folderParent(FOLDER_CHUNK_RECORDS)).toBe(FOLDER_CHUNK_RECORDS - 1);
    // A record that changes later changes in the chunk that the UI has.
    const changed = FOLDER_CHUNK_RECORDS + 5;
    folders[changed * 4 + 3] = 0;
    store.setViews(views(0, { folders, rollups, updates: [changed] }));
    writer.publish(store);
    // No folder chunk goes again (the rollups of the other set move now).
    expect(sent.filter((mirror) => mirror.kind === "folders")).toHaveLength(0);
    expect(reader.folderRow(changed)).toBe(0);
  });

  test("a move fits near the hard stop where a growth in place fits", () => {
    const store = new FakeStore(16 * 2 ** 20);
    const header = new SharedArrayBuffer(HEADER_BYTES);
    const reader = new MirrorReader();
    reader.attach(header);
    const sent: Mirror[] = [];
    const setViews = (length: number) =>
      store.setViews(views(0, { permutation: Array.from({ length }, (_, i) => i) }));
    store.queue(["a/x", "b"]);
    store.parse(2);
    // The first buffers of both sets hold almost their maxByteLength.
    setViews(VIEW_START_MAX_BYTES / 4 - 1000);
    const probe = new MirrorWriter(
      header.slice(0),
      () => {},
      () => store.memory,
    );
    probe.publish(store);
    probe.publish(store);
    // Room for the growth of the two views of one set, not for a copy.
    const hardBytes = probe.stopBytes() + 8 * 65536;
    const writer = new MirrorWriter(
      header,
      (mirror) => sent.push(mirror),
      () => store.memory,
      hardBytes,
    );
    writer.publish(store);
    writer.publish(store);
    setViews(VIEW_START_MAX_BYTES / 4 + 1000);
    writer.publish(store);
    expect(sent.filter((mirror) => mirror.kind === "permutation").length).toBeGreaterThan(2);
    expect(writer.stopBytes()).toBeLessThanOrEqual(hardBytes);
    for (const mirror of sent) reader.receive(mirror);
    expect(reader.views()!.permutation.length).toBe(VIEW_START_MAX_BYTES / 4 + 1000);
  });

  test("the end of the parse gives back the old buffers", () => {
    const { store, writer } = setup(48 * 2 ** 20);
    store.queue(["a/x", "b"]);
    store.parse(2);
    store.setViews(views(0));
    writer.publish(store);
    writer.publish(store);
    const before = writer.allocatedBytes();
    const length = VIEW_START_MAX_BYTES / 4 + 1000;
    store.setViews(views(0, { permutation: Array.from({ length }, (_, i) => i) }));
    writer.publish(store);
    const moved = writer.allocatedBytes();
    writer.settle();
    // The old buffers of the moved views are not counted now.
    expect(writer.allocatedBytes()).toBeLessThan(moved);
    expect(writer.allocatedBytes()).toBeGreaterThan(before);
  });

  test("a move that the browser cannot reserve takes less, or stops at the limit", () => {
    const { store, reader, writer, deliver } = setup(48 * 2 ** 20);
    store.queue(["a/x", "b"]);
    store.parse(2);
    store.setViews(views(0));
    writer.publish(store);
    writer.publish(store);
    deliver();
    const Real = globalThis.SharedArrayBuffer;
    let cap = Infinity;
    // Safari throws a RangeError when it cannot reserve `maxByteLength`.
    class Refusing extends Real {
      constructor(length: number, options?: { maxByteLength?: number }) {
        if ((options?.maxByteLength ?? length) > cap) throw new RangeError("Out of memory");
        super(length, options);
      }
    }
    globalThis.SharedArrayBuffer = Refusing as SharedArrayBufferConstructor;
    try {
      const length = VIEW_START_MAX_BYTES / 4 + 1000;
      const bytes = Math.ceil((length * 4) / 65536) * 65536;
      // Room for the bytes that the view needs, not for the factor.
      cap = bytes;
      store.setViews(views(0, { permutation: Array.from({ length }, (_, i) => i) }));
      writer.publish(store);
      deliver();
      expect(reader.views()!.permutation.length).toBe(length);
      // No room at all: the memory limit, which keeps the listing.
      cap = 0;
      store.setViews(views(0, { permutation: Array.from({ length: 4 * length }, (_, i) => i) }));
      expect(() => writer.publish(store)).toThrow(MemoryLimitError);
      expect(reader.views()!.permutation.length).toBe(length);
    } finally {
      globalThis.SharedArrayBuffer = Real;
    }
  });
});
