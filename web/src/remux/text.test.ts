// The text of the zstd copy and its hint.
import { ExtractSkip, WRAPPED_REASON } from "../contracts";
import { expect, test } from "vitest";
import type { RemuxReport } from "../contracts";
import { formatSize } from "../format";
import {
  REMUX_NOTE,
  notSmaller,
  percent,
  remuxHintText,
  remuxProgressText,
  remuxSummary,
  remuxSummaryParts,
  remuxFacts,
  remuxItemText,
} from "./text";

const report = (values: Partial<RemuxReport>): RemuxReport => ({
  outcome: "complete",
  written: 3032,
  rows: 3032,
  zstd: 0,
  kept: 3032,
  folders: 0,
  bytes: 13_000_000,
  output: 4_001_216,
  items: [],
  more: 0,
  ...values,
});

test("a copy that is larger than the archive says so, and not Saved", () => {
  // A real case: project-src.zip, 3,952,706 bytes, no entry in zstd.
  const larger = report({});
  const text = remuxSummary("project-src-zstd.zip", larger, "file", 3_952_706);
  expect(text).toBe(
    "Wrote “project-src-zstd.zip”: 3,032 entries in 3.8\u00a0MiB. The copy is 47.4\u00a0KiB (1.2%) larger than the archive (3.8\u00a0MiB). No entry got smaller with zstd. Each entry verified.",
  );
  expect(text).not.toContain("Saved");
  expect(text).not.toContain("uncompressed");
  expect(notSmaller(larger, 3_952_706)).toBe(true);
});

test("a smaller copy gives its saving against the archive", () => {
  const smaller = report({ written: 879, zstd: 188, output: 6_000_000 });
  expect(remuxSummary("demo-zstd.zip", smaller, "stream", 9_166_900)).toBe(
    "Saved “demo-zstd.zip”: 879 entries in 5.7\u00a0MiB. The copy is 3.0\u00a0MiB (35%) smaller than the archive (8.7\u00a0MiB). 188 files use zstd. Each entry verified.",
  );
  expect(notSmaller(smaller, 9_166_900)).toBe(false);
  const same = report({ output: 1000, zstd: 1 });
  expect(remuxSummary("a.zip", same, "file", 1000)).toContain(
    "Wrote “a.zip”: 3,032 entries in 1000\u00a0B. The copy is the same size as the archive (1000\u00a0B). 1 file uses zstd.",
  );
  expect(notSmaller(same, 1000)).toBe(true);
  // A cancelled copy is not "not smaller": it has its own text.
  expect(notSmaller(report({ outcome: "cancelled" }), 1)).toBe(false);
});

test("a copy with rows left out gives the size of the archive and no saving", () => {
  const items = [{ row: 0, skip: ExtractSkip.ENCRYPTED, detail: "" }];
  const parts = remuxSummaryParts("a.zip", report({ items, output: 1000 }), "file", 5000);
  expect(parts.slice(1)).toEqual([
    "The archive is 4.9\u00a0KiB.",
    "No entry got smaller with zstd.",
    "1 entry left out.",
  ]);
  // The count of the rows that a report does not list is also a count of rows left out.
  expect(remuxSummaryParts("a.zip", report({ more: 2, output: 1000 }), "file", 5000)[1]).toBe(
    "The archive is 4.9\u00a0KiB.",
  );
  // A copy that is not smaller gives no saving, so its sentence stays.
  expect(remuxSummaryParts("a.zip", report({ items, output: 6000 }), "file", 5000)[1]).toBe(
    "The copy is 1000\u00a0B (20%) larger than the archive (4.9\u00a0KiB).",
  );
});

test("percent rounds by size", () => {
  expect(percent(0.3456)).toBe("35%");
  expect(percent(-0.0123)).toBe("1.2%");
  expect(percent(0.0003)).toBe("less than 0.1%");
});

test("the note says in plain words what does not get smaller", () => {
  expect(REMUX_NOTE).toContain(
    "Entries that zstd does not make smaller keep their current compression.",
  );
  expect(REMUX_NOTE).not.toContain("than the archive has it");
});

