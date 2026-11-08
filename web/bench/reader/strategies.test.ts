import { expect, test } from "vitest";
import { CHUNK_BYTES, HEADER_BYTES, Header, PAGE_ROWS } from "../../src/contracts";
import { FakeStore } from "../../src/parse/fake-store";
import { parseInBatches } from "../../src/parse/loop";
import { PrefetchReaderAt } from "./strategies.ts";

function setup() {
  const pending: ReturnType<typeof Promise.withResolvers<ArrayBuffer>>[] = [];
  const reads: number[] = [];
  const bytes = (start: number, length: number) =>
    Uint8Array.from({ length }, (_, i) => start + i).buffer;
  const file = {
    size: 100,
    slice(start: number, end: number) {
      return {
        start,
        size: Math.min(end, 100) - start,
        arrayBuffer() {
          const deferred = Promise.withResolvers<ArrayBuffer>();
          pending.push(deferred);
          return deferred.promise;
        },
      } as unknown as Blob;
    },
  } as Blob;
  const sync = {
    readAsArrayBuffer(blob: Blob) {
      const start = (blob as unknown as { start: number }).start;
      reads.push(start);
      return bytes(start, blob.size);
    },
  };
  return { reader: new PrefetchReaderAt(file, sync, 16), pending, reads, bytes };
}

test("serves a ready prefetch without a synchronous read", async () => {
  const { reader, pending, reads, bytes } = setup();
  reader.readAt(0, new Uint8Array(4));
  reader.prefetch();
  reader.prefetch();
  expect(pending).toHaveLength(1);
  pending[0]!.resolve(bytes(16, 16));
  await Promise.resolve();
  const buffer = new Uint8Array(4);
  expect(reader.readAt(16, buffer)).toBe(4);
  expect([...buffer]).toEqual([16, 17, 18, 19]);
  expect(reads).toEqual([0]);
  expect(reader.hits).toBe(1);
  expect(reader.peakBytes).toBeLessThanOrEqual(32);
});

test("falls back at once and discards a late prefetch", async () => {
  const { reader, pending, reads, bytes } = setup();
  reader.readAt(0, new Uint8Array(4));
  reader.prefetch();
  reader.readAt(16, new Uint8Array(4));
  pending[0]!.resolve(bytes(16, 16));
  await Promise.resolve();
  reader.prefetch();
  expect(pending).toHaveLength(2);
  expect(reads).toEqual([0, 16]);
  expect(reader.hits).toBe(0);
  expect(reader.retainedBytes).toBe(32);
});

test("a rejected prefetch leaves the synchronous fallback available", async () => {
  const { reader, pending, reads } = setup();
  reader.readAt(0, new Uint8Array(4));
  reader.prefetch();
  pending[0]!.reject(new Error("Read failed"));
  await Promise.resolve();
  expect(reader.readAt(16, new Uint8Array(4))).toBe(4);
  expect(reads).toEqual([0, 16]);
});

test("stops without waiting for an outstanding read", async () => {
  const { reader, pending, bytes } = setup();
  reader.readAt(0, new Uint8Array(4));
  reader.prefetch();
  reader.stop();
  pending[0]!.resolve(bytes(16, 16));
  await Promise.resolve();
  reader.prefetch();
  expect(pending).toHaveLength(1);
  expect(reader.retainedBytes).toBe(0);
});

test("cancel stops before the next batch while a prefetch is pending", async () => {
  const { reader, pending } = setup();
  reader.readAt(0, new Uint8Array(4));
  const store = new FakeStore(CHUNK_BYTES + PAGE_ROWS * 8 + 64);
  store.queue(Array.from({ length: 10_000 }, (_, i) => `f${i}`));
  const header = new SharedArrayBuffer(HEADER_BYTES);
  let batches = 0;
  const outcome = await parseInBatches(
    store,
    {
      publish() {
        reader.prefetch();
        if (++batches === 2) Atomics.store(new Int32Array(header), Header.CANCEL, 1);
      },
    },
    header,
    () => 0,
  );
  expect(outcome.kind).toBe("cancelled");
  expect(batches).toBe(2);
  expect(pending).toHaveLength(1);
  reader.stop();
});
