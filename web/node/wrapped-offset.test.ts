// An archive over 4 GiB with no Zip64, with the real workers and wasm: the
// findings, the facts, the byte map and the extraction. The file is sparse,
// so it uses some kilobytes of disk. The zstd copy of such an archive is in
// `remux.test.ts`.
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { readDownload } from "../e2e/hostile-zip";
import { root } from "../e2e/test-data";
import {
  BESIDE,
  DIRECTORY,
  GIB,
  theShape,
  writeAttackZip,
  writeWrappedZip,
} from "../e2e/wrapped-zip";
import type { WrappedRow } from "../e2e/wrapped-zip";
import { formatFacts, wrappedFact } from "../src/archive/strings";
import { Marks, PROGRESS_BYTES, RegionKind, WRAPPED_REASON } from "../src/contracts";
import type { ExtractSink } from "../src/contracts";
import { itemLead, itemReason, itemStatus, reportTsv, summary } from "../src/extract/text";
import { WRAPPED_FINDING, findings } from "../src/health/findings";
import { outputFolder, test as base } from "./fixtures";
import type { Archive } from "./fixtures";

/** `sparse.zip` writes a sparse zip and opens it. `sparse.attack` writes
 *  the attack of `writeAttackZip` and opens it. The file goes in a folder of
 *  its own below `target`, as for the page tests, and the fixture removes it. */
const test = base.extend("sparse", async ({ open }, { onCleanup }) => {
  const folder = mkdtempSync(path.join(root, "target", "wrapped-offset-"));
  onCleanup(() => rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, "wrapped.zip");
  const listed = async () => {
    const archive = await open(file);
    expect(archive.outcome.kind).toBe("complete");
    return archive;
  };
  return {
    zip: async (rows: WrappedRow[], directory: number, declared?: number) => {
      writeWrappedZip(file, rows, directory, declared);
      return listed();
    },
    attack: async (padding: number) => {
      const { b } = writeAttackZip(file, padding);
      return { archive: await listed(), b };
    },
  };
});

const health = async (archive: Archive) => findings(await archive.parse.health(), archive.outcome);

/** The first bytes of an entry as text, as the preview shows them. */
async function previewText(archive: Archive, name: string): Promise<string> {
  const chunk = await archive.read!.read(archive.names.indexOf(name), 0, 1 << 20);
  expect(chunk.check.error).toBeUndefined();
  return new TextDecoder().decode(chunk.bytes);
}

/** The error that the preview of an entry shows. */
async function previewError(archive: Archive, name: string): Promise<string | undefined> {
  const chunk = await archive.read!.read(archive.names.indexOf(name), 0, 1 << 20);
  return chunk.check.error ?? chunk.error;
}

/** Extracts the folder `docs` to `sink`, as the dialog does after the user
 *  confirms. */
async function extractDocs(archive: Archive, sink: (name: string) => ExtractSink) {
  const plan = await archive.read!.plan({ kind: "folder", path: "docs/" });
  const progress = new SharedArrayBuffer(PROGRESS_BYTES);
  return { plan, report: await archive.read!.extract(plan.id, sink(plan.name), progress) };
}

/** Extracts the folder `docs` to a folder of the picker. */
async function extractDocsFolder(archive: Archive) {
  const out = outputFolder();
  const { plan, report } = await extractDocs(archive, out.directory);
  const written = out.files.filter((file) => file.closed && !file.aborted && !file.removed);
  return { plan, report, written };
}

/** Extracts the folder `docs` to one zip, and returns its files. */
async function extractDocsZip(archive: Archive) {
  const { plan, report } = await extractDocs(archive, () => ({ kind: "blob" }));
  const files = readDownload(Buffer.from(await report.blob!.arrayBuffer())).filter(
    (entry) => !entry.name.endsWith("/"),
  );
  return { plan, report, files };
}

test("the extraction report gives the reason of each row and writes the row that reads", async ({
  sparse,
}) => {
  const archive = await sparse.zip([...theShape("docs/"), BESIDE], DIRECTORY);
  const { plan, report, written } = await extractDocsFolder(archive);
  expect(summary(plan, report)).toContain("Extracted 1 of 3 files");
  expect(report.items).toHaveLength(2);
  expect(itemStatus(report.items[0]!)).toBe("skipped");
  expect(report.items.map((item) => item.detail)).toEqual([WRAPPED_REASON, WRAPPED_REASON]);
  expect(written.map((file) => file.path)).toEqual(["docs/c.txt"]);
  expect(new TextDecoder().decode(written[0]!.bytes)).toBe("The last row can be read.\n");
});

test("the report text of a row that cannot be read gives only the reason, also in its copy", async ({
  sparse,
}) => {
  const archive = await sparse.zip([...theShape("docs/"), BESIDE], DIRECTORY);
  const { plan, report } = await extractDocsFolder(archive);
  expect(summary(plan, report)).toContain("Extracted 1 of 3 files");
  // The text of the cell has the hidden words that a screen reader hears. No
  // code compared the local header of these rows, so the text does not name it.
  expect(report.items.map((item) => `${itemLead(item)}${itemReason(item)}`)).toEqual([
    `Not written: ${WRAPPED_REASON}`,
    `Not written: ${WRAPPED_REASON}`,
  ]);
  expect(reportTsv(report)).toBe(
    `docs/a.bin\tNot written: ${WRAPPED_REASON}\ndocs/b.bin\tNot written: ${WRAPPED_REASON}`,
  );
});

