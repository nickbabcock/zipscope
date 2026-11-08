import { expect, test } from "vitest";
import type { HealthReport, ParseOutcome } from "../contracts";
import { formatSize } from "../format";
import {
  budgetPrompt,
  DECLARED_AFTER_FINDING,
  EARLIER_FINDING,
  findings,
  ROWS_MISSING,
  severityCounts,
  withoutBudgetNotice,
} from "./findings";

function report(changes: Partial<HealthReport> = {}): HealthReport {
  const none = { rows: 0, example: -1 };
  return {
    rows: 10,
    declaredEntries: 10,
    countMismatch: false,
    countWrapped: false,
    duplicates: none,
    bombs: none,
    overlaps: none,
    overlapData: none,
    intoDirectory: none,
    depthCap: none,
    folderCap: none,
    controlNames: none,
    wrapped: none,
    overlapsChecked: true,
    duplicatesChecked: true,
    preludeBytes: 0,
    epilogueBytes: 0,
    endRecord: {
      commentDeclared: 0,
      commentPresent: 0,
      skipped: 0,
      others: 0,
      unchecked: 0,
      secondDirectory: false,
      declaredDirectory: 0,
      foundDirectory: 0,
      earlierRecords: 0,
      earlierRecord: 0,
      earlierDirectory: 0,
    },
    encrypted: { zipCrypto: 0, aes128: 0, aes192: 0, aes256: 0, other: 0, aesUnknown: 0 },
    budget: {
      limits: { soft: 2 ** 30, hard: 2 ** 31 },
      storeBytes: 0,
      softReached: false,
      declined: false,
      hardReached: false,
      rowsMissing: false,
    },
    ...changes,
  };
}

test("a healthy archive has no findings", () => {
  expect(findings(report())).toEqual([]);
});

test("lists each finding, the most severe first", () => {
  const list = findings(
    report({
      error: "invalid central directory signature",
      countMismatch: true,
      declaredEntries: 12,
      duplicates: { rows: 2, example: 3 },
      bombs: { rows: 1, example: 4 },
      overlaps: { rows: 5, example: 0 },
      overlapData: { rows: 5, example: 0 },
      depthCap: { rows: 1, example: 6 },
      folderCap: { rows: 3, example: 7 },
      controlNames: { rows: 2, example: 9 },
      preludeBytes: 2048,
      epilogueBytes: 10,
      encrypted: { zipCrypto: 1, aes128: 0, aes192: 0, aes256: 2, other: 0, aesUnknown: 0 },
    }),
  );
  expect(list.map((finding) => finding.id)).toEqual([
    "parse-error",
    "overlaps",
    "bomb-ratio",
    "count-mismatch",
    "duplicate-names",
    "depth-cap",
    "folder-cap",
    "control-names",
    "prelude",
    "epilogue",
    "encrypted",
  ]);
  const text = Object.fromEntries(list.map((finding) => [finding.id, finding.text]));
  expect(text["parse-error"]).toBe(
    "Parsing stopped after 10 entries: invalid central directory signature. The listing keeps the entries before the error.",
  );
  expect(text["count-mismatch"]).toBe(
    "The archive declares 12 entries, but its central directory has 10 entries.",
  );
  expect(text["duplicate-names"]).toBe("2 entries share a name with another entry.");
  expect(text["bomb-ratio"]).toBe(
    "1 entry declares more than 100 times its compressed size (bomb-like).",
  );
  expect(text["prelude"]).toBe("2.0\u00a0KiB of data is before the first entry.");
  expect(text["encrypted"]).toBe("3 entries are encrypted: 1 ZipCrypto, 2 AES-256.");
  expect(list.find((finding) => finding.id === "duplicate-names")?.example).toBe(3);
});