test("the progress gives no total of 0\u00a0B before the count ends", () => {
  const progress = { bytes: 2048, total: 0, rows: 3, totalRows: 1000, workers: 2 };
  expect(remuxProgressText(progress)).toBe("2.0\u00a0KiB · 3 of 1,000 entries · 2 workers");
  expect(remuxProgressText({ ...progress, total: 4096, workers: 1 })).toBe(
    "2.0\u00a0KiB of 4.0\u00a0KiB · 3 of 1,000 entries · 1 worker",
  );
});

const MIB = 2 ** 20;

test("much stored data: the hint gives its size and part, and is not low", () => {
  expect(remuxHintText({ loose: 41.2 * MIB, formats: 0 }, 60.6 * MIB, 0, 0)).toEqual({
    text: "41.2\u00a0MiB of this archive (68%) is stored or barely compressed.",
    low: false,
  });
  // Compressed formats do not count, and the text says so.
  expect(remuxHintText({ loose: 20 * MIB, formats: 5 * MIB }, 40 * MIB, 0, 0)).toEqual({
    // "Those entries" means the first group, so its sentence comes right after
    // the first sentence, before the formats sentence.
    text: "20.0\u00a0MiB of this archive (50%) is stored or barely compressed. This does not include 5.0\u00a0MiB of images, video and other compressed formats. They stay as they are.",
    low: false,
  });
});

test("no stored data: the copy is not likely to be much smaller", () => {
  expect(remuxHintText({ loose: 0, formats: 0 }, 3_952_706, 0, 0)).toEqual({
    text: "No entry of this archive is stored or barely compressed. The copy is not likely to be much smaller than the archive.",
    low: true,
  });
  // An empty archive file.
  expect(remuxHintText({ loose: 0, formats: 0 }, 0, 0, 0).low).toBe(true);
});

test("compressed formats only: they stay as they are, and the hint is low", () => {
  expect(remuxHintText({ loose: 0, formats: 30 * MIB }, 31 * MIB, 0, 0)).toEqual({
    text: "The stored or barely compressed entries of this archive (30.0\u00a0MiB) are images, video or other compressed formats. The copy keeps them as they are. The copy is not likely to be much smaller than the archive.",
    low: true,
  });
});

test("near zero: below 5% of the archive the hint is low", () => {
  expect(remuxHintText({ loose: 1.2 * MIB, formats: 0 }, 40 * MIB, 0, 0)).toEqual({
    text: "Only 1.2\u00a0MiB of this archive (3.0%) is stored or barely compressed. The copy is not likely to be much smaller than the archive.",
    low: true,
  });
  // The limit itself is not low.
  expect(remuxHintText({ loose: 5, formats: 0 }, 100, 0, 0).low).toBe(false);
  expect(remuxHintText({ loose: 4.99, formats: 0 }, 100, 0, 0).low).toBe(true);
  // A hostile archive can count more than the file: the part stops at
  // 100%.
  expect(remuxHintText({ loose: 300, formats: 0 }, 100, 0, 0).text).toContain("(100%)");
});

test("the shown sizes stop at the archive size (a hostile central directory)", () => {
  // Sizes that are not true can claim 5 GiB in a 1 MiB file.
  expect(remuxHintText({ loose: 5 * 1024 * MIB, formats: 3 * 1024 * MIB }, MIB, 0, 0)).toEqual({
    text: "1.0\u00a0MiB of this archive (100%) is stored or barely compressed. This does not include 1.0\u00a0MiB of images, video and other compressed formats. They stay as they are.",
    low: false,
  });
  expect(remuxHintText({ loose: 0, formats: 3 * 1024 * MIB }, MIB, 0, 0).text).toContain(
    "(1.0\u00a0MiB)",
  );
});