test("a folder that goes to one zip leaves out the rows that cannot be read", async ({
  sparse,
}) => {
  const archive = await sparse.zip([...theShape("docs/"), BESIDE], DIRECTORY);
  const { plan, report, files } = await extractDocsZip(archive);
  expect(summary(plan, report)).toContain("Extracted 1 of 3 files");
  expect(report.items.map((item) => item.detail)).toEqual([WRAPPED_REASON, WRAPPED_REASON]);
  expect(files.map((entry) => [entry.name, entry.body.toString()])).toEqual([
    ["c.txt", "The last row can be read.\n"],
  ]);
});

test("a true prefix of exactly 4 GiB stays a prelude, and each row reads", async ({ sparse }) => {
  const rows: WrappedRow[] = [
    { name: "one.txt", at: 4 * GIB, body: "first", field: 0 },
    { name: "two.txt", at: 4 * GIB + 100, body: "second", field: 100 },
  ];
  const archive = await sparse.zip(rows, 4 * GIB + 200, 200);
  expect((await health(archive)).map((finding) => finding.id)).toEqual(["prelude"]);
  expect(await previewText(archive, "one.txt")).toContain("first");
  expect(await previewText(archive, "two.txt")).toContain("second");
  const { map } = await archive.read!.layout();
  expect(map.ok && map.regions.some((region) => region.kind === RegionKind.PRELUDE)).toBe(true);
  const facts = formatFacts(await archive.read!.facts(), archive.rows, "complete");
  expect(facts.find((fact) => fact.id === "zip64")?.value).toBe("No.");
  // The Archive panel shows the fact of the offsets with the finding only.
  expect((await health(archive)).map((finding) => finding.id)).not.toContain(WRAPPED_FINDING);
});

test("a true overlap of rows at a low header stays an error", async ({ sparse }) => {
  const rows: WrappedRow[] = [
    { name: "kernel.bin", at: 100, size: 2 ** 24 },
    { name: "alias.bin", at: 100, size: 2 ** 24 },
    { name: "last.txt", at: 5 * GIB, body: "x" },
  ];
  const found = await health(await sparse.zip(rows, 5 * GIB + 100));
  expect(found[0]?.severity).toBe("error");
  expect(found.map((finding) => finding.id)).toEqual(["overlaps", "wrapped-offsets", "prelude"]);
});

test("after the limit of reads, a marked row is refused and the row that reads is listed", async ({
  sparse,
}) => {
  const { archive, b } = await sparse.attack(2_048);
  // The 2,048 empty rows at one low header overlap, with no data. `docs/a.txt`
  // and `docs/b.txt` are at their own places, so they are not in that count.
  const found = await health(archive);
  expect(found[0]?.severity).toBe("warning");
  expect(found.map((finding) => finding.id)).toEqual([
    "overlap-no-data",
    "wrapped-offsets",
    "prelude",
  ]);
  expect(found[0]!.text).toContain("2,048 entries are at places");
  expect(found[1]!.text).toContain("2,049 entries cannot be read here.");
  const marks = (name: string) => archive.reader.value(archive.names.indexOf(name), "marks");
  expect(marks("docs/a.txt") & Marks.WRAPPED_OFFSET).not.toBe(0);
  expect(marks("docs/b.txt")).toBe(0);
  expect(await previewError(archive, "docs/a.txt")).toBe(WRAPPED_REASON);
  expect(await previewText(archive, "docs/b.txt")).toContain("bbbb");

  // The folder job writes only the row that reads.
  const { plan, report, written } = await extractDocsFolder(archive);
  expect(summary(plan, report)).toContain("Extracted 1 of 2 files");
  expect(report.items.map((item) => item.detail)).toContain(WRAPPED_REASON);
  expect(written.map((file) => [file.path, file.bytes.length])).toEqual([["docs/b.txt", b.length]]);
});

test("after the limit of reads, the Offsets fact does not say that each place has a local header", async ({
  sparse,
}) => {
  // `docs/a.txt` lists at 100,000, which holds no local header. Its local
  // header is 4 GiB above that place, in a gap of the byte map.
  const { archive } = await sparse.attack(2_048);
  // The Archive panel shows the fact of the offsets with the finding.
  expect((await health(archive)).map((finding) => finding.id)).toContain(WRAPPED_FINDING);
  const offsets = wrappedFact(await archive.read!.facts()).value;
  expect(offsets).toContain(
    "The byte map finds each entry by its local header, up to a limit of reads. After that limit it uses the order of the rows, and an entry can show at a place with no local header.",
  );
  expect(offsets).not.toContain("at the place of its local header");
});

test("after the limit of reads, a job to one zip has only the row that reads", async ({
  sparse,
}) => {
  const { archive, b } = await sparse.attack(2_048);
  const { plan, report, files } = await extractDocsZip(archive);
  expect(summary(plan, report)).toContain("Extracted 1 of 2 files");
  expect(report.items.map((item) => item.detail)).toContain(WRAPPED_REASON);
  expect(files.map((entry) => [entry.name, entry.body.length])).toEqual([["b.txt", b.length]]);
});

test("the same rows with no rows before them are a true overlap error", async ({ sparse }) => {
  const { archive } = await sparse.attack(0);
  const found = await health(archive);
  expect(found[0]?.severity).toBe("error");
  expect(found[0]?.id).toBe("overlaps");
  expect(found.map((finding) => finding.id)).not.toContain("wrapped-offsets");
  expect(found[0]!.text).toContain("2 entries");
});