test("shows how the memory budget ended", () => {
  const budget = report().budget;
  expect(findings(report({ budget: { ...budget, softReached: true } }))[0]).toMatchObject({
    id: "memory-budget",
    severity: "notice",
  });
  expect(
    findings(report({ budget: { ...budget, softReached: true, declined: true } }))[0],
  ).toMatchObject({ id: "memory-budget", severity: "warning" });
  expect(findings(report({ budget: { ...budget, hardReached: true } }))[0]).toMatchObject({
    id: "memory-limit",
    severity: "error",
    text: "Parsing stopped at the 2.00\u00a0GiB memory limit after 10 entries. The listing is partial.",
  });
  // A listing with rows missing says so.
  const missing = { ...budget, hardReached: true, rowsMissing: true };
  expect(findings(report({ budget: missing }))[0]?.text).toBe(
    `Parsing stopped at the 2.00\u00a0GiB memory limit after 10 entries. The listing is partial. ${ROWS_MISSING}`,
  );
});

test("says which view request the memory limit refused", () => {
  const budget = { ...report().budget, hardReached: true };
  const text = (changes: Partial<HealthReport>, outcome?: ParseOutcome) =>
    findings(report(changes), outcome).map((finding) => finding.text);
  expect(text({ budget: { ...budget, refused: "sort" } })).toEqual([
    "The sort could not run at the 2.00\u00a0GiB memory limit. Parsing stopped after 10 entries. The listing is partial.",
  ]);
  // After a complete parse, only the request stopped.
  expect(
    text({ budget: { ...budget, refused: "search" } }, { kind: "complete", rows: 10 }),
  ).toEqual(["The search could not run at the 2.00\u00a0GiB memory limit."]);
  // Another error stopped the parse first. It keeps its own finding.
  expect(text({ error: "invalid record", budget: { ...budget, refused: "folder" } })).toEqual([
    "Parsing stopped after 10 entries: invalid record. The listing keeps the entries before the error.",
    "The folder could not change at the 2.00\u00a0GiB memory limit.",
  ]);
});

test("formats the prompt", () => {
  expect(budgetPrompt(4_200_000, 2 ** 30)).toBe(
    "Paused: 4,200,000 entries listed using 1.00\u00a0GiB so far. Continue?",
  );
});

test("hides the finding of the soft budget only while the prompt shows", () => {
  const budget = report().budget;
  const list = findings(report({ budget: { ...budget, softReached: true }, preludeBytes: 10 }));
  expect(list.map((finding) => finding.id)).toEqual(["memory-budget", "prelude"]);
  expect(withoutBudgetNotice(list, true).map((finding) => finding.id)).toEqual(["prelude"]);
  expect(withoutBudgetNotice(list, false).map((finding) => finding.id)).toEqual([
    "memory-budget",
    "prelude",
  ]);
});

test("the count of the open strip splits by severity, the most severe first", () => {
  const item = (severity: "error" | "warning" | "notice") => ({
    id: "x",
    severity,
    text: "",
    example: -1,
  });
  expect(severityCounts([item("notice"), item("error"), item("error"), item("warning")])).toBe(
    "2 errors, 1 warning, 1 notice",
  );
  expect(severityCounts([item("notice")])).toBe("1 notice");
});

test("the finding of control names has the count, a row and a warning level", () => {
  const [one] = findings(report({ controlNames: { rows: 1, example: 4 } }));
  expect(one).toMatchObject({ id: "control-names", severity: "warning", example: 4 });
  expect(one!.text).toMatch(/^1 entry has a name with hidden or control characters/);
  const [many] = findings(report({ controlNames: { rows: 1_200, example: 0 } }));
  expect(many!.text).toMatch(/^1,200 entries have names with/);
  expect(findings(report({ controlNames: { rows: 0, example: -1 } }))).toEqual([]);
});

const endRecord = (changes: Partial<HealthReport["endRecord"]>) => ({
  endRecord: {
    commentDeclared: 0,
    commentPresent: 0,
    skipped: 0,
    others: 0,
    unchecked: 0,
    secondDirectory: false,
    declaredDirectory: 0,
    foundDirectory: 0,
    earlierRecords: 0,
    earlierRecord: 0,
    earlierDirectory: 0,
    ...changes,
  },
});

