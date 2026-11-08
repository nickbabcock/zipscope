// The findings of the health panel, made from the health report. All UI
// strings of the health panel are in this module.
import type { HealthReport, ParseOutcome, RefusedView, RowFinding } from "../contracts";
import { count, formatSize, hexOffset, integers } from "../format";
import { MARK } from "../label";

export type Severity = "error" | "warning" | "notice";

export interface Finding {
  /** A stable id, for tests and for the DOM. */
  id: string;
  severity: Severity;
  /** One sentence. */
  text: string;
  /** A row that shows the finding, or -1. */
  example: number;
}

/** The id of the finding of the offsets that wrapped at 4 GiB. */
export const WRAPPED_FINDING = "wrapped-offsets";

/** The ids of the two findings of `marks` bit 3. An overlap of two rows with
 *  data can give more output than the file has. The other overlap has a row that
 *  gives no output. */
export const OVERLAP_FINDING = "overlaps";
export const OVERLAP_NO_DATA_FINDING = "overlap-no-data";

/** The ids of the findings of the walk to the end record. */
export const END_OTHERS_FINDING = "other-end-records";
export const END_SKIPPED_FINDING = "false-end-marks";
export const COMMENT_CUT_FINDING = "comment-cut";
export const DECLARED_AFTER_FINDING = "declared-after-directory";
export const EARLIER_FINDING = "earlier-end-records";

/** The id of the finding at the soft memory budget. */
export const BUDGET_FINDING = "memory-budget";

/** The folder limit of `crates/core/src/tree.rs` (`MAX_FOLDERS`). */
export const MAX_FOLDERS = 4_194_304;

const ORDER: Record<Severity, number> = { error: 0, warning: 1, notice: 2 };

/** What the memory limit refused. The table keeps the listing before it. */
const REFUSED: Record<RefusedView, string> = {
  sort: "The sort could not run",
  search: "The search could not run",
  folder: "The folder could not change",
};

/** The text that a screen reader speaks when the memory limit refused a
 *  view request. It is the start of the memory-limit finding. */
export function refusedText(kind: RefusedView, hardBytes: number): string {
  return `${REFUSED[kind]} at the ${formatSize(hardBytes)} memory limit.`;
}

/** The id of the sentence of the health strip after the hard stop. The
 *  controls that are off name it with `aria-describedby`, so a screen
 *  reader gives the reason on each of them. */
export const STOPPED_ID = "health-stopped";

/** The texts after the hard stop, when the worker refuses each view
 *  request. The controls are off and have no tooltip: the health strip
 *  says once why. */
export const STOPPED = {
  /** The sentence of the health strip. */
  controls: "Search, sort and folder changes are off.",
  /** The next step, after that sentence. */
  next: "Open another file to start again.",
  /** The placeholder of the search field. It fits a narrow field whole,
   *  and the strip says why. */
  search: "Search off",
  /** The reason of "Show in tree" in the row menu. */
  folders: "Folders stopped at the memory limit",
} as const;

function rows(
  finding: RowFinding,
  id: string,
  severity: Severity,
  text: (rows: string) => string,
): Finding[] {
  if (finding.rows === 0) {
    return [];
  }
  return [
    {
      id,
      severity,
      text: text(count(finding.rows, "entry", "entries")),
      example: finding.example,
    },
  ];
}

/** The text when the memory limit left no room for the last merge. */
export const ROWS_MISSING = "Some entries that were read are not in this listing.";

/** The findings of the walk to the end record. The rule is in
 *  `crates/layout/src/end.rs`. */
