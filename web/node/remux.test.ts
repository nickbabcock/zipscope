// The dialog and the report of the zstd copy, with the real workers and
// wasm: the hint for each archive shape, the bytes outside the entries, the
// rows that the copy leaves out, an archive over 4 GiB with no Zip64, and
// the memory limit.
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect } from "vitest";
import { contentZip } from "../e2e/content-zip";
import type { ContentEntry } from "../e2e/content-zip";
import { root } from "../e2e/test-data";
import {
  OUTSIDE,
  REMUX_ENTRIES,
  SMALL,
  insertBytes,
  noise,
  readCopy,
  text,
} from "../e2e/remux-zip";
import { DIRECTORY, GIB, theShape, writeWrappedZip } from "../e2e/wrapped-zip";
import type { WrappedRow } from "../e2e/wrapped-zip";
import { layoutSummary } from "../src/archive/strings";
import { HARD_BUDGET_BYTES, PROGRESS_BYTES, WRAPPED_REASON } from "../src/contracts";
import type { RemuxReport } from "../src/contracts";
import { WRAPPED_FINDING, findings } from "../src/health/findings";
import { countRows, outsideBytes } from "../src/remux/hint";
import {
  NOT_LIKELY,
  REMUX_NOTE,
  remuxFacts,
  remuxFileName,
  remuxHintText,
  remuxItemText,
  remuxSummary,
} from "../src/remux/text";
import { startRemux } from "../src/write/client";
import { memoryHandle, runRemux } from "../src/write/harness";
import { expose, test as base } from "./fixtures";
import type { Archive } from "./fixtures";

/** `listed` opens an archive (entries or bytes) with a file name, and
 *  checks that it lists. */
const test = base.extend(
  "listed",
  async ({ open }) =>
    async (source: Buffer | string | ContentEntry[], name = "remux.zip") => {
      const bytes = Array.isArray(source) ? contentZip(source) : source;
      const archive = await open(bytes, { name });
      expect(archive.outcome.kind).toBe("complete");
      return archive;
    },
);

/** The real counts and byte map of an archive with no row that has the
 *  mark of a wrapped offset, and the facts and the hint that the text module
 *  gives for them. `RemuxDialog` has more rules for marked rows, and a page
 *  test checks them. */
async function texts(archive: Archive) {
  const counts = (await countRows(archive.reader, archive.rows, () => true))!;
  expect(counts.wrapped).toBe(0);
  const outside = outsideBytes((await archive.read!.layout()).map);
  return {
    outside,
    facts: remuxFacts(archive.rows, counts.bytes, counts.leftOut),
    hint: remuxHintText(counts.hint, archive.file.size, counts.leftOut, outside),
  };
}

/** Saves the copy to a file of the save picker with two encoders, and
 *  returns the report and the bytes of the copy. */
async function saveCopy(archive: Archive) {
  const out = memoryHandle();
  const sink = { kind: "file", handle: out.handle } as const;
  const marks = archive.reader.marksColumns();
  const { file, header, rows } = archive;
  const { report } = await runRemux(expose, file, header!, rows, sink, 2, HARD_BUDGET_BYTES, marks);
  return { report, bytes: out.bytes() };
}

/** The summary of a copy of an archive with no marked row. */
async function summaryOf(archive: Archive, report: RemuxReport) {
  const { outside } = await texts(archive);
  const { file } = archive;
  return remuxSummary(remuxFileName(file.name), report, "file", file.size, outside);
}

test("much stored data: the hint gives its part", async ({ listed }) => {
  const { hint } = await texts(await listed(REMUX_ENTRIES));
  // The stored rows: docs/stored.txt, bin/noise.bin and tail.txt (290,000
  // bytes). img/red.png is a compressed format that deflate does not make
  // smaller.
  expect(hint.text).toBe(
    "283.2 KiB of this archive (99%) is stored or barely compressed. This does not include 98 B of images, video and other compressed formats. They stay as they are.",
  );
  expect(hint.low).toBe(false);
  expect(REMUX_NOTE).toContain(
    "Entries that zstd does not make smaller keep their current compression.",
  );
});

