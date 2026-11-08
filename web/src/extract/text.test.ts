// The text of the extraction.
import { expect, test } from "vitest";
import { ExtractSkip, Renamed, WRAPPED_REASON } from "../contracts";
import type { ExtractPlanInfo, ExtractReport } from "../contracts";
import {
  reportTitle,
  itemCounts,
  itemLead,
  itemOutcome,
  itemReason,
  itemText,
  needsConfirmation,
  planNote,
  reportTsv,
  SAFEGUARD,
  summary,
  warnings,
} from "./text";

function plan(values: Partial<ExtractPlanInfo>): ExtractPlanInfo {
  return {
    id: 1,
    target: { kind: "folder", path: "docs/" },
    name: "docs",
    files: 2,
    folders: 0,
    bytes: 100,
    compressed: 50,
    large: 0,
    bombs: 0,
    largest: 60,
    skipped: 0,
    renamed: 0,
    ...values,
  };
}

const report = (values: Partial<ExtractReport>): ExtractReport => ({
  outcome: "complete",
  written: 2,
  bytes: 100,
  items: [],
  more: 0,
  ...values,
});

test("asks for confirmation for a large or bomb-like plan only", () => {
  expect(needsConfirmation(plan({}))).toBe(false);
  expect(warnings(plan({ large: 1, largest: 2 ** 31 }))[0]).toContain(
    "1 file claims more than 1\u00a0GiB",
  );
  expect(warnings(plan({ bytes: 2 ** 30 + 1 }))[0]).toContain("in total, more than 1\u00a0GiB");
  expect(needsConfirmation(plan({ bytes: 2 ** 30 }))).toBe(false);
  // The lead names the danger, and Zipscope says only what the sizes show.
  expect(warnings(plan({ bombs: 3 }))).toEqual([
    "3 files look like a zip bomb.",
    "They are more than 100 times larger than their compressed data.",
    "An extraction can write all of the declared bytes.",
  ]);
  const entry = plan({ target: { kind: "entry", row: 0 }, large: 1, bombs: 1, largest: 2 ** 31 });
  expect(warnings(entry)).toEqual([
    "This entry looks like a zip bomb.",
    "It is more than 100 times larger than its compressed data.",
    "This entry claims 2.00\u00a0GiB, more than 1\u00a0GiB.",
    "An extraction can write all of the declared bytes.",
  ]);
  // The safeguard is not a risk: the dialog shows it apart, in ink.
  expect(warnings(entry)).not.toContain(SAFEGUARD);
  expect(SAFEGUARD).toBe("Zipscope stops a file when its data is longer than its declared size.");
});

test("explains each report item", () => {
  expect(itemText({ row: 1, name: "../x", skip: ExtractSkip.TRAVERSAL })).toBe(
    "Skipped: the path has a “..” segment",
  );
  expect(
    itemText({ row: 1, name: "a", skip: ExtractSkip.VERIFY, detail: "The CRC-32 is wrong" }),
  ).toBe("Not written: the data did not verify: The CRC-32 is wrong");
  expect(
    itemText({ row: 2, name: "CON", path: "CON_", renamed: Renamed.RESERVED | Renamed.COLLISION }),
  ).toBe(
    "Renamed to CON_ (a Windows reserved name; the same name as another item when case is ignored)",
  );
});

test("copies the report as tab-separated lines without tabs in the values", () => {
  const items = [{ row: 0, name: "a\tb", skip: ExtractSkip.LINK }];
  expect(reportTsv(report({ items, more: 2 }))).toBe(
    "a b\tSkipped: a symbolic link\n… and 2 more\t",
  );
  // Copied text has one fixed form in all locales: no group marks.
  expect(reportTsv(report({ items, more: 12_345 }))).toBe(
    "a b\tSkipped: a symbolic link\n… and 12345 more\t",
  );
});

