import { describe, expect, test } from "vitest";
import { RegionKind, RegionLabel, Zip64Use } from "../contracts";
import type { ArchiveFacts } from "../contracts";
import textRs from "../../../crates/core/src/text.rs?raw";
import {
  decodeComment,
  formatFacts,
  hexOffset,
  layoutNotes,
  layoutSummary,
  pageGroups,
  plainLayout,
  regionFileName,
  regionName,
  regionNote,
  systemName,
  unaccounted,
  unusualLayout,
} from "./strings";

function facts(patch: Partial<ArchiveFacts> = {}): ArchiveFacts {
  return {
    size: 1000,
    endRecordOffset: 978,
    endOffset: 1000,
    directoryOffset: 800,
    directoryEnd: 978,
    declaredEntries: 3,
    declaredDirectorySize: 178,
    zip64: Zip64Use.NONE,
    spansDisks: false,
    endRecord: {
      disk: 0,
      directoryDisk: 0,
      diskEntries: 3,
      totalEntries: 3,
      directorySize: 178,
      directoryOffset: 800,
      commentLength: 0,
    },
    comment: new Uint8Array(),
    ...patch,
  };
}

const counts = {
  rows: 3,
  badHeaders: 0,
  pastDirectory: 0,
  intoDirectory: 0,
  overlapping: 0,
  missingDescriptors: 0,
  gaps: 0,
  gapBytes: 0,
  otherDiskRows: 0,
  zip64Rows: 0,
};

describe("the comment", () => {
  test("keeps UTF-8 when the end of the file cut a character", () => {
    const whole = new TextEncoder().encode("Größe — 日本");
    const cut = whole.subarray(0, whole.length - 1);
    // A comment that is not cut and has these bytes is not valid UTF-8.
    expect(decodeComment(cut).encoding).toBe("cp437");
    expect(decodeComment(cut, true)).toEqual({ text: "Größe — 日", encoding: "utf-8" });
    expect(decodeComment(whole, true)).toEqual({ text: "Größe — 日本", encoding: "utf-8" });
    // Bytes that are false before the cut stay CP437.
    expect(decodeComment(Uint8Array.of(0x63, 0x82, 0x63), true).encoding).toBe("cp437");
  });

  test("decodes as UTF-8 when it is valid", () => {
    expect(decodeComment(new TextEncoder().encode("Größe — 日本"))).toEqual({
      text: "Größe — 日本",
      encoding: "utf-8",
    });
  });

  test("decodes as CP437 otherwise, with the table of the core", () => {
    // The table in crates/core/src/text.rs, from \u{xxxx} literals.
    const codes = [...textRs.matchAll(/'\\u\{([0-9A-Fa-f]{4})\}'/g)].map((m) =>
      Number.parseInt(m[1]!, 16),
    );
    expect(codes).toHaveLength(128);
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const decoded = decodeComment(bytes);
    expect(decoded.encoding).toBe("cp437");
    const chars = [...decoded.text];
    expect(chars).toHaveLength(256);
    expect(chars.slice(0, 128).join("")).toBe(String.fromCharCode(...bytes.subarray(0, 128)));
    expect(chars.slice(128).map((char) => char.codePointAt(0))).toEqual(codes);
  });
});