test("no stored data: the copy is not likely to be much smaller", async ({ listed }) => {
  const { hint } = await texts(
    await listed([
      { name: "a.txt", data: text(300_000, 1) },
      { name: "b.txt", data: text(200_000, 2) },
    ]),
  );
  expect(hint.text).toBe(
    "No entry of this archive is stored or barely compressed. The copy is not likely to be much smaller than the archive.",
  );
  expect(hint.low).toBe(true);
});

test("a stored row that the copy leaves out: the hint and the report do not count it", async ({
  listed,
}) => {
  // No row has the mark of a wrapped offset here. The list gives both rows as stored.
  const archive = await listed(
    [
      { name: "secret.bin", data: noise(400_000), method: 0, flags: 1 },
      { name: "small.txt", data: text(2000, 2), method: 0 },
    ],
    "encrypted.zip",
  );
  const dialog = await texts(archive);
  expect(dialog.facts).toContain("The copy leaves it out.");
  expect(dialog.hint.text).toMatch(
    /^2\.0\sKiB of this archive \([\d.]+%\) is stored or barely compressed, not counting the entries left out\.$/,
  );
  const { report } = await saveCopy(archive);
  const summary = await summaryOf(archive, report);
  expect(summary).toContain("1 entry left out.");
  expect(summary).toMatch(/The archive is 392\.\d\sKiB\./);
  expect(summary).not.toContain("smaller than");
});

test("an encrypted folder with no mark: the copy keeps it, so the dialog does not count it", async ({
  listed,
}) => {
  const archive = await listed(
    [
      { name: "enc/", data: Buffer.alloc(0), method: 0, flags: 1 },
      { name: "small.txt", data: text(2000, 2), method: 0 },
    ],
    "folder.zip",
  );
  expect((await texts(archive)).facts).toMatch(/^2 entries, 2\.0\sKiB uncompressed\.$/);
  const copy = await saveCopy(archive);
  expect(await summaryOf(archive, copy.report)).toContain("Each entry verified.");
  expect(readCopy(Buffer.from(copy.bytes)).entries.map((entry) => entry.name)).toEqual([
    "enc/",
    "small.txt",
  ]);
});

