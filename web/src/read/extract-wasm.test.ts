// Extraction in the read worker with the real read wasm: the
// plan, the zip of a folder in a Blob, and the memory limit of the zip.
// Its own file gives it a new wasm instance.
import { afterEach, expect, test, vi } from "vitest";
import {
  COLUMN_ID,
  COLUMN_LAYOUT,
  ExtractSkip,
  Marks,
  PROGRESS_BYTES,
  State,
  WRAPPED_REASON,
  columnView,
} from "../contracts";
import { MiB, encoder, giveNames, header, openWorker, total, zip } from "./wasm-harness";
import type { Entry } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The names and the stored data of a small zip. */
function entriesOf(zipBytes: Uint8Array): Map<string, string> {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let end = zipBytes.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const found = new Map<string, string>();
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip = view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(zipBytes.subarray(at + 46, at + 46 + nameLength));
    const local =
      offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    found.set(name, decoder.decode(zipBytes.subarray(local, local + size)));
    at += 46 + nameLength + skip;
  }
  return found;
}

const text = (value: string): Entry => ({ name: "", body: encoder.encode(value) });

test("a folder zip has only the verified entries of the folder, with safe names", async () => {
  const entries: Entry[] = [
    { ...text("alpha"), name: "f/a.txt" },
    { ...text("device"), name: "f/sub/CON" },
    { ...text("second"), name: "f/A.TXT" },
    { ...text("evil"), name: "f/../x.txt" },
    { ...text("outside"), name: "g/out.txt" },
    // The central directory declares 5 more bytes than the data has.
    { ...text("short"), name: "f/short.txt", size: 10 },
  ];
  const { bytes, pages } = zip(entries);
  const slots = header(State.COMPLETE, entries.length);
  const api = await openWorker(mocks.expose, bytes, slots, pages);
  await giveNames(
    api,
    pages,
    entries.map((entry) => entry.name),
  );
  const plan = await api.plan({ kind: "folder", path: "f/" });
  expect(plan).toMatchObject({ name: "f", files: 4, folders: 1, skipped: 1, renamed: 2 });
  expect(plan.zipError).toBeUndefined();
  const progress = new SharedArrayBuffer(PROGRESS_BYTES);
  const report = await api.extract(plan.id, { kind: "blob" }, progress);
  expect(report.outcome).toBe("complete");
  expect(report.written).toBe(3);
  expect(report.output).toBe("f.zip");
  const found = entriesOf(new Uint8Array(await report.blob!.arrayBuffer()));
  expect([...found]).toEqual([
    ["sub/", ""],
    ["a.txt", "alpha"],
    ["sub/CON_", "device"],
    ["A (2).TXT", "second"],
  ]);
  expect(report.items.map((item) => [item.name, item.skip, item.renamed])).toEqual([
    ["f/../x.txt", ExtractSkip.TRAVERSAL, undefined],
    ["f/sub/CON", undefined, 1],
    ["f/A.TXT", undefined, 16],
    ["f/short.txt", ExtractSkip.VERIFY, undefined],
  ]);
  expect(report.items[3]!.detail).toContain("ended after 5 bytes");
  // The plan is used: a second extract of it rejects.
  await expect(api.extract(plan.id, { kind: "blob" }, progress)).rejects.toThrow("No plan");
}, 60_000);

test("a job refuses a row with an offset that wrapped, in a folder zip and alone", async () => {
  const entries: Entry[] = [
    { ...text("kept"), name: "f/kept.txt" },
    { ...text("marked"), name: "f/marked.txt" },
  ];
  const { bytes, pages } = zip(entries);
  columnView(pages[0]!, COLUMN_LAYOUT[COLUMN_ID.marks]!)[1] = Marks.WRAPPED_OFFSET;
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 2), pages);
  await giveNames(
    api,
    pages,
    entries.map((entry) => entry.name),
  );
  const folder = await api.plan({ kind: "folder", path: "f/" });
  const report = await api.extract(
    folder.id,
    { kind: "blob" },
    new SharedArrayBuffer(PROGRESS_BYTES),
  );
  expect(report.written).toBe(1);
  expect(report.items.map((item) => [item.name, item.skip, item.detail])).toEqual([
    ["f/marked.txt", ExtractSkip.LOCAL_HEADER, WRAPPED_REASON],
  ]);
  const found = entriesOf(new Uint8Array(await report.blob!.arrayBuffer()));
  expect([...found]).toEqual([["kept.txt", "kept"]]);

  const entry = await api.plan({ kind: "entry", row: 1 });
  const alone = await api.extract(
    entry.id,
    { kind: "blob" },
    new SharedArrayBuffer(PROGRESS_BYTES),
  );
  expect(alone.written).toBe(0);
  expect(alone.items[0]?.detail).toBe(WRAPPED_REASON);
}, 60_000);