test("another end record is a warning that says what the file has", () => {
  expect(findings(report(endRecord({ others: 1 })))).toEqual([
    {
      id: "other-end-records",
      severity: "warning",
      text: "This file has 1 other end record that points to another central directory. This listing shows the entries of one central directory.",
      example: -1,
    },
  ]);
  expect(findings(report(endRecord({ others: 2 })))[0]?.text).toContain(
    "2 other end records that point to",
  );
});

test("records that the limit stopped are counted, also when no other record was found", () => {
  const [only] = findings(report(endRecord({ unchecked: 3 })));
  expect(only?.severity).toBe("warning");
  expect(only?.text).toBe(
    "Zipscope did not check 3 other possible end records in this file. This listing shows the entries of one central directory.",
  );
  const [both] = findings(report(endRecord({ others: 1, unchecked: 1 })));
  expect(both?.text).toContain("1 other end record that");
  expect(both?.text).toContain("did not check 1 other possible end record in");
});

test("one end record with a second directory is a warning", () => {
  const [only] = findings(report(endRecord({ secondDirectory: true })));
  expect(only?.id).toBe("other-end-records");
  expect(only?.severity).toBe("warning");
  expect(only?.text).toBe(
    "The end record of this file also points to a second central directory. This listing shows the entries of one central directory.",
  );
});

test("a mark with no other directory is a notice that says what the file has", () => {
  expect(findings(report(endRecord({ skipped: 1 })))).toEqual([
    {
      id: "false-end-marks",
      severity: "notice",
      text: "This file has 1 end record mark after the start of the end record of this listing. It points to no other central directory.",
      example: -1,
    },
  ]);
  expect(findings(report(endRecord({ skipped: 2000 })))[0]?.text).toBe(
    "This file has 2,000 end record marks after the start of the end record of this listing. They point to no other central directory.",
  );
});

test("a cut comment is a notice with the bytes that are there", () => {
  expect(findings(report(endRecord({ commentDeclared: 100, commentPresent: 8 })))).toEqual([
    {
      id: "comment-cut",
      severity: "notice",
      text: `The file ends inside the archive comment: ${formatSize(8)} of ${formatSize(100)} are there. The file can be cut off at its end.`,
      example: -1,
    },
  ]);
  const [none] = findings(report(endRecord({ commentDeclared: 100, commentPresent: 0 })));
  expect(none?.text).toContain(`${formatSize(0)} of ${formatSize(100)} are there`);
  const [one] = findings(report(endRecord({ commentDeclared: 100, commentPresent: 1 })));
  expect(one?.text).toContain(`${formatSize(1)} of ${formatSize(100)} is there`);
});

test("the finding of wrapped offsets says what is wrong and how many rows cannot be read", () => {
  const [one] = findings(report({ wrapped: { rows: 1, example: 4 } }));
  expect(one).toEqual({
    id: "wrapped-offsets",
    severity: "warning",
    text: "This archive is over 4 GiB and was written without Zip64, the format that large archives need. 1 entry cannot be read here.",
    example: 4,
  });
  const [many] = findings(report({ wrapped: { rows: 1_200, example: 0 } }));
  expect(many?.text).toContain("1,200 entries cannot be read here.");
  expect(findings(report({ wrapped: { rows: 0, example: -1 } }))).toEqual([]);
});

test("a count that wrapped is one notice, with no false sentence", () => {
  const list = findings(report({ rows: 65_539, declaredEntries: 3, countWrapped: true }));
  expect(list.map((finding) => [finding.id, finding.severity])).toEqual([
    ["count-wrapped", "notice"],
  ]);
  expect(list[0]?.text).toBe(
    "The end record declares 3 entries, and the central directory has 65,539 entries. With no Zip64, the count has only 16 bits, and the two values agree in 16 bits.",
  );
  expect(list[0]?.text).not.toContain("but its central directory");
});

test("a count of 0 and of 1 in the notice of a wrapped count", () => {
  const zero = findings(report({ rows: 65_536, declaredEntries: 0, countWrapped: true }));
  expect(zero[0]?.text).toContain("declares 0 entries, and the central directory has 65,536");
  const one = findings(report({ rows: 65_537, declaredEntries: 1, countWrapped: true }));
  expect(one[0]?.text).toContain("declares 1 entry, and the central directory has 65,537");
});

