// View requests with the real wasm parser (`mise run build:wasm` makes it).
// A request that replaces a listing in progress must wait for the
// listing that it asked for.
import { expect, test, vi } from "vitest";
import { Header, SortColumn } from "../contracts";
import type { ParseWorkerApi } from "../contracts";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose }));
/** A file that the stub `FileReaderSync` reads at once. */
class BytesFile {
  constructor(readonly bytes: Uint8Array) {}
  get size(): number {
    return this.bytes.length;
  }
  slice(start?: number, end?: number): BytesFile {
    return new BytesFile(this.bytes.subarray(start, end));
  }
}

/** A stored zip with empty entries. */
function zip(names: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = names.map((name) => encoder.encode(name));
  const locals = encoded.reduce((sum, name) => sum + 30 + name.length, 0);
  const directory = encoded.reduce((sum, name) => sum + 46 + name.length, 0);
  const bytes = new Uint8Array(locals + directory + 22);
  const data = new DataView(bytes.buffer);
  let local = 0;
  let central = locals;
  for (const name of encoded) {
    data.setUint32(local, 0x04034b50, true);
    data.setUint16(local + 4, 20, true);
    data.setUint16(local + 26, name.length, true);
    bytes.set(name, local + 30);
    data.setUint32(central, 0x02014b50, true);
    data.setUint16(central + 4, 20, true);
    data.setUint16(central + 6, 20, true);
    data.setUint16(central + 28, name.length, true);
    data.setUint32(central + 42, local, true);
    bytes.set(name, central + 46);
    local += 30 + name.length;
    central += 46 + name.length;
  }
  const end = locals + directory;
  data.setUint32(end, 0x06054b50, true);
  data.setUint16(end + 8, Math.min(names.length, 0xffff), true);
  data.setUint16(end + 10, Math.min(names.length, 0xffff), true);
  data.setUint32(end + 12, directory, true);
  data.setUint32(end + 16, locals, true);
  return bytes;
}

test("a request that replaces a listing in steps waits for its own listing", async () => {
  vi.stubGlobal(
    "FileReaderSync",
    class {
      readAsArrayBuffer(file: BytesFile) {
        return file.bytes.slice().buffer;
      }
    },
  );
  // Folder 1 is `a`, folder 2 is `b`. Each has more entries than one step.
  const names: string[] = [];
  for (const folder of ["a", "b"]) {
    for (let index = 0; index < 60_000; index++) {
      names.push(`${folder}/f${String((index * 7919) % 60_000).padStart(5, "0")}`);
    }
  }
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  const { header } = await api.open(new BytesFile(zip(names)) as unknown as File, {
    mirror() {},
  });
  await expect(api.finished()).resolves.toMatchObject({ kind: "complete", rows: 120_000 });
  const view = new Int32Array(header);
  const shown = () =>
    Atomics.load(
      view,
      Atomics.load(view, Header.ACTIVE_SET) === 0
        ? Header.PERMUTATION_FOLDER_0
        : Header.PERMUTATION_FOLDER_1,
    ) >>> 0;
  const length = () =>
    Atomics.load(
      view,
      Atomics.load(view, Header.ACTIVE_SET) === 0
        ? Header.PERMUTATION_LENGTH_0
        : Header.PERMUTATION_LENGTH_1,
    );
  await api.sort(SortColumn.NAME, false);

  // `list(2)` replaces the listing of folder 1 while it is built.
  const first = api.list(1);
  await api.list(2);
  expect(shown()).toBe(2);
  expect(length()).toBe(60_000);
  await first;
  expect(shown()).toBe(2);

  // An expand that selects a folder replaces the listing too: collapse the
  // root row while folder 2 is listed, after a new listing of folder 1
  // started.
  const listing = api.list(1);
  await api.expand(0, false);
  expect(shown()).toBe(0);
  await listing;
  expect(shown()).toBe(0);
  await api.expand(0, true);

  // A sort that a search replaces resolves after the search results show.
  await api.list(1);
  const sorting = api.sort(SortColumn.NAME, true);
  const searching = api.search("F0");
  await sorting;
  expect(shown()).toBe(0xffffffff);
  await searching;
  expect(shown()).toBe(0xffffffff);
  expect(length()).toBe(names.filter((name) => name.includes("/f0")).length);
});