function endRecordFindings(report: HealthReport): Finding[] {
  const {
    commentDeclared,
    commentPresent,
    skipped,
    others,
    unchecked,
    secondDirectory,
    declaredDirectory,
    foundDirectory,
    earlierRecords,
    earlierRecord,
    earlierDirectory,
  } = report.endRecord;
  const list: Finding[] = [];
  // A warning, as when the declared count is false: two values of the file do
  // not agree, and data before an archive cannot be the reason. Data before an
  // archive puts the declared offset before the directory.
  if (declaredDirectory > 0) {
    const difference = declaredDirectory - foundDirectory;
    list.push({
      id: DECLARED_AFTER_FINDING,
      severity: "warning",
      text: `The end record declares the central directory at ${hexOffset(declaredDirectory)}, but the central directory is at ${hexOffset(foundDirectory)}, ${count(difference, "byte", "bytes")} before that place.`,
      example: -1,
    });
  }
  // A warning: the file can have more than one central directory, and the listing
  // shows one. The bytes do not tell which directory the writer meant. It is not
  // an error, because the listing is true for the directory that it shows.
  if (others > 0 || unchecked > 0 || secondDirectory) {
    const parts: string[] = [];
    if (secondDirectory) {
      parts.push("The end record of this file also points to a second central directory.");
    }
    if (others > 0) {
      parts.push(
        `This file has ${count(others, "other end record", "other end records")} that ${others === 1 ? "points" : "point"} to another central directory.`,
      );
    }
    if (unchecked > 0) {
      parts.push(
        `Zipscope did not check ${count(unchecked, "other possible end record", "other possible end records")} in this file.`,
      );
    }
    parts.push("This listing shows the entries of one central directory.");
    list.push({ id: END_OTHERS_FINDING, severity: "warning", text: parts.join(" "), example: -1 });
  }
  // Notices: the entries and their data do not change.
  // An update that adds a new directory after the old directory and a file with
  // a hidden archive can have the same bytes, so the text only tells what is
  // there, and the severity is the one that is true for both.
  if (earlierRecords > 0) {
    // "At least": the check keeps a limited number of records, and it sees only
    // the bytes near the chosen record. "By the sizes": the parse does not read the
    // local headers, and the byte map does.
    const places =
      earlierRecords === 1
        ? `another end record at ${hexOffset(earlierRecord)}, with a central directory at ${hexOffset(earlierDirectory)}.`
        : `at least ${integers.format(earlierRecords)} other end records with a central directory. The nearest is at ${hexOffset(earlierRecord)}, with its central directory at ${hexOffset(earlierDirectory)}.`;
    list.push({
      id: EARLIER_FINDING,
      severity: "notice",
      text: `Before the end record of this listing, this file has ${places} By the sizes in the central directory, no entry covers that end record.`,
      example: -1,
    });
  }
  if (skipped > 0) {
    list.push({
      id: END_SKIPPED_FINDING,
      severity: "notice",
      text: `This file has ${count(skipped, "end record mark", "end record marks")} after the start of the end record of this listing. ${skipped === 1 ? "It points" : "They point"} to no other central directory.`,
      example: -1,
    });
  }
  if (commentDeclared > 0) {
    list.push({
      id: COMMENT_CUT_FINDING,
      severity: "notice",
      text: `The file ends inside the archive comment: ${formatSize(commentPresent)} of ${formatSize(commentDeclared)} ${commentPresent === 1 ? "is" : "are"} there. The file can be cut off at its end.`,
      example: -1,
    });
  }
  return list;
}

/** Returns the findings of a report, the most severe first. `outcome` is
 *  the end of parsing, if it ended. */
