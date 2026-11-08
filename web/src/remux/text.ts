// UI text of the zstd remux. v1 is English only.
import { ExtractSkip, WRAPPED_REASON } from "../contracts";
import type { RemuxItem, RemuxReport } from "../contracts";
import { count, decimal, formatSize, integers } from "../format";
import { LOW_SHARE } from "./hint";
import type { Hint } from "./hint";

/** The compatibility warning before a save: its lead and its body. */
export const COMPATIBILITY_LEAD = "Many unzip tools cannot open Zstandard (zstd) entries.";
export const COMPATIBILITY_BODY =
  "These include Windows Explorer and the macOS Archive Utility (compression method 93). Keep the original archive if other people or tools must open it.";
export const COMPATIBILITY_WARNING = `${COMPATIBILITY_LEAD} ${COMPATIBILITY_BODY}`;

/** What the copy does, in one line. */
export const REMUX_NOTE =
  "Zipscope recompresses each file with Zstandard and keeps names, comments, times and extra fields. Images, video and nested archives stay as they are. Entries that zstd does not make smaller keep their current compression. Each entry verifies before it goes into the copy.";

/** The suggested name of the copy: the archive name with `-zstd` before
 *  its extension. It is never the name of the archive, so a save does not
 *  replace the archive. */
export function remuxFileName(archiveName: string): string {
  const base = archiveName.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const clean = [...stem]
    .map((char) => (char.charCodeAt(0) < 32 || '<>:"|?*'.includes(char) ? "_" : char))
    .join("")
    .trim();
  return `${clean === "" ? "archive" : clean}-zstd.zip`;
}

/** The facts of the archive before the save. Without `bytes` (while the
 *  dialog counts them), only the entries. */
export function remuxFacts(rows: number, bytes?: number, leftOut = 0, wrapped = 0): string {
  const parts = [
    bytes === undefined
      ? `${count(rows, "entry", "entries")}.`
      : `${count(rows, "entry", "entries")}, ${formatSize(bytes)} uncompressed.`,
  ];
  if (leftOut > 0) {
    parts.push(
      `${count(leftOut, "entry", "entries")} ${leftOut === 1 ? "is" : "are"} encrypted or use${leftOut === 1 ? "s" : ""} a compression method that Zipscope cannot read. The copy leaves ${leftOut === 1 ? "it" : "them"} out.`,
    );
  }
  if (wrapped > 0) {
    parts.push(
      `${count(wrapped, "file")} cannot be read here. The copy leaves ${wrapped === 1 ? "it" : "them"} out.`,
    );
  }
  return parts.join(" ");
}

const SKIPS: Partial<Record<ExtractSkip, string>> = {
  [ExtractSkip.ENCRYPTED]: "Left out: encrypted",
  [ExtractSkip.METHOD]: "Left out: Zipscope cannot decode its compression method",
  [ExtractSkip.LOCAL_HEADER]:
    "Left out: the local header does not agree with the central directory",
  [ExtractSkip.VERIFY]: "Left out: the data did not verify",
  [ExtractSkip.WRITE]: "Left out: the copy cannot write it",
  [ExtractSkip.MEMORY]: "Left out: the memory limit left no room",
};

/** The text of a left-out row. */
export function remuxItemText(item: RemuxItem): string {
  if (item.detail === WRAPPED_REASON) return `Left out. ${WRAPPED_REASON}`;
  const head = SKIPS[item.skip] ?? "Left out";
  return item.detail === "" ? head : `${head}. ${item.detail}`;
}

/** A part of a whole in percent: whole numbers from 10%, one decimal
 *  below, and "less than 0.1%" for a very small part. */
export function percent(part: number): string {
  const value = Math.abs(part) * 100;
  if (value >= 10) return `${Math.round(value)}%`;
  if (value >= 0.1) return `${decimal(Math.round(value * 10) / 10)}%`;
  return `less than ${decimal(0.1)}%`;
}

/** The size of the copy against the size of the archive. The report
 *  shows this sentence in the warn tone when the copy is not smaller. */
export function against(copy: number, archive: number): string {
  if (copy === archive) return `The copy is the same size as the archive (${formatSize(archive)}).`;
  const change = copy - archive;
  const share = archive > 0 ? percent(change / archive) : "";
  return `The copy is ${formatSize(Math.abs(change))} (${share}) ${change < 0 ? "smaller" : "larger"} than the archive (${formatSize(archive)}).`;
}

/** The summary of a report. `sink` is where the copy went: the file of
 *  the save picker, whose writable is aborted on a failure or a cancel, or
 *  the streamed download, which then stops with an error. `archiveBytes`
 *  is the size of the archive file: the report compares the copy with
 *  it, not with the uncompressed size. */
export function remuxSummary(
  name: string,
  report: RemuxReport,
  sink: "file" | "stream",
  archiveBytes: number,
  outside?: number,
): string {
  return remuxSummaryParts(name, report, sink, archiveBytes, outside).join(" ");
}

/** The sentences of the summary. The report shows the first on its own
 *  line, and the others as a muted facts line. */
