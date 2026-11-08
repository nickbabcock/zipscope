// These tests supply view bytes. hostile_sort_search.rs tests archive input.
import { expect, test } from "vitest";
import {
  BEST_MATCH_ORDER,
  CHUNK_BYTES,
  FOLDER_TAG,
  HEADER_BYTES,
  Header,
  NONE,
  State,
} from "../contracts";
import type { Mirror } from "../contracts";
import { drawFrame } from "../grid/frame";
import { FakeStore } from "../parse/fake-store";
import { MirrorWriter } from "../parse/publish";
import { MirrorReader } from "./reader";

function setup(count = 3) {
  const store = new FakeStore(4 * CHUNK_BYTES);
  store.queue(Array.from({ length: count }, (_, i) => `entry-${i}`));
  store.parse(count);
  const buffer = new SharedArrayBuffer(HEADER_BYTES);
  const header = new Int32Array(buffer);
  header[Header.STATE] = State.COMPLETE;
  const reader = new MirrorReader();
  reader.attach(buffer);
  const mirrors: Mirror[] = [];
  const writer = new MirrorWriter(
    buffer,
    (mirror) => {
      mirrors.push(mirror);
      reader.receive(mirror);
    },
    () => store.memory,
  );
  const publish = (permutation: number[], largest: number) => {
    store.setViews({
      folders: [0, 0, NONE, NONE],
      rollups: [largest, largest / 2, count],
      permutation,
      permutationFolder: 0,
      tree: [FOLDER_TAG, 0, 1, 1],
      largest,
    });
    writer.publish(store);
  };
  return { store, header, reader, mirrors, publish };
}

test("equal-length search and sort results replace both cached sets", () => {
  const { reader, publish, header } = setup();
  for (const [index, permutation] of [[0, 1], [1, 2], [2, 0], [0, 2], [], [1, 0]].entries()) {
    const before = reader.views();
    publish(permutation, index + 1);
    const after = reader.views()!;
    expect([...after.permutation]).toEqual(permutation);
    expect(after.largest).toBe(index + 1);
    expect(MirrorReader.rollup(after, 0)).toEqual([index + 1, (index + 1) / 2, 3]);
    expect(after.generation).toBe(index + 1);
    expect(after.set).toBe((index + 1) % 2);
    expect(Atomics.load(header, Header.COMMITTED_ROWS)).toBe(3);
    if (before !== undefined) expect(reader.stable(before)).toBe(false);
    expect(reader.stable(after)).toBe(true);
  }
});

test("a search publish during a frame commits one complete set", () => {
  const { reader, publish } = setup();
  publish([2, 1, 0], 10);
  const committed: { rows: number[]; largest: number; rollup: number[] | undefined }[] = [];
  let reads = 0;
  const again = drawFrame(
    reader,
    (frame) => {
      const views = frame.views!;
      const rows = [...views.permutation];
      if (++reads === 1) publish([1], 20);
      const value = { rows, largest: views.largest, rollup: MirrorReader.rollup(views, 0) };
      return { complete: true, commit: () => committed.push(value) };
    },
    () => {},
  );
  expect(reads).toBe(2);
  expect(committed).toEqual([{ rows: [1], largest: 20, rollup: [20, 10, 3] }]);
  expect(again).toBe(false);
});

test("permutations grow in place and a shorter result hides the old tail", () => {
  // 16,385 u32 values exceed the first 64 KiB allocation.
  const count = 16_385;
  const { store, reader, mirrors, publish } = setup(count);
  publish([0], 1);
  publish([1], 2);
  const buffers = mirrors.filter((mirror) => mirror.kind === "permutation");
  expect(buffers).toHaveLength(2);
  const first = reader.views()!;
  const ascending = Array.from({ length: count }, (_, i) => i);
  store.grow(store.memory.byteLength * 2);
  publish([...ascending].reverse(), count);
  expect([...reader.views()!.permutation]).toEqual([...ascending].reverse());
  publish(ascending, count);
  expect([...reader.views()!.permutation]).toEqual(ascending);
  for (const mirror of buffers) expect(mirror.buffer.byteLength).toBeGreaterThan(65_536);
  publish([2], 3);
  expect([...reader.views()!.permutation]).toEqual([2]);
  publish([], 0);
  expect(reader.views()!.permutation.length).toBe(0);
  expect(reader.stable(first)).toBe(false);
  expect(mirrors.filter((mirror) => mirror.kind === "permutation")).toEqual(buffers);
});

test("the best-match order goes to the set with its rows, and a frame cannot tear them", () => {
  const { store, reader, publish } = setup();
  const source = store as FakeStore & { listingBestMatch?: () => boolean };
  source.listingBestMatch = () => true;
  publish([2, 1, 0], 10);
  expect(reader.views()!.sort).toBe(BEST_MATCH_ORDER);
  const committed: { rows: number[]; sort: number }[] = [];
  let reads = 0;
  drawFrame(
    reader,
    (frame) => {
      const views = frame.views!;
      const value = { rows: [...views.permutation], sort: views.sort };
      // The next listing is published during the read of the first one.
      if (++reads === 1) {
        source.listingBestMatch = () => false;
        publish([0, 1, 2], 20);
      }
      return { complete: true, commit: () => committed.push(value) };
    },
    () => {},
  );
  expect(reads).toBe(2);
  // The frame keeps the rows and the order of one set.
  expect(committed).toEqual([{ rows: [0, 1, 2], sort: 0 }]);
});

test("the old order stays while a new listing builds", () => {
  const { store, reader, publish } = setup();
  const source = store as FakeStore & {
    listingBestMatch?: () => boolean;
    viewsBuilding(): boolean;
  };
  source.listingBestMatch = () => true;
  publish([2, 1, 0], 10);
  expect(reader.views()!.sort).toBe(BEST_MATCH_ORDER);
  // A clear of the search builds the folder in steps. The results stay, also
  // through a publish of other views, so their order stays too.
  source.viewsBuilding = () => true;
  publish([2, 1, 0], 11);
  expect(reader.views()!.sort).toBe(BEST_MATCH_ORDER);
  // The folder listing replaces them.
  source.viewsBuilding = () => false;
  source.listingBestMatch = () => false;
  publish([0, 1], 12);
  expect(reader.views()!.sort).toBe(0);
});
