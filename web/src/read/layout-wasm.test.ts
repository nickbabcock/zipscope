// The byte map and the facts of the read worker with the real read wasm.
import { afterEach, expect, test, vi } from "vitest";
import { RegionKind, State, Zip64Use } from "../contracts";
import { encoder, header, openWorker, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

const entries = Array.from({ length: 5 }, (_, index) => ({
  name: `dir/${index}.txt`,
  body: encoder.encode(`body of entry ${index}`),
}));

test("maps each byte of the file and counts the totals", async () => {
  const { bytes, page } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 5), page);
  const facts = await api.facts();
  expect(facts.size).toBe(bytes.length);
  expect(facts.zip64).toBe(Zip64Use.NONE);
  expect(facts.declaredEntries).toBe(5);
  expect(facts.spansDisks).toBe(false);
  expect(facts.endRecordOffset).toBe(bytes.length - 22);
  expect(facts.comment.length).toBe(0);

  const layout = await api.layout();
  expect(layout.state).toBe(State.COMPLETE);
  if (!layout.map.ok) throw new Error(layout.map.error);
  expect(layout.map.regions.map((region) => region.kind)).toEqual([
    RegionKind.ENTRIES,
    RegionKind.DIRECTORY,
    RegionKind.END_RECORD,
  ]);
  expect(layout.map.regions.at(-1)!.end).toBe(bytes.length);
  expect(layout.map.counts.rows).toBe(5);
  expect(layout.map.counts.gaps).toBe(0);
  expect(layout.totals.entries).toBe(5);
  expect(layout.totals.uncompressed).toBe(entries.reduce((sum, e) => sum + e.body.length, 0));
  expect(layout.totals.methods).toEqual([
    {
      key: 0,
      entries: 5,
      uncompressed: layout.totals.uncompressed,
      compressed: layout.totals.compressed,
    },
  ]);
  // The worker keeps the map.
  expect(await api.layout()).toBe(layout);
});

test("the totals pass and then the map use one builder, and agree", async () => {
  const { bytes, page } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 5), page);
  // The panel sends the two requests at once, the totals first.
  const [totals, layout] = await Promise.all([api.totals(), api.layout()]);
  expect(totals.entries).toBe(5);
  expect(totals.uncompressed).toBe(entries.reduce((sum, e) => sum + e.body.length, 0));
  expect(totals.methods).toHaveLength(1);
  if (!layout.map.ok) throw new Error(layout.map.error);
  expect(layout.map.counts.rows).toBe(5);
  expect(layout.totals).toEqual(totals);
  // A later request does not count again and does not wait for the map.
  expect(await api.totals()).toBe(totals);
  expect(await api.layout()).toBe(layout);
});

test("the totals pass after the map gives the totals of the map", async () => {
  const { bytes, page } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 5), page);
  const layout = await api.layout();
  expect(await api.totals()).toBe(layout.totals);
});

test("maps only after the listing ended", async () => {
  const { bytes, page } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.PARSING, 3), page);
  await expect(api.layout()).rejects.toThrow("not ended");
  // The facts do not need the rows.
  expect((await api.facts()).declaredEntries).toBe(5);
});

test("maps only the committed rows of a stopped listing", async () => {
  const { bytes, page } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.CANCELLED, 2), page);
  const layout = await api.layout();
  expect(layout.state).toBe(State.CANCELLED);
  if (!layout.map.ok) throw new Error(layout.map.error);
  expect(layout.map.counts.rows).toBe(2);
  expect(layout.totals.entries).toBe(2);
  // The data of the rows that are not listed is a gap before the
  // central directory.
  const kinds = layout.map.regions.map((region) => region.kind);
  expect(kinds).toEqual([
    RegionKind.ENTRIES,
    RegionKind.GAP,
    RegionKind.DIRECTORY,
    RegionKind.END_RECORD,
  ]);
});
