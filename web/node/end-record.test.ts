// The walk to the end record (crates/layout/src/end.rs) with the real workers
// and wasm: a stray end signature in a comment, a comment that the end of the
// file cuts, a fake record, and the failure at the limit. The tests check the
// findings, the status, the comment and the facts that the page shows, and
// that the read worker reads the same archive.
import { expect } from "vitest";
import { panelZip } from "../e2e/archive-zip";
import {
  ENTRIES,
  SIGNATURE,
  falseRecordsTail,
  noteComment,
  withAppendedArchive,
  withDeclaredAfter,
  withFakeBehindLocator,
  withFakeRecord,
  withLongLocalExtra,
  zip,
} from "../e2e/end-record-zip";
import {
  decodeComment,
  formatFacts,
  plainLayout,
  regionName,
  unusualLayout,
} from "../src/archive/strings";
import { RegionKind } from "../src/contracts";
import { WRAPPED_FINDING, findings } from "../src/health/findings";
import { commentText } from "../src/label";
import { phaseText } from "../src/shell/phase";
import { test } from "./fixtures";
import type { Archive } from "./fixtures";

const health = async (archive: Archive) => findings(await archive.parse.health(), archive.outcome);

const ids = async (archive: Archive) => (await health(archive)).map((finding) => finding.id);

const findingText = async (archive: Archive, id: string) =>
  (await health(archive)).find((finding) => finding.id === id)?.text;

/** The facts of the Format section of the Archive panel. */
const formatList = async (archive: Archive) =>
  formatFacts(await archive.read!.facts(), archive.rows, "complete");
const fact = (list: { id: string; value: string }[], id: string) =>
  list.find((item) => item.id === id)?.value;

test("a stray signature in a comment opens, and the entries read", async ({ open }) => {
  const archive = await open(zip({ comment: noteComment }));
  expect(archive.outcome.kind).toBe("complete");
  expect(archive.rows).toBe(2);
  expect(await ids(archive)).toEqual(["false-end-marks"]);
  expect(await findingText(archive, "false-end-marks")).toContain(
    "This file has 1 end record mark after the start of the end record of this listing.",
  );
  // The read worker opens the file with the same rule.
  const chunk = await archive.read!.read(archive.names.indexOf("b.txt"), 0, 1 << 20);
  expect(new TextDecoder().decode(chunk.bytes)).toContain("second file");
});

test("a cut comment opens, and the panel shows the bytes that are there", async ({ open }) => {
  const archive = await open(zip({ comment: Buffer.from("cut comment"), commentLength: 500 }));
  expect(archive.outcome.kind).toBe("complete");
  expect(archive.rows).toBe(2);
  expect(await ids(archive)).toEqual(["comment-cut"]);
  expect(await findingText(archive, "comment-cut")).toMatch(/11\sB of 500\sB are there/);
  // The read worker gives the bytes that are there and the declared length.
  // A page test checks the note of the Archive panel.
  const facts = await archive.read!.facts();
  expect(new TextDecoder().decode(facts.comment)).toBe("cut comment");
  expect(facts.endRecord.commentLength).toBe(500);
});

test("a comment cut inside a character shows the part before it as UTF-8", async ({ open }) => {
  const whole = Buffer.from("Größe — 日本");
  const archive = await open(
    zip({ comment: whole.subarray(0, whole.length - 1), commentLength: whole.length }),
  );
  expect(archive.outcome.kind).toBe("complete");
  const facts = await archive.read!.facts();
  expect(facts.comment.length).toBeLessThan(facts.endRecord.commentLength);
  expect(decodeComment(facts.comment, true)).toEqual({ text: "Größe — 日", encoding: "utf-8" });
});

test("a comment with marks in a name-like form shows through the comment path", async ({
  open,
}) => {
  const archive = await open(
    zip({ comment: Buffer.concat([Buffer.from("a‮b "), SIGNATURE]), commentLength: 400 }),
  );
  expect(archive.outcome.kind).toBe("complete");
  // A control character shows as a mark, not as the character.
  const text = commentText(decodeComment((await archive.read!.facts()).comment).text);
  expect(text).not.toContain("‮");
  expect(text).toContain("PK");
});