describe("the format facts", () => {
  test("say when the counts agree and the archive has one disk", () => {
    const list = formatFacts(facts(), 3, "complete");
    expect(list.map((fact) => [fact.id, fact.value, fact.level])).toEqual([
      ["zip64", "No.", undefined],
      ["disks", "One disk.", undefined],
      ["entries", "3 declared, 3 found.", undefined],
    ]);
  });

  test("flag counts and sizes that differ, and spanned archives", () => {
    const list = formatFacts(
      facts({
        declaredEntries: 9,
        declaredDirectorySize: 500,
        spansDisks: true,
        endRecord: { ...facts().endRecord, disk: 2, directoryDisk: 2, diskEntries: 4 },
      }),
      3,
      "complete",
    );
    const byId = Object.fromEntries(list.map((fact) => [fact.id, fact]));
    expect(byId.entries).toMatchObject({
      value: "9 declared, 3 found, 4 on this disk in the end record.",
      level: "warning",
    });
    expect(byId.disks!.level).toBe("error");
    expect(byId.disks!.value).toContain("end record on disk 2");
    expect(byId.directory).toMatchObject({
      level: "warning",
      value: "At 0x00000320, 178\u00a0B. The archive declares 500\u00a0B.",
    });
  });

  test("a count that wrapped at 65,536 has no warning, only with no Zip64", () => {
    const entry = (zip64: Zip64Use, declared: number, rows: number) =>
      formatFacts(facts({ zip64, declaredEntries: declared }), rows, "complete").find(
        (fact) => fact.id === "entries",
      );
    expect(entry(Zip64Use.NONE, 3, 65_539)).toMatchObject({
      value:
        "3 declared, 65,539 found. With no Zip64, the count has only 16 bits, and the declared and found values agree in 16 bits.",
    });
    expect(entry(Zip64Use.NONE, 3, 65_539)?.level).toBeUndefined();
    expect(entry(Zip64Use.NONE, 0, 65_536)?.level).toBeUndefined();
    // A real mismatch, and a count of Zip64, keep the warning and the plain text.
    for (const [zip64, declared, rows] of [
      [Zip64Use.NONE, 4, 65_539],
      [Zip64Use.NONE, 3, 10],
      [Zip64Use.USED, 3, 65_539],
      [Zip64Use.IGNORED, 3, 65_539],
    ] as const) {
      const fact = entry(zip64, declared, rows);
      expect(fact?.level).toBe("warning");
      expect(fact?.value).not.toContain("16 bits");
    }
    // Before the end of the listing, the rows are not the count of the directory.
    const parsing = formatFacts(
      facts({ zip64: Zip64Use.NONE, declaredEntries: 3 }),
      65_539,
      "parsing",
    ).find((fact) => fact.id === "entries");
    expect(parsing?.value).toBe("3 declared, 65,539 listed so far.");
  });

  test("a partial or running listing does not flag the count", () => {
    const entry = (listing: "parsing" | "partial") =>
      formatFacts(facts({ declaredEntries: 9 }), 3, listing).find((fact) => fact.id === "entries");
    expect(entry("partial")?.level).toBeUndefined();
    expect(entry("partial")?.value).toContain("did not read the whole central directory");
    expect(entry("parsing")).toMatchObject({ value: "9 declared, 3 listed so far." });
    expect(entry("parsing")?.level).toBeUndefined();
  });

  test("tell a used zip64 record from an ignored locator", () => {
    const record = {
      offset: 900,
      size: 44,
      versionMadeBy: 45,
      versionNeeded: 45,
      disk: 0,
      directoryDisk: 0,
      diskEntries: 3,
      totalEntries: 3,
      directorySize: 100,
      directoryOffset: 800,
    };
    const locator = { offset: 958, disk: 0, recordOffset: 900, totalDisks: 1 };
    const used = formatFacts(facts({ zip64: Zip64Use.USED, record, locator }), 3, "complete")[0]!;
    expect(used.value).toContain("Yes. The zip64 end record at 0x00000384");
    expect(used.value).toContain("although the end record holds no zip64 markers");
    const ignored = formatFacts(facts({ zip64: Zip64Use.IGNORED, locator }), 3, "complete")[0]!;
    expect(ignored.level).toBe("warning");
    expect(ignored.value).toContain("0x000003be");
  });
});