test("with rows left out, each hint excludes them and gives no sentence about the copy size", () => {
  const facts = (loose: number, formats: number, rows: number) =>
    remuxHintText({ loose, formats }, 40 * MIB, rows, 0).text;
  expect(facts(26, 0, 2)).toBe(
    "26\u00a0B of this archive (less than 0.1%) is stored or barely compressed, not counting the entries left out.",
  );
  expect(facts(0, 0, 1)).toBe(
    "No entry of this archive is stored or barely compressed, not counting the entries left out.",
  );
  expect(facts(0, 30 * MIB, 1)).toBe(
    "The stored or barely compressed entries of this archive (30.0\u00a0MiB) are images, video or other compressed formats, not counting the entries left out. The copy keeps them as they are.",
  );
  expect(facts(20 * MIB, 0, 1)).toBe(
    "20.0\u00a0MiB of this archive (50%) is stored or barely compressed, not counting the entries left out.",
  );
  // The share stays the measure of low, so Cancel gets the focus as before.
  expect(remuxHintText({ loose: 26, formats: 0 }, 40 * MIB, 2, 0).low).toBe(true);
});

test("bytes outside the entries get a fact in the hint from LOW_SHARE of the archive", () => {
  const facts = (outside: number | undefined, leftOut = 0, loose = 0) =>
    remuxHintText({ loose, formats: 0 }, 1000, leftOut, outside).text;
  const fact = (size: string) =>
    `${size} of this archive is outside the entries. The copy does not keep those bytes.`;
  const none = "No entry of this archive is stored or barely compressed.";
  expect(facts(50)).toBe(`${none} ${fact("50\u00a0B")}`);
  expect(facts(49)).toBe(`${none} The copy is not likely to be much smaller than the archive.`);
  expect(facts(0)).toBe(`${none} The copy is not likely to be much smaller than the archive.`);
  // A low part keeps its first sentence, and the fact replaces the estimate.
  expect(facts(900, 0, 10)).toBe(
    `Only 10\u00a0B of this archive (1.0%) is stored or barely compressed. ${fact("900\u00a0B")}`,
  );
  // A part from LOW_SHARE on has no "Only".
  expect(facts(100, 0, 500)).toBe(
    `500\u00a0B of this archive (50%) is stored or barely compressed. ${fact("100\u00a0B")}`,
  );
  expect(facts(900, 1)).toBe(
    `No entry of this archive is stored or barely compressed, not counting the entries left out. ${fact("900\u00a0B")}`,
  );
  // With no value, the hint says nothing of the bytes outside the entries or of the copy size.
  expect(facts(undefined)).toBe(none);
  expect(remuxHintText({ loose: 0, formats: 0 }, 1000, 0, undefined).low).toBe(true);
  expect(remuxHintText({ loose: 0, formats: 0 }, 1000, 0, 900).low).toBe(true);
});

test("a report gives the same fact beside the size of the copy", () => {
  const fact =
    "900\u00a0B of this archive is outside the entries. The copy does not keep those bytes.";
  const summary = (values: Partial<RemuxReport>, outside?: number) =>
    remuxSummaryParts("a.zip", report(values), "file", 1000, outside);
  expect(summary({ output: 100 }, 900).slice(1, 3)).toEqual([
    "The copy is 900\u00a0B (90%) smaller than the archive (1000\u00a0B).",
    fact,
  ]);
  // The sentences of the rows left out stay.
  const items = [{ row: 0, skip: ExtractSkip.ENCRYPTED, detail: "" }];
  expect(summary({ items, output: 100 }, 900).slice(1, 3)).toEqual([
    "The archive is 1000\u00a0B.",
    fact,
  ]);
  // A small part, and no value, give no fact.
  expect(summary({ output: 100 }, 49).join(" ")).not.toContain("outside the entries");
  expect(summary({ output: 100 }).join(" ")).not.toContain("outside the entries");
  expect(remuxSummary("a.zip", report({ output: 100 }), "file", 1000, 900)).toContain(fact);
});

test("a left-out row with an offset that wrapped has only its own reason", () => {
  expect(remuxItemText({ row: 0, skip: ExtractSkip.LOCAL_HEADER, detail: WRAPPED_REASON })).toBe(
    `Left out. ${WRAPPED_REASON}`,
  );
  expect(remuxFacts(3, 30, 0, 2)).toBe(
    `3 entries, ${formatSize(30)} uncompressed. 2 files cannot be read here. The copy leaves them out.`,
  );
  expect(remuxFacts(3, 30, 0, 1)).toBe(
    `3 entries, ${formatSize(30)} uncompressed. 1 file cannot be read here. The copy leaves it out.`,
  );
});