export function findings(report: HealthReport, outcome?: ParseOutcome): Finding[] {
  const list: Finding[] = [];
  const listed = count(report.rows, "entry", "entries");
  if (report.error !== undefined) {
    list.push({
      id: "parse-error",
      severity: "error",
      text: `Parsing stopped after ${listed}: ${report.error}. The listing keeps the entries before the error.`,
      example: -1,
    });
  }
  const budget = report.budget;
  if (budget.hardReached) {
    const limit = formatSize(budget.limits.hard);
    // Parsing stopped at the limit unless it completed or another error
    // stopped it first.
    const parseStopped = outcome?.kind !== "complete" && report.error === undefined;
    // A refused request comes first: the narrow strip shows only the start
    // of the text.
    const text =
      budget.refused === undefined
        ? parseStopped
          ? `Parsing stopped at the ${limit} memory limit after ${listed}. The listing is partial.`
          : `Store memory reached the ${limit} limit.`
        : `${REFUSED[budget.refused]} at the ${limit} memory limit.${parseStopped ? ` Parsing stopped after ${listed}. The listing is partial.` : ""}`;
    list.push({
      id: "memory-limit",
      severity: "error",
      text: budget.rowsMissing ? `${text} ${ROWS_MISSING}` : text,
      example: -1,
    });
  } else if (budget.declined) {
    list.push({
      id: BUDGET_FINDING,
      severity: "warning",
      text: `Parsing stopped at the ${formatSize(budget.limits.soft)} memory budget after ${listed}. The listing is partial.`,
      example: -1,
    });
  } else if (budget.softReached) {
    list.push({
      id: BUDGET_FINDING,
      severity: "notice",
      text:
        outcome?.kind === "complete"
          ? `Store memory passed the ${formatSize(budget.limits.soft)} budget. Parsing continued when you chose to.`
          : `Store memory reached the ${formatSize(budget.limits.soft)} budget.`,
      example: -1,
    });
  }
  if (report.countMismatch) {
    list.push({
      id: "count-mismatch",
      severity: "warning",
      text: `The archive declares ${count(report.declaredEntries, "entry", "entries")}, but its central directory has ${listed}.`,
      example: -1,
    });
  }
  // A notice: the two values differ, and the listing is complete. A hostile
  // file can have this shape too, so the text says only what the two values are.
  if (report.countWrapped) {
    list.push({
      id: "count-wrapped",
      severity: "notice",
      text: `The end record declares ${count(report.declaredEntries, "entry", "entries")}, and the central directory has ${listed}. With no Zip64, the count has only 16 bits, and the two values agree in 16 bits.`,
      example: -1,
    });
  }
  // A zip bomb is an error, not a warning: it can fill the disk. Names,
  // paths and counts stay warnings.
  list.push(
    ...rows(report.overlapData, OVERLAP_FINDING, "error", (n) =>
      report.overlapData.rows === 1
        ? `${n} has bytes that overlap another entry. An overlapping-file zip bomb has this shape.`
        : `${n} have bytes that overlap other entries. An overlapping-file zip bomb has this shape.`,
    ),
    // A warning, not an error: a row with no data gives no output, so this
    // overlap cannot fill the disk. A row that declares a large size with no data
    // has its own error. With rows of the error too, the first marked row can be
    // one of them, so this finding has no example.
    ...rows(
      {
        rows: report.overlaps.rows - report.overlapData.rows,
        example: report.overlapData.rows === 0 ? report.overlaps.example : -1,
      },
      OVERLAP_NO_DATA_FINDING,
      "warning",
      (n) =>
        report.overlaps.rows - report.overlapData.rows === 1
          ? `${n} is at a place that overlaps another entry. The overlap has an entry with no data.`
          : `${n} are at places that overlap other entries. Each overlap has an entry with no data.`,
    ),
    ...rows(report.bombs, "bomb-ratio", "error", (n) =>
      report.bombs.rows === 1
        ? `${n} declares more than 100 times its compressed size (bomb-like).`
        : `${n} declare more than 100 times their compressed size (bomb-like).`,
    ),
    // A warning, not an error: the size is false or the data holds the
    // directory, but this cannot fill the disk, as a zip bomb can.
    ...rows(report.intoDirectory, "into-directory", "warning", (n) =>
      report.intoDirectory.rows === 1
        ? `${n} has bytes that run into the central directory.`
        : `${n} have bytes that run into the central directory.`,
    ),
    // A warning, not an error: the archive does no harm, and the listing and
    // the sizes are true. Only these rows fail, and each says why.
    ...rows(
      report.wrapped,
      WRAPPED_FINDING,
      "warning",
      (n) =>
        `This archive is over 4 GiB and was written without Zip64, the format that large archives need. ${n} cannot be read here.`,
    ),
    ...rows(report.duplicates, "duplicate-names", "warning", (n) =>
      report.duplicates.rows === 1
        ? `${n} has the same name as another entry.`
        : `${n} share a name with another entry.`,
    ),
    ...rows(
      report.depthCap,
      "depth-cap",
      "warning",
      (n) =>
        `${n} ${report.depthCap.rows === 1 ? "has a path" : "have paths"} deeper than 256 folders. The deeper folders show as one name.`,
    ),
    ...rows(
      report.folderCap,
      "folder-cap",
      "warning",
      (n) =>
        `The folder limit of ${integers.format(MAX_FOLDERS)} was reached. ${n} ${report.folderCap.rows === 1 ? "shows" : "show"} in the deepest folder that exists.`,
    ),
    ...rows(
      report.controlNames,
      "control-names",
      "warning",
      (n) =>
        `${n} ${report.controlNames.rows === 1 ? "has a name" : "have names"} with hidden or control characters, which show as marks such as ${MARK}. Search and copy use the true name.`,
    ),
  );
  list.push(...endRecordFindings(report));
  if (report.preludeBytes > 0) {
    list.push({
      id: "prelude",
      severity: "notice",
      text: `${formatSize(report.preludeBytes)} of data is before the first entry.`,
      example: -1,
    });
  }
  if (report.epilogueBytes > 0) {
    list.push({
      id: "epilogue",
      severity: "notice",
      text: `${formatSize(report.epilogueBytes)} of data is after the end of the archive.`,
      example: -1,
    });
  }
  const encrypted = report.encrypted;
  const kinds: [number, string][] = [
    [encrypted.zipCrypto, "ZipCrypto"],
    [encrypted.aes128, "AES-128"],
    [encrypted.aes192, "AES-192"],
    [encrypted.aes256, "AES-256"],
    [encrypted.aesUnknown, "AES (strength not known)"],
    [encrypted.other, "strong encryption"],
  ];
  const parts = kinds.filter(([n]) => n > 0).map(([n, name]) => `${integers.format(n)} ${name}`);
  if (parts.length > 0) {
    const total = kinds.reduce((sum, [n]) => sum + n, 0);
    list.push({
      id: "encrypted",
      severity: "notice",
      text: `${count(total, "entry is", "entries are")} encrypted: ${parts.join(", ")}.`,
      example: -1,
    });
  }
  if (outcome?.kind === "cancelled" && !budget.declined) {
    list.push({
      id: "cancelled",
      severity: "notice",
      text: `Parsing was cancelled after ${listed}. The listing is partial.`,
      example: -1,
    });
  }
  return list.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

/** The count of the findings by severity, the most severe first: "2 errors,
 *  3 warnings, 3 notices". The strip shows it while the list is open. */
export function severityCounts(list: readonly Finding[]): string {
  const of = (severity: Severity) => list.filter((item) => item.severity === severity).length;
  const parts = [
    [of("error"), "error", "errors"],
    [of("warning"), "warning", "warnings"],
    [of("notice"), "notice", "notices"],
  ] as const;
  return parts
    .filter(([value]) => value > 0)
    .map(([value, one, many]) => count(value, one, many))
    .join(", ");
}

/** The question at the end of the prompt. The strip shows it at weight 600. */
export const BUDGET_QUESTION = "Continue?";

/** The prompt at the soft memory budget: the state, then the question. */
export function budgetPrompt(rows: number, storeBytes: number): string {
  return `Paused: ${count(rows, "entry", "entries")} listed using ${formatSize(storeBytes)} so far. ${BUDGET_QUESTION}`;
}

export interface BudgetPause {
  rows: number;
  storeBytes: number;
  text: string;
}

/** Returns the finding for local headers that disagree with the central
 *  directory. The read worker finds them at preview time, so the finding
 *  lists only the entries that were previewed. */
export function localHeaderFindings(rows: ReadonlyMap<number, number>): Finding[] {
  let example = -1;
  for (const [row, mismatches] of rows) {
    if (mismatches !== 0) {
      example = row;
      break;
    }
  }
  if (example < 0) {
    return [];
  }
  const found = [...rows.values()].filter((mismatches) => mismatches !== 0).length;
  return [
    {
      id: "local-header",
      severity: "warning",
      text: `${count(found, "previewed entry has", "previewed entries have")} a local header that does not agree with the central directory.`,
      example,
    },
  ];
}

/** Returns the finding for previewed entries whose data does not agree
 *  with its CRC-32. The read worker finds them when the
 *  data ends, so the finding lists only the entries that were previewed
 *  to their end. */
export function crcFindings(rows: ReadonlySet<number>): Finding[] {
  const [example] = rows;
  if (example === undefined) return [];
  return [
    {
      id: "crc-failure",
      severity: "warning",
      text: `${count(rows.size, "previewed entry has", "previewed entries have")} data that does not agree with its CRC-32.`,
      example,
    },
  ];
}

/** Removes the finding of the soft budget while the memory prompt shows:
 *  the prompt tells the same. */
export function withoutBudgetNotice(list: readonly Finding[], paused: boolean): Finding[] {
  return paused ? list.filter((finding) => finding.id !== BUDGET_FINDING) : [...list];
}

/** Puts more findings into a list, the most severe first. */
export function mergeFindings(list: readonly Finding[], more: readonly Finding[]): Finding[] {
  return [...list, ...more].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}