export function remuxSummaryParts(
  name: string,
  report: RemuxReport,
  sink: "file" | "stream",
  archiveBytes: number,
  outside?: number,
): string[] {
  if (report.outcome === "cancelled") {
    return [
      sink === "file"
        ? `Cancelled. Zipscope did not save “${name}”, and the file did not change.`
        : `Cancelled. The download of “${name}” stopped, and its partial file has no central directory.`,
    ];
  }
  if (report.outcome === "failed") {
    const after = sink === "file" ? "The file did not change." : "The download stopped.";
    return [
      `Zipscope did not save “${name}”. ${report.error ?? ""} ${after}`.replace(/\s+/g, " ").trim(),
    ];
  }
  const left = report.items.length + report.more;
  const smaller = report.output < archiveBytes;
  const verb = smaller ? "Saved" : "Wrote";
  const fact = outsideFact(outside, archiveBytes);
  const parts = [
    `${verb} “${name}”: ${count(report.written, "entry", "entries")} in ${formatSize(report.output)}.`,
    // The difference has the bytes of the rows left out, so it is not a saving.
    smaller && left > 0
      ? `The archive is ${formatSize(archiveBytes)}.`
      : against(report.output, archiveBytes),
    ...(fact === undefined ? [] : [fact]),
    report.zstd === 0
      ? "No entry got smaller with zstd."
      : `${count(report.zstd, "file")} use${report.zstd === 1 ? "s" : ""} zstd.`,
    left > 0 ? `${count(left, "entry", "entries")} left out.` : "Each entry verified.",
  ];
  return parts;
}

/** The lead of the report of a complete copy. The title names the file. */
export function remuxLead(report: RemuxReport): string {
  return `${count(report.written, "entry", "entries")} in ${formatSize(report.output)}.`;
}

/** True when the copy is at least 1% larger than the archive. A smaller
 *  difference does not change the choice of the user, so the report does not
 *  give it the weight of a band. */
export function muchLarger(report: RemuxReport, archiveBytes: number): boolean {
  return report.output - archiveBytes >= archiveBytes * 0.01;
}

/** The lead of the band of a copy that is much larger. */
export const LARGER_LEAD = "The copy is larger than the archive.";

/** True when a complete copy is not smaller than the archive. The report
 *  then needs the attention of the user. */
export function notSmaller(report: RemuxReport, archiveBytes: number): boolean {
  return report.outcome === "complete" && report.output >= archiveBytes;
}

/** The end of a low hint. The dialog shows it on a line of its own. */
export const NOT_LIKELY = "The copy is not likely to be much smaller than the archive.";

/** The end of the first sentence of the hint when the copy leaves out rows.
 *  The sums of the hint have no bytes of these rows, and such a row can be
 *  stored. It is at the end, so the percent does not read as a part of the
 *  rows that stay. */
const NOT_COUNTING = ", not counting the entries left out";

/** The sentence about the bytes outside the entries (`outsideBytes`), when
 *  they are at least `LOW_SHARE` of the archive. */
function outsideFact(outside: number | undefined, archiveBytes: number): string | undefined {
  if (outside === undefined || outside === 0 || outside < LOW_SHARE * archiveBytes) {
    return undefined;
  }
  return `${formatSize(outside)} of this archive is outside the entries. The copy does not keep those bytes.`;
}

/** The hint before the save, and true when the stored or barely
 *  compressed part is less than 5% of the archive (`LOW_SHARE`). Then
 *  Cancel gets the focus. `leftOut` is the count of rows that the dialog
 *  knows the copy leaves out. With such rows, the hint has no sentence about
 *  the size of the copy, because the bytes of these rows do not go in the copy.
 *  `outside` is `outsideBytes`, and undefined when the dialog does not have
 *  that value. The hint then also has no sentence about the size of the copy,
 *  because the bytes outside the entries do not go in the copy. */
export function remuxHintText(
  hint: Hint,
  archiveBytes: number,
  leftOut: number,
  outside: number | undefined,
): { text: string; low: boolean } {
  // A hostile central directory can claim more bytes than the file has,
  // so the shown sizes stop at the archive size.
  const loose = Math.min(hint.loose, Math.max(0, archiveBytes));
  const formats = Math.min(hint.formats, Math.max(0, archiveBytes));
  const share = archiveBytes > 0 ? loose / archiveBytes : 0;
  const low = share < LOW_SHARE;
  const leaves = leftOut > 0;
  const except = leaves ? NOT_COUNTING : "";
  const parts: string[] = [];
  if (loose > 0) {
    parts.push(
      `${low && !leaves ? "Only " : ""}${formatSize(loose)} of this archive (${percent(share)}) is stored or barely compressed${except}.`,
    );
    if (formats > 0) {
      parts.push(
        `This does not include ${formatSize(formats)} of images, video and other compressed formats. They stay as they are.`,
      );
    }
  } else if (formats > 0) {
    parts.push(
      `The stored or barely compressed entries of this archive (${formatSize(formats)}) are images, video or other compressed formats${except}. The copy keeps them as they are.`,
    );
  } else {
    parts.push(`No entry of this archive is stored or barely compressed${except}.`);
  }
  const fact = outsideFact(outside, archiveBytes);
  if (fact !== undefined) parts.push(fact);
  else if (low && !leaves && outside !== undefined) parts.push(NOT_LIKELY);
  return { text: parts.join(" "), low };
}

/** The detail line of the progress. Before the dialog counted the bytes
 *  of the rows (`total` 0), it gives the bytes with no total. */
export function remuxProgressText(progress: {
  bytes: number;
  total: number;
  rows: number;
  totalRows: number;
  workers: number;
}): string {
  const bytes =
    progress.total > 0
      ? `${formatSize(progress.bytes)} of ${formatSize(progress.total)}`
      : formatSize(progress.bytes);
  const pool = progress.workers > 0 ? ` · ${count(progress.workers, "worker")}` : "";
  return `${bytes} · ${integers.format(progress.rows)} of ${count(progress.totalRows, "entry", "entries")}${pool}`;
}

/** The report as tab-separated text, for "Copy report". */
export function remuxTsv(report: RemuxReport, name: (row: number) => string): string {
  return report.items.map((item) => `${name(item.row)}\t${remuxItemText(item)}`).join("\n");
}