describe("bytes outside the entries", () => {
  // The bytes of a test archive that are outside the entries, in each place of a file.
  for (const form of [
    { name: "a prelude", zip: () => Buffer.concat([noise(1_000_000), contentZip(SMALL)]) },
    {
      name: "a prelude that the offsets count",
      zip: () => insertBytes(contentZip(SMALL), 0, noise(1_000_000)),
    },
    { name: "an epilogue", zip: () => Buffer.concat([contentZip(SMALL), noise(1_000_000)]) },
  ]) {
    test(`${form.name} with no row left out: the dialog and the report say that the copy does not keep it`, async ({
      listed,
    }) => {
      const archive = await listed(form.zip(), "outside.zip");
      const { hint } = await texts(archive);
      expect(hint.text).toBe(`No entry of this archive is stored or barely compressed. ${OUTSIDE}`);
      // The estimate is the line of `NOT_LIKELY`.
      expect(hint.text).not.toContain(NOT_LIKELY);
      const copy = await saveCopy(archive);
      const summary = await summaryOf(archive, copy.report);
      expect(summary).toMatch(/\(100%\) smaller than the archive/);
      expect(summary).toContain(OUTSIDE);
      expect(readCopy(Buffer.from(copy.bytes)).entries.map((entry) => entry.name)).toEqual([
        "a.txt",
      ]);
      expect(copy.bytes.length).toBeLessThan(1000);
    });
  }

  test("a gap between two entries: the dialog and the report say that the copy does not keep it", async ({
    listed,
  }) => {
    const zip = contentZip([
      { name: "a.txt", data: text(2000, 1) },
      { name: "b.txt", data: text(2000, 2) },
    ]);
    // The second local header is the first signature after the start of the first.
    const second = zip.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 4);
    const archive = await listed(insertBytes(zip, second, noise(1_000_000)), "gap.zip");
    expect((await texts(archive)).hint.text).toBe(
      `No entry of this archive is stored or barely compressed. ${OUTSIDE}`,
    );
    const copy = await saveCopy(archive);
    expect(await summaryOf(archive, copy.report)).toContain(OUTSIDE);
    expect(readCopy(Buffer.from(copy.bytes)).entries.map((entry) => entry.name)).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  test("a stub and a large payload: a part of the change is the stub, and the report says so", async ({
    listed,
  }) => {
    const zip = contentZip([
      { name: "app.dat", data: noise(5_000_000), method: 0 },
      { name: "readme.txt", data: text(30_000, 1), method: 0 },
    ]);
    const archive = await listed(Buffer.concat([noise(1_000_000, 3), zip]), "stub.zip");
    expect((await texts(archive)).hint.text).toBe(
      `4.8 MiB of this archive (83%) is stored or barely compressed. ${OUTSIDE}`,
    );
    const { report } = await saveCopy(archive);
    const summary = await summaryOf(archive, report);
    expect(summary).toContain(
      `The copy is 1005.8 KiB (17%) smaller than the archive (5.8 MiB). ${OUTSIDE}`,
    );
  });

  test("a prelude and a row left out: the fact stays, and it does not count the row", async ({
    listed,
  }) => {
    const zip = contentZip([
      { name: "secret.bin", data: noise(10_000), method: 0, flags: 1 },
      { name: "a.txt", data: text(2000, 1) },
    ]);
    const archive = await listed(Buffer.concat([noise(1_000_000), zip]), "both.zip");
    expect((await texts(archive)).hint.text).toBe(
      `No entry of this archive is stored or barely compressed, not counting the entries left out. ${OUTSIDE}`,
    );
    const { report } = await saveCopy(archive);
    const summary = await summaryOf(archive, report);
    expect(summary).toMatch(/The archive is 986\.\d\sKiB\./);
    expect(summary).toContain(OUTSIDE);
    expect(summary).toContain("1 entry left out.");
    expect(summary).not.toContain("smaller than");
  });

  test("a small part outside the entries: the estimate stays, and there is no fact", async ({
    listed,
  }) => {
    // Deflate makes this about half its size: not barely compressed.
    const data = Buffer.concat([noise(200_000, 1), text(200_000, 1)]);
    const zip = contentZip([{ name: "a.bin", data }]);
    // Less than 5% of the file.
    const archive = await listed(Buffer.concat([noise(1000), zip]), "little.zip");
    expect((await texts(archive)).hint.text).toBe(
      `No entry of this archive is stored or barely compressed. ${NOT_LIKELY}`,
    );
    const { report } = await saveCopy(archive);
    const summary = await summaryOf(archive, report);
    expect(summary).toContain("Each entry verified.");
    expect(summary).not.toContain("outside the entries");
  });

  test("a row with no local header: its data shows as a gap, so the dialog gives no size and no estimate", async ({
    listed,
  }) => {
    const zip = contentZip([
      { name: "a.txt", data: text(4_000_000, 1) },
      { name: "b.txt", data: text(2000, 2) },
    ]);
    zip.writeUInt32LE(0, 0);
    const archive = await listed(zip, "no-header.zip");
    expect((await texts(archive)).hint.text).toBe(
      "No entry of this archive is stored or barely compressed.",
    );
    const { report } = await saveCopy(archive);
    const summary = await summaryOf(archive, report);
    expect(summary).toContain("1 entry left out.");
    expect(summary).not.toContain("outside the entries");
  });
});

test("the memory limit stops the copy before it starts", async ({ open }) => {
  const hard = 48 * 2 ** 20;
  const archive = await open(contentZip(REMUX_ENTRIES), { budget: { soft: 2 ** 30, hard } });
  expect(archive.outcome.kind).toBe("complete");
  expect(() =>
    startRemux({
      file: archive.file,
      header: archive.header!,
      rows: archive.rows,
      sink: { kind: "file", handle: memoryHandle().handle },
      progress: new SharedArrayBuffer(PROGRESS_BYTES),
      hard,
      marks: archive.reader.marksColumns(),
      cores: 2,
    }),
  ).toThrow("memory limit");
});

describe("an archive over 4 GiB with no Zip64", () => {
  // The file goes in a folder of its own below `target`, as for the page
  // tests, and the fixture removes it. The facts, the hint and the summary of
  // the dialog for marked rows come from rules in `RemuxDialog`, so a page
  // test of `e2e/wrapped-offset.spec.ts` checks them. These tests check the
  // counts and the copy.
  const test = base.extend("wrapped", async ({ open }, { onCleanup }) => {
    const folder = mkdtempSync(path.join(root, "target", "wrapped-offset-"));
    onCleanup(() => rmSync(folder, { recursive: true, force: true }));
    return async (rows: WrappedRow[], directory: number) => {
      const file = path.join(folder, "wrapped.zip");
      writeWrappedZip(file, rows, directory);
      const archive = await open(file);
      expect(archive.outcome.kind).toBe("complete");
      return archive;
    };
  });
  const count = (archive: Archive) => countRows(archive.reader, archive.rows, () => true);

  test("a zstd copy leaves the marked rows out with their reason, and they add no hint", async ({
    wrapped,
  }) => {
    const archive = await wrapped(theShape(), DIRECTORY);
    // The list gives a.bin and b.bin as stored, with 4.50 GiB. The hint has
    // only the 26 bytes of c.txt.
    expect(await count(archive)).toMatchObject({ wrapped: 2, hint: { loose: 26, formats: 0 } });
    const { report } = await saveCopy(archive);
    expect(report.outcome).toBe("complete");
    expect(report.items.map(remuxItemText)).toEqual([
      `Left out. ${WRAPPED_REASON}`,
      `Left out. ${WRAPPED_REASON}`,
    ]);
  });

  test("a size field with the low 32 bits of a marked row leaves a gap of 4 GiB in the byte map", async ({
    wrapped,
  }) => {
    // The true size of a.bin is 5 GiB, and its size field holds the low 32
    // bits. The list thus shows 4 GiB of its bytes as a gap. These bytes are
    // in an entry.
    const rows: WrappedRow[] = [
      { name: "a.bin", at: 0, size: GIB },
      { name: "c.txt", at: 5 * GIB + 100, body: "The last row can be read.\n" },
    ];
    const archive = await wrapped(rows, 5 * GIB + 300);
    const { map } = await archive.read!.layout();
    expect(map.ok && layoutSummary(archive.file.size, map.counts)).toMatch(
      /2 gaps hold 4\.00\sGiB\./,
    );
    expect((await count(archive))?.wrapped).toBe(1);
    expect((await saveCopy(archive)).report.items).toHaveLength(1);
  });

  test("the count of a zstd copy has the marked files, not the marked folders", async ({
    wrapped,
  }) => {
    // An old writer puts folder rows before 4 GiB too, so an honest archive has this.
    const rows: WrappedRow[] = [
      { name: "one/", at: 0 },
      { name: "two/", at: 100 },
      { name: "a.bin", at: 200, size: 2 * GIB },
      { name: "b.bin", at: 2 * GIB + 300, size: 2 * GIB + GIB / 2 },
      { name: "c.txt", at: 4 * GIB + GIB / 2 + 400, body: "The last row can be read.\n" },
    ];
    const archive = await wrapped(rows, DIRECTORY + 200);
    expect((await count(archive))?.wrapped).toBe(2);
    const copy = await saveCopy(archive);
    expect(copy.report.items).toHaveLength(2);
    expect(readCopy(Buffer.from(copy.bytes)).entries.map((entry) => entry.name)).toEqual([
      "one/",
      "two/",
      "c.txt",
    ]);
  });

  test("a zstd copy keeps a folder that has the mark", async ({ wrapped }) => {
    const rows: WrappedRow[] = [
      { name: "only/", at: 0 },
      { name: "c.txt", at: 4 * GIB + GIB / 2 + 200, body: "The last row can be read.\n" },
    ];
    const archive = await wrapped(rows, DIRECTORY);
    // The row has the mark: the archive gets the finding.
    const found = findings(await archive.parse.health(), archive.outcome);
    expect(found.map((finding) => finding.id)).toContain(WRAPPED_FINDING);
    expect(await count(archive)).toMatchObject({ bytes: 26, leftOut: 0, wrapped: 0 });
    const copy = await saveCopy(archive);
    expect(copy.report.items).toEqual([]);
    expect(readCopy(Buffer.from(copy.bytes)).entries.map((entry) => entry.name)).toEqual([
      "only/",
      "c.txt",
    ]);
  });
});
