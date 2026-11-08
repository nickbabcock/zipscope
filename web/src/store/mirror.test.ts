// The publish protocol from the worker side to the UI side, in one thread.
import { describe, expect, test } from "vitest";
import { CHUNK_BYTES, HEADER_BYTES, Header, PAGE_ROWS } from "../contracts";
import type { Mirror } from "../contracts";
import { FakeStore } from "../parse/fake-store";
import { MirrorWriter } from "../parse/publish";
import { MirrorReader } from "./reader";

function setup(memoryBytes: number) {
  const store = new FakeStore(memoryBytes);
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const reader = new MirrorReader();
  reader.attach(header);
  const sent: Mirror[] = [];
  const writer = new MirrorWriter(
    header,
    (mirror) => sent.push(mirror),
    () => store.memory,
  );
  const deliver = () => {
    for (const mirror of sent.splice(0)) {
      reader.receive(mirror);
    }
  };
  return { store, header: new Int32Array(header), reader, writer, sent, deliver };
}

const names = (count: number, prefix = "file") =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i}.txt`);

describe("mirror publish and read", () => {
  test("names round-trip across a page boundary", () => {
    const { store, reader, writer, deliver, header } = setup(4 * 1024 * 1024 + PAGE_ROWS * 16 + 64);
    const expected = names(PAGE_ROWS + 300);
    for (const batch of [expected.slice(0, 1000), expected.slice(1000)]) {
      store.queue(batch);
      store.parse(batch.length);
      writer.publish(store);
      deliver();
    }
    expect(Atomics.load(header, Header.PAGE_COUNT)).toBe(2);
    expect(reader.visibleRows()).toBe(expected.length);
    for (const row of [0, 999, 1000, PAGE_ROWS - 1, PAGE_ROWS, expected.length - 1]) {
      expect(reader.name(row)).toBe(expected[row]);
    }
  });

  test("names round-trip across a chunk boundary, with UTF-8", () => {
    const { store, reader, writer, deliver } = setup(2 * CHUNK_BYTES + 2 * PAGE_ROWS * 8 + 64);
    const long = "é".repeat(30_000);
    const expected = Array.from({ length: 80 }, (_, i) => `${i}/${long}`);
    store.queue(expected);
    store.parse(30);
    writer.publish(store);
    store.parse(50);
    writer.publish(store);
    deliver();
    expect(store.nameChunkCount()).toBe(2);
    expect(reader.visibleRows()).toBe(80);
    expect(Array.from({ length: 80 }, (_, row) => reader.name(row))).toEqual(expected);
  });

  test("clamps to rows on pages that have not arrived", () => {
    const { store, reader, writer, deliver, sent } = setup(CHUNK_BYTES + 2 * PAGE_ROWS * 8 + 64);
    store.queue(names(PAGE_ROWS + 20));
    store.parse(PAGE_ROWS - 5);
    writer.publish(store);
    deliver();
    store.parse(20);
    writer.publish(store);
    // The count moved into page 1, but its message is still in transit.
    expect(reader.committedRows()).toBe(PAGE_ROWS + 15);
    expect(reader.visibleRows()).toBe(PAGE_ROWS);
    expect(sent.map((mirror) => mirror.kind)).toEqual(["page"]);
    deliver();
    expect(reader.visibleRows()).toBe(PAGE_ROWS + 15);
  });

  test("clamps to rows whose name chunk has arrived", () => {
    const { store, reader, writer, deliver } = setup(2 * CHUNK_BYTES + PAGE_ROWS * 8 + 64);
    const long = "x".repeat(60_000);
    const perChunk = Math.floor(CHUNK_BYTES / long.length);
    store.queue(Array.from({ length: perChunk + 5 }, () => long));
    store.parse(perChunk - 1);
    writer.publish(store);
    deliver();
    store.parse(6);
    writer.publish(store);
    // Row `perChunk` is the first row in chunk 1, which is not delivered.
    expect(reader.committedRows()).toBe(perChunk + 5);
    expect(reader.visibleRows()).toBe(perChunk);
    deliver();
    expect(reader.visibleRows()).toBe(perChunk + 5);
  });

  test("shows nothing before the first page and chunk arrive", () => {
    const { store, reader, writer, deliver } = setup(CHUNK_BYTES + PAGE_ROWS * 8 + 64);
    store.queue(["a", "b"]);
    store.parse(2);
    writer.publish(store);
    expect(reader.committedRows()).toBe(2);
    expect(reader.visibleRows()).toBe(0);
    deliver();
    expect(reader.visibleRows()).toBe(2);
  });

  test("sends each buffer one time and copies only new bytes", () => {
    const { store, writer, sent, header } = setup(CHUNK_BYTES + PAGE_ROWS * 8 + 64);
    store.queue(names(100));
    for (let i = 0; i < 10; i++) {
      store.parse(10);
      writer.publish(store);
    }
    writer.publish(store);
    // The growable view mirrors go one time, when the writer is made.
    expect(sent.map((mirror) => mirror.kind).sort()).toEqual([
      "folders",
      "nameChunk",
      "page",
      "permutation",
      "permutation",
      "permutationInfo",
      "permutationInfo",
      "rollups",
      "rollups",
      "tree",
      "tree",
    ]);
    expect(Atomics.load(header, Header.COMMITTED_ROWS)).toBe(100);
    expect(Atomics.load(header, Header.NAME_CHUNK_COUNT)).toBe(1);
  });

  test("reads from new views after memory growth", () => {
    const { store, reader, writer, deliver } = setup(CHUNK_BYTES + PAGE_ROWS * 8 + 64);
    store.queue(names(20));
    store.parse(10);
    writer.publish(store);
    store.grow(store.memory.byteLength + 65536);
    store.parse(10);
    writer.publish(store);
    deliver();
    expect(reader.name(19)).toBe("file-19.txt");
  });

  test("columns and comments round-trip, and comments wait for their chunk", () => {
    const { store, reader, writer, sent } = setup(2 * CHUNK_BYTES + PAGE_ROWS * 40 + 256);
    store.queue([
      { name: "a", columns: { uncompressedSize: 2 ** 40 + 1, method: 99, encryption: 0x84 } },
      { name: "b", comment: "hello" },
      { name: "c", columns: { modified: Number.NaN } },
    ]);
    store.parse(3);
    writer.publish(store);
    const comment = sent.findIndex((mirror) => mirror.kind === "commentChunk");
    expect(comment).toBeGreaterThan(-1);
    for (const [index, mirror] of sent.entries()) {
      if (index !== comment) {
        reader.receive(mirror);
      }
    }
    expect(reader.visibleRows()).toBe(3);
    expect(reader.value(0, "uncompressedSize")).toBe(2 ** 40 + 1);
    expect(reader.value(0, "method")).toBe(99);
    expect(reader.value(0, "encryption")).toBe(0x84);
    expect(reader.value(2, "modified")).toBeNaN();
    expect(reader.comment(0)).toBe("");
    expect(reader.comment(1)).toBeUndefined();
    reader.receive(sent[comment]!);
    expect(reader.comment(1)).toBe("hello");
  });
});
