// The facts, the comment and the byte map of the Archive panel, with the
// real workers and wasm.
import { expect } from "vitest";
import { panelZip } from "../e2e/archive-zip";
import type { PanelZip } from "../e2e/archive-zip";
import { panelZip as hostilePanelZip } from "../e2e/panel-zip";
import {
  decodeComment,
  formatFacts,
  layoutSummary,
  plainLayout,
  unusualLayout,
} from "../src/archive/strings";
import { RegionKind } from "../src/contracts";
import { formatRatio } from "../src/format";
import { findings } from "../src/health/findings";
import { test as base } from "./fixtures";

/** `panel` opens the bytes, checks that the archive lists, and gives the
 *  byte map and the facts of the Format section from the facts of the read
 *  worker. */
const test = base.extend("panel", async ({ open }) => async (bytes: Buffer) => {
  const archive = await open(bytes);
  expect(archive.outcome.kind).toBe("complete");
  const { map } = await archive.read!.layout();
  if (!map.ok) throw new Error(map.error);
  const list = formatFacts(await archive.read!.facts(), archive.rows, "complete");
  return { archive, map, fact: (id: string) => list.find((fact) => fact.id === id) };
});

const panelOf = (spec: PanelZip) => panelZip(spec).bytes;

test("the summary of a byte map with one gap has the verb of one gap", async ({ panel }) => {
  const { archive, map } = await panel(
    panelOf({
      entries: [
        { name: "a.bin", data: Buffer.alloc(64, 1), after: Buffer.alloc(40, 0x41) },
        { name: "b.bin", data: Buffer.alloc(32, 2) },
      ],
    }),
  );
  expect(unusualLayout(map.regions, map.counts)).toBe(true);
  expect(layoutSummary(archive.file.size, map.counts)).toContain("1 gap holds 40 B.");
});

test("zip64 end records are regions and a fact", async ({ panel }) => {
  const { archive, fact, map } = await panel(
    panelOf({
      entries: [{ name: "big.bin", data: Buffer.alloc(100, 9) }],
      zip64: true,
      epilogue: Buffer.from("END"),
    }),
  );
  expect(unusualLayout(map.regions, map.counts)).toBe(true);
  expect(map.regions.map((region) => region.kind)).toEqual([
    RegionKind.ENTRIES,
    RegionKind.DIRECTORY,
    RegionKind.ZIP64_RECORD,
    RegionKind.ZIP64_LOCATOR,
    RegionKind.END_RECORD,
    RegionKind.EPILOGUE,
  ]);
  const sizes = map.regions.map((region) => region.end - region.start);
  expect(sizes[2]).toBe(56);
  expect(sizes[3]).toBe(20);
  // Each region starts where the last one ended, and they end at the file size.
  let at = 0;
  for (const region of map.regions) {
    expect(region.start).toBe(at);
    at = region.end;
  }
  expect(at).toBe(archive.file.size);
  expect(fact("zip64")?.value).toContain("Yes. The zip64 end record at");
});

test("a comment that is not UTF-8 decodes as CP437", async ({ panel }) => {
  const { archive } = await panel(
    panelOf({
      entries: [{ name: "a.txt", data: Buffer.from("a") }],
      comment: Buffer.from([0x63, 0x61, 0x66, 0x82, 0x20, 0xc9, 0xcd, 0xbb]),
    }),
  );
  const facts = await archive.read!.facts();
  expect(decodeComment(facts.comment)).toEqual({ text: "café ╔═╗", encoding: "cp437" });
});

test("an archive from Python zipfile with force_zip64 has two rows with zip64 fields", async ({
  panel,
}) => {
  // The bytes that Python 3 `zipfile` writes for two entries ("abc" and an
  // empty one) with `force_zip64=True`: local size markers and local zip64
  // fields, a 32-bit central directory and no zip64 end record.
  const bytes = Buffer.from(
    "504b03042d000000000000002100c2412435ffffffffffffffff05001400612e7478740100100003000000000000000300000000000000616263504b03042d00000000000000210000000000ffffffffffffffff05001400652e7478740100100000000000000000000000000000000000504b01022d032d000000000000002100c24124350300000003000000050000000000000000000000800100000000612e747874504b01022d032d00000000000000210000000000000000000000000005000000000000000000000080013a000000652e747874504b0506000000000200020066000000710000000000",
    "hex",
  );
  // The byte map counts the rows; a page test checks the Zip64 fact.
  const { map } = await panel(bytes);
  expect(map.counts.zip64Rows).toBe(2);
  // A layout of entries, the central directory and the end record is one
  // sentence, with no bar and no region list.
  expect(unusualLayout(map.regions, map.counts)).toBe(false);
});

test("a normal layout is one sentence, with no bar and no region list", async ({ panel }) => {
  const { archive, map } = await panel(
    panelOf({
      entries: [
        { name: "a.txt", data: Buffer.from("a") },
        { name: "b.txt", data: Buffer.from("b") },
      ],
    }),
  );
  expect(unusualLayout(map.regions, map.counts)).toBe(false);
  expect(plainLayout(archive.file.size)).toMatch(
    /^Each byte of the [\d.]+\sB file is entry data, the central directory or an end record\. There is no prelude, gap or epilogue, and no entry overlaps another\.$/,
  );
});

test("an entry that overlaps another shows the bar and the region list", async ({ panel }) => {
  // Two central-directory records point to the same local header, so
  // there is no gap: only the overlap.
  const { bytes, directory, end } = panelZip({
    entries: [{ name: "a.txt", data: Buffer.from("aaaa") }],
  });
  const record = bytes.subarray(directory, end);
  const endRecord = Buffer.from(bytes.subarray(end));
  endRecord.writeUInt16LE(2, 8);
  endRecord.writeUInt16LE(2, 10);
  endRecord.writeUInt32LE(record.length * 2, 12);
  const { map } = await panel(Buffer.concat([bytes.subarray(0, end), record, endRecord]));
  expect(unusualLayout(map.regions, map.counts)).toBe(true);
  expect(map.regions.some((region) => region.kind === RegionKind.GAP)).toBe(false);
});

test("an archive with no findings has no Health section in the panel", async ({ panel }) => {
  const { archive } = await panel(
    panelOf({ entries: [{ name: "a.txt", data: Buffer.from("a") }] }),
  );
  expect(findings(await archive.parse.health(), archive.outcome)).toEqual([]);
});

test("totals use every directory row and a weighted ratio", async ({ open }) => {
  const ratio = async (bytes: Buffer) => {
    const totals = await (await open(bytes)).read!.totals();
    return formatRatio(totals.compressed, totals.uncompressed);
  };
  const archive = hostilePanelZip(
    [
      { name: "duplicate", body: Buffer.alloc(10), size: 100, method: 8 },
      { name: "duplicate", body: Buffer.alloc(1), size: 1 },
    ],
    { declared: 0 },
  );
  expect(await ratio(archive.bytes)).toBe("10.9%");
  expect(await ratio(hostilePanelZip([]).bytes)).toBe("—");
});
