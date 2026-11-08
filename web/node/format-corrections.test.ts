// Two format rules with the real workers and wasm: an entry count that
// wrapped at 65,536 and a local header in the range of another entry. Rust
// tests have the boundaries of the rules. These tests check the findings and
// the facts that the health panel and the Archive panel show.
import { expect } from "vitest";
import { countZip, placedZip } from "../e2e/placed-zip";
import { storedZip } from "../e2e/stored-zip";
import { formatFacts, layoutNotes, unusualLayout } from "../src/archive/strings";
import { findings } from "../src/health/findings";
import type { Finding } from "../src/health/findings";
import { test as base } from "./fixtures";
import type { Archive } from "./fixtures";

/** `listed` opens the bytes, and checks that the archive lists. */
const test = base.extend("listed", async ({ open }) => async (bytes: Buffer) => {
  const archive = await open(bytes);
  expect(archive.outcome.kind).toBe("complete");
  return archive;
});

const health = async (archive: Archive) => findings(await archive.parse.health(), archive.outcome);

/** The Entries fact of the Format section of the Archive panel. */
const entriesFact = async (archive: Archive) =>
  formatFacts(await archive.read!.facts(), archive.rows, "complete").find(
    (fact) => fact.id === "entries",
  )!;

const ids = (found: Finding[]) => found.map((finding) => finding.id);
const text = (found: Finding[], id: string) => found.find((finding) => finding.id === id)?.text;

test("a count that wrapped at 65,536 is a quiet notice with true values", async ({ listed }) => {
  const archive = await listed(countZip(65_539, 3));
  const found = await health(archive);
  expect(found[0]?.severity).toBe("notice");
  expect(ids(found)).toEqual(["count-wrapped"]);
  expect(text(found, "count-wrapped")).toContain(
    "The end record declares 3 entries, and the central directory has 65,539 entries.",
  );
  expect(text(found, "count-wrapped")).toContain("the two values agree in 16 bits.");
  expect(found.map((finding) => finding.text).join(" ")).not.toContain("but its central directory");
  const entries = await entriesFact(archive);
  expect(entries.value).toContain("3 declared, 65,539 found.");
  expect(entries.value).toContain("the declared and found values agree in 16 bits");
  expect(entries.level).toBeUndefined();
});

test("a count that does not wrap to the rows stays a warning", async ({ listed }) => {
  const archive = await listed(countZip(65_540, 3));
  const found = await health(archive);
  expect(found[0]?.severity).toBe("warning");
  expect(ids(found)).toEqual(["count-mismatch"]);
  expect(text(found, "count-mismatch")).toContain(
    "The archive declares 3 entries, but its central directory has 65,540 entries.",
  );
  expect((await entriesFact(archive)).level).toBe("warning");
});

test("a Zip64 count does not get the rule of 65,536", async ({ listed }) => {
  const entries: [string, number][] = [];
  for (let index = 0; index < 65_539; index++) {
    entries.push([`e${index}`, 0]);
  }
  const archive = await listed(storedZip(entries, 3n));
  const found = await health(archive);
  expect(ids(found)).toEqual(["count-mismatch"]);
  expect(text(found, "count-mismatch")).toContain(
    "The archive declares 3 entries, but its central directory has 65,539 entries.",
  );
  expect((await entriesFact(archive)).level).toBe("warning");
});

test("an empty header in the data of a row is a warning", async ({ listed }) => {
  const archive = await listed(
    placedZip(
      [
        { name: "a.bin", at: 0, size: 40 },
        { name: "b.bin", at: 40 },
      ],
      200,
    ),
  );
  const found = await health(archive);
  expect(found[0]?.severity).toBe("warning");
  expect(ids(found)).toContain("overlap-no-data");
});

test("two rows that point past the end of the file give a finding, a note and a plain layout", async ({
  listed,
}) => {
  // Two empty rows point to the same place past the end of the file, so the map
  // counts no bytes for them.
  const file = placedZip([{ name: "real.txt", at: 0 }], 30);
  const records = file.subarray(30, file.length - 22);
  const alias = (name: string): Buffer => {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(1_000_000, 42);
    return Buffer.concat([record, Buffer.from(name)]);
  };
  const directory = Buffer.concat([records, alias("one"), alias("two")]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(3, 8);
  end.writeUInt16LE(3, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(30, 16);
  const archive = await listed(Buffer.concat([file.subarray(0, 30), directory, end]));
  const found = await health(archive);
  expect(ids(found)).toEqual(["overlap-no-data"]);
  const { map } = await archive.read!.layout();
  if (!map.ok) throw new Error(map.error);
  expect(layoutNotes(map.counts, false).join(" ")).toContain("entries point into or past");
  // The panel gives the plain sentence. A page test checks that it does not
  // deny the overlap of the health list.
  expect(unusualLayout(map.regions, map.counts)).toBe(false);
});

test("entries with no gap between their local headers have no finding", async ({ listed }) => {
  // Each row takes 30 bytes and no more, so each one only touches the next.
  const archive = await listed(
    placedZip(
      [
        { name: "a", at: 0, size: 10 },
        { name: "b", at: 40 },
        { name: "c", at: 70, size: 30 },
      ],
      130,
    ),
  );
  expect(await health(archive)).toEqual([]);
});

test("data that runs into the central directory is a warning", async ({ listed }) => {
  const archive = await listed(placedZip([{ name: "last.bin", at: 0, size: 71 }], 100));
  const found = await health(archive);
  expect(found[0]?.severity).toBe("warning");
  expect(ids(found)).toEqual(["into-directory"]);
  expect(text(found, "into-directory")).toContain(
    "1 entry has bytes that run into the central directory.",
  );
  // The health list names the example row after "For example:".
  expect(archive.reader.name(found[0]!.example)).toBe("last.bin");
});

test("a repaired prefix compares the central directory in the base of the rows", async ({
  listed,
}) => {
  // Data of 1,000 bytes comes first, so rawzip adds 1,000 to each row and to
  // the place of the directory. The row only touches the directory.
  const archive = await listed(
    placedZip([{ name: "last.bin", at: 0, size: 70 }], 100, Buffer.alloc(1000)),
  );
  expect(ids(await health(archive))).toEqual(["prelude"]);
});
