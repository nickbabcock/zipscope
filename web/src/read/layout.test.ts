import { expect, test } from "vitest";
import { RegionKind, RegionLabel } from "../contracts";
import { byteMap, FACTS_FIELDS, factsOf, totalsOf } from "./layout";

test("the totals vector decodes, with the most entries first in each breakdown", () => {
  // All rows, then methods (2 groups), encryption (1) and systems (2).
  const totals = totalsOf([
    4, 147, 315, 2, 0, 1, 10, 10, 8, 3, 137, 305, 1, 0, 4, 147, 315, 2, 0, 2, 20, 20, 3, 2, 127,
    295,
  ]);
  expect(totals).toEqual({
    entries: 4,
    compressed: 147,
    uncompressed: 315,
    methods: [
      { key: 8, entries: 3, compressed: 137, uncompressed: 305 },
      { key: 0, entries: 1, compressed: 10, uncompressed: 10 },
    ],
    encryption: [{ key: 0, entries: 4, compressed: 147, uncompressed: 315 }],
    systems: [
      { key: 0, entries: 2, compressed: 20, uncompressed: 20 },
      { key: 3, entries: 2, compressed: 127, uncompressed: 295 },
    ],
  });
  expect(() => totalsOf([1, 2, 3, 5])).toThrow("ends at");
});

test("the vectors decode to facts and regions", () => {
  const vector: number[] = Array.from({ length: FACTS_FIELDS }, () => -1);
  vector.splice(0, 13, 1000, 978, 1000, 800, 3, 1, 0, 0, 3, 3, 178, 800, 0);
  vector[27] = 0;
  vector[28] = 178;
  vector[29] = 900;
  vector[13] = 958;
  vector.splice(17, 10, 900, 44, 45, 45, 0, 0, 3, 3, 178, 800);
  const facts = factsOf(vector, new Uint8Array());
  expect(facts.zip64).toBe(1);
  expect(facts.locator).toEqual({ offset: 958, disk: -1, recordOffset: -1, totalDisks: -1 });
  expect(facts.record?.totalEntries).toBe(3);
  expect(facts.directoryEnd).toBe(900);
  expect(() => factsOf([1, 2], new Uint8Array())).toThrow("facts vector");

  const map = byteMap(
    [2, 0, 0, 0, 0, 0, 1, 5, 0, 0].concat([0, 0, 10, 4, 0, 0], [1, 10, 20, 0, 1, 5]),
  );
  expect(map).toEqual({
    ok: true,
    counts: {
      rows: 2,
      badHeaders: 0,
      pastDirectory: 0,
      intoDirectory: 0,
      overlapping: 0,
      missingDescriptors: 0,
      gaps: 1,
      gapBytes: 5,
      otherDiskRows: 0,
      zip64Rows: 0,
    },
    regions: [
      {
        kind: RegionKind.PRELUDE,
        start: 0,
        end: 10,
        label: RegionLabel.SHELL_SCRIPT,
        foldedGaps: 0,
        foldedBytes: 0,
      },
      { kind: RegionKind.ENTRIES, start: 10, end: 20, label: 0, foldedGaps: 1, foldedBytes: 5 },
    ],
  });
  expect(byteMap([1, 2, 3]).ok).toBe(false);
});