test("a fake record in a comment wins, and the warning tells of the other record", async ({
  open,
}) => {
  const archive = await open(withFakeRecord());
  expect(archive.outcome.kind).toBe("complete");
  expect(archive.rows).toBe(1);
  expect(archive.names).toEqual(["FAKE.txt"]);
  const found = await health(archive);
  expect(found[0]?.severity).toBe("warning");
  expect(found.find((finding) => finding.id === "other-end-records")?.text).toContain(
    "This file has 1 other end record that points to another central directory.",
  );
});

test("a fake record behind a locator gets the warning, not the notice", async ({ open }) => {
  const archive = await open(withFakeBehindLocator());
  expect(archive.outcome.kind).toBe("complete");
  expect(archive.rows).toBe(2);
  expect(await ids(archive)).toEqual(["other-end-records"]);
  expect(await findingText(archive, "other-end-records")).toContain(
    "This file has 1 other end record that points to another central directory.",
  );
});

test("a tail with too many false records says what happened in plain words", async ({ open }) => {
  const { outcome } = await open(falseRecordsTail());
  expect(outcome.kind).toBe("failed");
  expect(outcome.kind === "complete" ? "" : phaseText(outcome)).toBe(
    "Cannot open: The end of this file has too many marks that look like a zip end record. Zipscope stopped at its limit of reads",
  );
});

test("a file with a cut end record says what happened in plain words", async ({ open }) => {
  const whole = zip({});
  const { outcome } = await open(whole.subarray(0, whole.length - 3));
  expect(outcome.kind).toBe("failed");
  expect(outcome.kind === "complete" ? "" : phaseText(outcome)).toContain(
    "Cannot open: The end of this file looks like a zip end record, but the record cannot be used.",
  );
});

test("a stored zip in a zip gets no finding of an end record", async ({ open }) => {
  const inner = panelZip({ entries: ENTRIES }).bytes;
  const name = "lib/a-long-name-of-a-nested-archive-1.2.3.jar";
  const archive = await open(zip({ entries: [{ name, data: inner }] }));
  expect(archive.outcome.kind).toBe("complete");
  // With no finding, the page shows no health strip.
  expect(await health(archive)).toEqual([]);
});

test("the Archive panel shows the first archive as bytes that no row uses", async ({ open }) => {
  const archive = await open(withAppendedArchive());
  expect(archive.outcome.kind).toBe("complete");
  const { map } = await archive.read!.layout();
  const prelude = map.ok ? map.regions.filter((region) => region.kind === RegionKind.PRELUDE) : [];
  expect(prelude.map(regionName)).toEqual(["Prelude"]);
  expect(fact(await formatList(archive), "entries")).toContain("1 declared, 1 found");
});

test("a notice by the sizes does not contradict the map of the local headers", async ({ open }) => {
  const archive = await open(withLongLocalExtra());
  expect(archive.outcome.kind).toBe("complete");
  const found = await health(archive);
  expect(found[0]?.severity).toBe("notice");
  expect(found.map((finding) => finding.id)).toEqual(["earlier-end-records"]);
  expect(found[0]!.text).toContain(
    "By the sizes in the central directory, no entry covers that end record.",
  );
  // The panel gives the one sentence of a plain layout.
  const { map } = await archive.read!.layout();
  expect(map.ok && unusualLayout(map.regions, map.counts)).toBe(false);
  expect(plainLayout(archive.file.size)).toContain(
    "is entry data, the central directory or an end record",
  );
});

test("the Archive panel does not contradict a declared offset after the directory", async ({
  open,
}) => {
  const archive = await open(withDeclaredAfter(1));
  expect(archive.outcome.kind).toBe("complete");
  // The size of the directory is true, and no fact of the panel gives another place.
  const list = await formatList(archive);
  expect(fact(list, "entries")).toContain("2 declared, 2 found");
  expect(fact(list, "directory")).toBeUndefined();
  // The Archive panel shows the fact of the offsets with the finding only.
  expect(await ids(archive)).not.toContain(WRAPPED_FINDING);
});