test("an overlap of rows with data is an error with the bomb sentence", () => {
  const two = { rows: 2, example: 3 };
  const list = findings(report({ overlaps: two, overlapData: two }));
  expect(list).toEqual([
    {
      id: "overlaps",
      severity: "error",
      text: "2 entries have bytes that overlap other entries. An overlapping-file zip bomb has this shape.",
      example: 3,
    },
  ]);
});

test("an overlap with a row with no data is a warning with no word of a bomb", () => {
  const two = findings(report({ overlaps: { rows: 2, example: 4 } }));
  expect(two).toEqual([
    {
      id: "overlap-no-data",
      severity: "warning",
      text: "2 entries are at places that overlap other entries. Each overlap has an entry with no data.",
      example: 4,
    },
  ]);
  const one = findings(
    report({ overlaps: { rows: 3, example: 0 }, overlapData: { rows: 2, example: 1 } }),
  );
  expect(one.map((finding) => [finding.id, finding.severity, finding.example])).toEqual([
    ["overlaps", "error", 1],
    ["overlap-no-data", "warning", -1],
  ]);
  expect(one[1]?.text).toBe(
    "1 entry is at a place that overlaps another entry. The overlap has an entry with no data.",
  );
});

test("data into the central directory is a warning with an example", () => {
  const one = findings(report({ intoDirectory: { rows: 1, example: 7 } }));
  expect(one).toEqual([
    {
      id: "into-directory",
      severity: "warning",
      text: "1 entry has bytes that run into the central directory.",
      example: 7,
    },
  ]);
  const two = findings(report({ intoDirectory: { rows: 2, example: 0 } }));
  expect(two[0]?.text).toBe("2 entries have bytes that run into the central directory.");
});

test("a declared offset after the central directory is a warning with both places", () => {
  expect(findings(report(endRecord({ declaredDirectory: 150, foundDirectory: 100 })))).toEqual([
    {
      id: DECLARED_AFTER_FINDING,
      severity: "warning",
      text: "The end record declares the central directory at 0x00000096, but the central directory is at 0x00000064, 50 bytes before that place.",
      example: -1,
    },
  ]);
  expect(
    findings(report(endRecord({ declaredDirectory: 101, foundDirectory: 100 })))[0]?.text,
  ).toContain("1 byte before that place.");
  expect(
    findings(report(endRecord({ declaredDirectory: 5, foundDirectory: 0 })))[0]?.text,
  ).toContain("at 0x00000000, 5 bytes");
});

test("an end record that no entry covers is a notice with its places", () => {
  expect(
    findings(report(endRecord({ earlierRecords: 1, earlierRecord: 214, earlierDirectory: 104 }))),
  ).toEqual([
    {
      id: EARLIER_FINDING,
      severity: "notice",
      text: "Before the end record of this listing, this file has another end record at 0x000000d6, with a central directory at 0x00000068. By the sizes in the central directory, no entry covers that end record.",
      example: -1,
    },
  ]);
  expect(
    findings(report(endRecord({ earlierRecords: 2, earlierRecord: 444, earlierDirectory: 281 }))),
  ).toEqual([
    {
      id: EARLIER_FINDING,
      severity: "notice",
      text: "Before the end record of this listing, this file has at least 2 other end records with a central directory. The nearest is at 0x000001bc, with its central directory at 0x00000119. By the sizes in the central directory, no entry covers that end record.",
      example: -1,
    },
  ]);
});

test("the texts of the end record say nothing of a tool", () => {
  const list = findings(
    report(
      endRecord({
        commentDeclared: 100,
        commentPresent: 8,
        skipped: 1,
        others: 1,
        unchecked: 1,
        secondDirectory: true,
        declaredDirectory: 150,
        foundDirectory: 100,
        earlierRecords: 2,
        earlierRecord: 90,
        earlierDirectory: 10,
      }),
    ),
  );
  expect(list).toHaveLength(5);
  for (const finding of list) expect(finding.text).not.toMatch(/tool|python|extract/i);
});