test("a folder plan waits for the end of the listing", async () => {
  const entries: Entry[] = [{ ...text("a"), name: "f/a" }];
  const { bytes, pages } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.PARSING, 1), pages);
  await giveNames(api, pages, ["f/a"]);
  await expect(api.plan({ kind: "folder", path: "f/" })).rejects.toThrow("listing has ended");
  const entry = await api.plan({ kind: "entry", row: 0 });
  expect(entry).toMatchObject({ name: "a", files: 1 });
}, 60_000);

test("a link entry is not extracted on its own", async () => {
  const entries: Entry[] = [{ ...text("/etc/passwd"), name: "link" }];
  const { bytes, pages } = zip(entries);
  columnView(pages[0]!, COLUMN_LAYOUT[COLUMN_ID.externalAttributes]!)[0] = (0o120777 << 16) >>> 0;
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 1), pages);
  await giveNames(api, pages, ["link"]);
  const plan = await api.plan({ kind: "entry", row: 0 });
  expect(plan).toMatchObject({ files: 0, skipped: 1 });
  const report = await api.extract(
    plan.id,
    { kind: "blob" },
    new SharedArrayBuffer(PROGRESS_BYTES),
  );
  expect(report.outcome).toBe("failed");
  expect(report.items).toEqual([{ row: 0, name: "link", skip: ExtractSkip.LINK }]);
  expect(report.blob).toBeUndefined();
}, 60_000);

test("the zip of a large folder stays below the hard stop", async () => {
  const hard = 96 * MiB;
  const entries: Entry[] = [{ ...text("one"), name: "x/0000000" }];
  // 60,000 records that all point to the first entry, in the folder x.
  const extra = 60_000;
  const { bytes, pages } = zip(entries, extra);
  const rows = entries.length + extra;
  const slots = header(State.COMPLETE, rows);
  const api = await openWorker(mocks.expose, bytes, slots, pages, hard);
  await giveNames(
    api,
    pages,
    Array.from({ length: rows }, () => "x/0000000"),
  );
  await api.settled();
  const plan = await api.plan({ kind: "folder", path: "x/" });
  expect(plan.files).toBe(rows);
  expect(plan.zipError).toBeUndefined();
  const report = await api.extract(
    plan.id,
    { kind: "blob" },
    new SharedArrayBuffer(PROGRESS_BYTES),
  );
  expect(report.outcome).toBe("complete");
  expect(report.written).toBe(rows);
  expect(total(slots)).toBeLessThanOrEqual(hard);
}, 120_000);

test("the plan counts the sizes and ratios that need confirmation", async () => {
  const sized = (name: string, size: number, data = 10): Entry => ({
    name,
    body: new Uint8Array(data),
    size,
  });
  const entries = [
    sized("a/exactly-1-gib", 2 ** 30, 2 ** 24),
    sized("a/over-1-gib", 2 ** 30 + 1, 2 ** 24),
    // The ratio rule needs at least 16 MiB: 25 MiB is 100 times 256 KiB.
    sized("a/ratio-100", 100 * 2 ** 18, 2 ** 18),
    sized("a/ratio-101", 101 * 2 ** 18, 2 ** 18),
    // A real case: a 5.9 KiB text file at 600 times.
    sized("a/small-text", 6042, 10),
    sized("a/no-data", 5, 0),
    sized("a/no-data-16-mib", 2 ** 24, 0),
  ];
  const { bytes, pages } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, entries.length), pages);
  await giveNames(
    api,
    pages,
    entries.map((entry) => entry.name),
  );
  const plan = await api.plan({ kind: "folder", path: "a/" });
  expect(plan).toMatchObject({ files: 7, large: 1, bombs: 2, largest: 2 ** 30 + 1 });
  const one = await api.plan({ kind: "entry", row: 0 });
  expect(one).toMatchObject({ large: 0, bombs: 0 });
}, 60_000);

test("a renamed entry on its own is in the report with both names", async () => {
  const entries: Entry[] = [{ ...text("device"), name: "dir/CON.txt" }];
  const { bytes, pages } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 1), pages);
  await giveNames(api, pages, ["dir/CON.txt"]);
  const plan = await api.plan({ kind: "entry", row: 0 });
  expect(plan).toMatchObject({ name: "CON_.txt", files: 1, renamed: 1 });
  const report = await api.extract(
    plan.id,
    { kind: "blob" },
    new SharedArrayBuffer(PROGRESS_BYTES),
  );
  expect(report.outcome).toBe("complete");
  expect(report.items).toEqual([{ row: 0, name: "dir/CON.txt", path: "CON_.txt", renamed: 1 }]);
  expect(await report.blob!.text()).toBe("device");
}, 60_000);