describe("regions", () => {
  const region = (kind: RegionKind, patch = {}) => ({
    kind,
    start: 0x1a2b,
    end: 0x2000,
    label: RegionLabel.NONE as RegionLabel,
    foldedGaps: 0,
    foldedBytes: 0,
    ...patch,
  });

  test("names, notes and file names", () => {
    expect(regionName(region(RegionKind.END_RECORD, { start: 0, end: 22 }))).toBe("End record");
    expect(regionName(region(RegionKind.END_RECORD, { start: 0, end: 30 }))).toBe(
      "End record and comment",
    );
    expect(regionNote(region(RegionKind.PRELUDE, { label: RegionLabel.SHELL_SCRIPT }))).toBe(
      "Shell script prefix",
    );
    expect(regionNote(region(RegionKind.ENTRIES, { foldedGaps: 3, foldedBytes: 12 }))).toBe(
      "Has 3 small gaps (12\u00a0B) that the list does not show one by one",
    );
    expect(regionFileName("app.apk", region(RegionKind.GAP))).toBe("app.gap-1a2b.bin");
    expect(regionFileName("setup.exe", region(RegionKind.PRELUDE))).toBe("setup.prelude.bin");
    expect(regionFileName(".zip", region(RegionKind.EPILOGUE))).toBe("archive.epilogue.bin");
    expect([0, 1, 2, 3, 4, 5, 6, 7].filter((kind) => unaccounted(kind as RegionKind))).toEqual([
      RegionKind.PRELUDE,
      RegionKind.GAP,
      RegionKind.EPILOGUE,
    ]);
  });

  test("offsets, systems and notes", () => {
    expect(hexOffset(0)).toBe("0x00000000");
    expect(hexOffset(5 * 2 ** 32)).toBe("0x500000000");
    expect(hexOffset(2 ** 60)).toBe("—");
    expect(systemName(3)).toBe("Unix");
    expect(systemName(77)).toBe("System 77");
    expect(layoutNotes(counts, false)).toEqual([]);
    expect(
      layoutNotes({ ...counts, badHeaders: 1, pastDirectory: 2, overlapping: 1 }, true),
    ).toHaveLength(4);
    expect(layoutSummary(2048, { ...counts, gaps: 2, gapBytes: 40 })).toBe(
      "Each byte of the 2.0\u00a0KiB file is in one region. 2 gaps hold 40\u00a0B.",
    );
    expect(layoutSummary(2048, { ...counts, gaps: 1, gapBytes: 40 })).toBe(
      "Each byte of the 2.0\u00a0KiB file is in one region. 1 gap holds 40\u00a0B.",
    );
  });
});

test("a breakdown page folds the other groups into one row with their totals", () => {
  const groups = Array.from({ length: 65_536 }, (_, key) => ({
    key,
    entries: 1,
    uncompressed: 10,
    compressed: 4,
  }));
  const first = pageGroups(groups, 10);
  expect(first.rows.map((group) => group.key)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(first.rest).toEqual({
    groups: 65_526,
    entries: 65_526,
    uncompressed: 655_260,
    compressed: 262_104,
  });
  expect(pageGroups(groups.slice(0, 3), 10)).toEqual({ rows: groups.slice(0, 3), rest: undefined });
  expect(pageGroups(groups, 65_536).rest).toBeUndefined();
});

describe("the byte map gate", () => {
  const region = (kind: RegionKind, start: number, end: number) => ({
    kind,
    start,
    end,
    label: RegionLabel.NONE,
    foldedGaps: 0,
    foldedBytes: 0,
  });
  const plain = [
    region(RegionKind.ENTRIES, 0, 100),
    region(RegionKind.DIRECTORY, 100, 150),
    region(RegionKind.END_RECORD, 150, 172),
  ];

  test("shows the bar and the list only for a prelude, a gap, an epilogue or an overlap", () => {
    expect(unusualLayout(plain, counts)).toBe(false);
    expect(unusualLayout([region(RegionKind.PRELUDE, 0, 10), ...plain], counts)).toBe(true);
    expect(unusualLayout([...plain, region(RegionKind.EPILOGUE, 172, 180)], counts)).toBe(true);
    expect(unusualLayout(plain, { ...counts, gaps: 1, gapBytes: 4 })).toBe(true);
    expect(unusualLayout(plain, { ...counts, overlapping: 1 })).toBe(true);
    // Zip64 records are part of a normal archive.
    expect(
      unusualLayout(
        [...plain.slice(0, 2), region(RegionKind.ZIP64_RECORD, 150, 206), plain[2]!],
        counts,
      ),
    ).toBe(false);
  });

  test("gives one sentence in place of them", () => {
    expect(plainLayout(2048, true)).toBe(
      "Each byte of the 2.0\u00a0KiB file is entry data, the central directory or an end record. There is no prelude, gap or epilogue.",
    );
    expect(plainLayout(2048)).toBe(
      "Each byte of the 2.0\u00a0KiB file is entry data, the central directory or an end record. There is no prelude, gap or epilogue, and no entry overlaps another.",
    );
  });
});
