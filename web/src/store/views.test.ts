// The folder table and the double-buffered views, from the worker side to
// the UI side, in one thread.
import { describe, expect, test } from "vitest";
import { CHUNK_BYTES, FOLDER_TAG, HEADER_BYTES, Header, NONE, PAGE_ROWS } from "../contracts";
import type { Mirror } from "../contracts";
import { FakeStore } from "../parse/fake-store";
import type { FakeViews } from "../parse/fake-store";
import { MirrorWriter } from "../parse/publish";
import { MirrorReader } from "./reader";

function setup() {
  const store = new FakeStore(2 * CHUNK_BYTES + PAGE_ROWS * 8 + 65536);
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const reader = new MirrorReader();
  reader.attach(header);
  const sent: Mirror[] = [];
  const writer = new MirrorWriter(
    header,
    (mirror) => sent.push(mirror),
    () => store.memory,
  );
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
  return { store, header: new Int32Array(header), reader, writer, deliver };
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
});