test("sums up the report as the part of the whole", () => {
  expect(summary(plan({}), report({ output: "docs (2)" }))).toBe(
    "Extracted 2 of 2 files (100\u00a0B written) to “docs (2)”. Each file verified.",
  );
  expect(summary(plan({ files: 7 }), report({ written: 5, output: "docs" }))).toBe(
    "Extracted 5 of 7 files (100\u00a0B written) to “docs”. Each written file verified.",
  );
  // The counts come from the job: the summary stays true when the report
  // does not list all items, also when the hidden items failed.
  expect(
    summary(plan({ files: 12_000 }), report({ written: 11_999, more: 1, output: "docs" })),
  ).toBe(
    "Extracted 11,999 of 12,000 files (100\u00a0B written) to “docs”. Each written file verified.",
  );
  expect(summary(plan({ files: 3 }), report({ written: 0, bytes: 0, output: "docs" }))).toBe(
    "Zipscope wrote no files to “docs”.",
  );
  expect(summary(plan({}), report({ outcome: "cancelled", written: 1 }))).toBe(
    "The extraction stopped after 1 of 2 files (100\u00a0B written).",
  );
  expect(summary(plan({}), report({ outcome: "failed", written: 1, error: "No room" }))).toBe(
    "The extraction stopped after 1 of 2 files (100\u00a0B written): No room.",
  );
  expect(
    summary(
      plan({}),
      report({ outcome: "failed", written: 0, error: "No room", output: "docs.zip" }),
    ),
  ).toBe("Zipscope did not extract “docs.zip”: No room.");
  const entry = plan({ target: { kind: "entry", row: 0 }, name: "a.txt" });
  expect(summary(entry, report({ written: 1, output: "a.txt" }))).toBe(
    "Saved “a.txt”. Its size and CRC-32 verified.",
  );
  expect(
    itemCounts(
      report({
        items: [
          { row: 0, name: "a", skip: ExtractSkip.LINK },
          { row: 1, name: "b", renamed: Renamed.COLLISION, path: "b (2)" },
        ],
        more: 1,
      }),
    ),
  ).toBe("1 item skipped, 1 item renamed, 1 more item not listed.");
  // A skip of the plan is not a file of the plan. A file or a folder that
  // the job did not write is "not written", so that the counts agree with
  // the "{w} of {n} files" of the summary.
  expect(
    itemCounts(
      report({
        items: [
          { row: 0, name: "a", skip: ExtractSkip.TRAVERSAL },
          { row: 1, name: "b", skip: ExtractSkip.LOCAL_HEADER },
          { row: 2, name: "c", skip: ExtractSkip.VERIFY },
          { row: -1, name: "d/", skip: ExtractSkip.WRITE },
          { row: 3, name: "d/e", skip: ExtractSkip.WRITE },
        ],
      }),
    ),
  ).toBe("3 files and 1 folder not written, 1 item skipped.");
  expect(itemCounts(report({ items: [{ row: 0, name: "a", skip: ExtractSkip.CANCELLED }] }))).toBe(
    "1 file not written.",
  );
  expect(planNote(plan({ skipped: 2, renamed: 1 }))).toBe(
    "2 entries will be skipped and 1 item renamed. The report lists them.",
  );
  expect(planNote(plan({ skipped: 1 }))).toBe("1 entry will be skipped. The report lists it.");
});

test("a report item has one group and one reason, with no repeated clause", () => {
  const header = {
    row: 1,
    name: "a",
    skip: ExtractSkip.LOCAL_HEADER,
    detail: "The local header does not agree with the central directory",
  };
  expect(itemOutcome(header)).toBe("not-written");
  expect(itemReason(header)).toBe("The local header does not agree with the central directory");
  expect(itemText(header)).toBe(
    "Not written: the local header does not agree with the central directory",
  );
  const verify = { row: 2, name: "b", skip: ExtractSkip.VERIFY, detail: "The CRC-32 is wrong" };
  expect(itemOutcome(verify)).toBe("not-written");
  expect(itemReason(verify)).toBe("The CRC-32 is wrong");
  const deep = { row: 3, name: "c", skip: ExtractSkip.TOO_DEEP };
  expect(itemOutcome(deep)).toBe("skipped");
  expect(itemReason(deep)).toBe("The path has too many folders");
  const renamed = { row: 4, name: "d", path: "d (2)", renamed: Renamed.COLLISION };
  expect(itemOutcome(renamed)).toBe("renamed");
  expect(itemReason(renamed)).toBe("d (2) (the same name as another item when case is ignored)");
  expect(itemLead(renamed)).toBe("Renamed to ");
  expect(itemLead(verify)).toBe("Not written: the data did not verify: ");
  expect(itemLead(deep)).toBe("Skipped: ");
});

test("the title of a report names the outcome", () => {
  const plan = { name: "x.zip", files: 3 } as ExtractPlanInfo;
  const report = (outcome: ExtractReport["outcome"], written: number) =>
    ({ outcome, written, items: [], more: 0, bytes: 0 }) as unknown as ExtractReport;
  expect(reportTitle(plan, report("failed", 0))).toBe("Extraction of “x.zip” failed");
  expect(reportTitle(plan, report("complete", 0))).toBe("Extraction of “x.zip” failed");
  expect(reportTitle(plan, report("cancelled", 1))).toBe("Extraction of “x.zip” stopped");
  expect(reportTitle(plan, report("failed", 1))).toBe("Extraction of “x.zip” stopped");
  expect(reportTitle(plan, report("complete", 2))).toBe("Extracted “x.zip” in part");
  expect(reportTitle(plan, report("complete", 3))).toBe("Extracted “x.zip”");
});

test("a row with an offset that wrapped has only its reason, with no clause about a local header", () => {
  const item = { row: 1, name: "a", skip: ExtractSkip.LOCAL_HEADER, detail: WRAPPED_REASON };
  expect(itemLead(item)).toBe("Not written: ");
  expect(itemReason(item)).toBe(WRAPPED_REASON);
  expect(itemText(item)).toBe(`Not written: ${WRAPPED_REASON}`);
});
