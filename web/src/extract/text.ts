// UI text of the extraction. v1 is English only.
import { ExtractSkip, Renamed, WRAPPED_REASON } from "../contracts";
import type { ExtractItem, ExtractPlanInfo, ExtractReport } from "../contracts";
import { count, formatSize, integers } from "../format";
import { nameLabel } from "../label";

/** The safeguard of a confirmation: the verifying reader stops a file
 *  whose data is longer than its declared size. */
export const SAFEGUARD = "Zipscope stops a file when its data is longer than its declared size.";

/** The risks that need confirmation before an extraction, or an empty
 *  list. The first line is the lead of the band: it names the danger. The
 *  others are its body. A declared size over 1 GiB needs confirmation, and so
 *  does a file of at least 16 MiB with a ratio above 100× (`isBombLike`).
 *  Zipscope reads only the declared sizes, so it says that a file looks like
 *  a zip bomb, not that it is one. The dialog shows `SAFEGUARD` after the
 *  risks. */
export function warnings(plan: ExtractPlanInfo): string[] {
  const entry = plan.target.kind === "entry";
  const body: string[] = [];
  if (plan.bombs > 0) {
    body.push(
      entry
        ? "It is more than 100 times larger than its compressed data."
        : `${plan.bombs === 1 ? "It is" : "They are"} more than 100 times larger than ${plan.bombs === 1 ? "its" : "their"} compressed data.`,
    );
  }
  let large = "";
  if (plan.large > 0) {
    large = entry
      ? `This entry claims ${formatSize(plan.largest)}, more than 1\u00a0GiB.`
      : `${count(plan.large, "file")} claim${plan.large === 1 ? "s" : ""} more than 1\u00a0GiB each (the largest claims ${formatSize(plan.largest)}).`;
  } else if (!entry && plan.bytes > 2 ** 30) {
    large = `The files claim ${formatSize(plan.bytes)} in total, more than 1\u00a0GiB.`;
  }
  if (plan.bombs === 0 && large === "") return [];
  const lead =
    plan.bombs > 0
      ? entry
        ? "This entry looks like a zip bomb."
        : `${count(plan.bombs, "file")} look${plan.bombs === 1 ? "s" : ""} like a zip bomb.`
      : large;
  if (plan.bombs > 0 && large !== "") body.push(large);
  body.push("An extraction can write all of the declared bytes.");
  return [lead, ...body];
}

/** True when the plan needs confirmation. */
export function needsConfirmation(plan: ExtractPlanInfo): boolean {
  return warnings(plan).length > 0;
}

const SKIPS: Record<ExtractSkip, string> = {
  [ExtractSkip.TRAVERSAL]: "Skipped: the path has a “..” segment",
  [ExtractSkip.ABSOLUTE]: "Skipped: the path is absolute",
  [ExtractSkip.DRIVE_LETTER]: "Skipped: the path has a drive letter",
  [ExtractSkip.NUL]: "Skipped: the name has a NUL character",
  [ExtractSkip.LINK]: "Skipped: a symbolic link",
  [ExtractSkip.TOO_LONG]: "Skipped: the path is too long",
  [ExtractSkip.TOO_DEEP]: "Skipped: the path has too many folders",
  [ExtractSkip.NO_NAME]: "Skipped: no file name",
  [ExtractSkip.ENCRYPTED]: "Skipped: encrypted",
  [ExtractSkip.METHOD]: "Skipped: Zipscope cannot decode its compression method",
  [ExtractSkip.LOCAL_HEADER]:
    "Not written: the local header does not agree with the central directory",
  [ExtractSkip.VERIFY]: "Not written: the data did not verify",
  [ExtractSkip.WRITE]: "Not written: the browser did not write it",
  [ExtractSkip.MEMORY]: "Not written: the memory limit left no room",
  [ExtractSkip.CANCELLED]: "Not written: cancelled",
};

const RENAMES: [number, string][] = [
  [Renamed.RESERVED, "a Windows reserved name"],
  [Renamed.CHARACTERS, "characters that a file system does not accept or that do not show"],
  [Renamed.TRAILING, "a dot or a space at the end"],
  [Renamed.TRUNCATED, "the name is too long"],
  [Renamed.COLLISION, "the same name as another item when case is ignored"],
];

/** The status of one report item: `renamed` (written under another
 *  name), `skipped` (not tried: the plan or the local header refused it)
 *  or `failed` (tried, but it did not verify or did not write). */
export function itemStatus(item: ExtractItem): "renamed" | "skipped" | "failed" {
  if (item.skip === undefined) return "renamed";
  return item.skip === ExtractSkip.VERIFY ||
    item.skip === ExtractSkip.WRITE ||
    item.skip === ExtractSkip.MEMORY ||
    item.skip === ExtractSkip.CANCELLED
    ? "failed"
    : "skipped";
}

/** The groups of the report, the most severe first. */
export type ItemOutcome = "not-written" | "skipped" | "renamed";
export const OUTCOMES: readonly { key: ItemOutcome; label: string }[] = [
  { key: "not-written", label: "Not written" },
  { key: "skipped", label: "Skipped" },
  { key: "renamed", label: "Renamed" },
];

/** The group of one report item. A local header that does not agree is a
 *  file of the plan that the job did not write, as a file that did not
 *  verify, so the two have one style. */
export function itemOutcome(item: ExtractItem): ItemOutcome {
  if (item.skip === undefined) return "renamed";
  return planSkip(item.skip) ? "skipped" : "not-written";
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The clause of a skip after its verb: "the data did not verify". */
const skipClause = (skip: ExtractSkip) => {
  const text = SKIPS[skip] ?? "";
  return text.slice(text.indexOf(": ") + 2);
};

/** The reason of one report item, with no verb: its group gives the verb.
 *  The detail of the worker is more exact than the clause of the skip, so
 *  it takes its place. */
export function itemReason(item: ExtractItem): string {
  if (item.skip === undefined) {
    return `${nameLabel(item.path ?? "")} (${renameReasons(item).join("; ")})`;
  }
  return capitalize(item.detail ?? skipClause(item.skip));
}

/** The words before the reason of one report item. They are visually
 *  hidden: a row gives its whole sentence to a screen reader. */
export function itemLead(item: ExtractItem): string {
  if (item.skip === undefined) return "Renamed to ";
  const text = SKIPS[item.skip] ?? "Skipped";
  // No code compared the local header of a row with `WRAPPED_REASON`.
  return item.detail === undefined ||
    item.detail === WRAPPED_REASON ||
    item.detail.toLowerCase() === skipClause(item.skip).toLowerCase()
    ? `${text.slice(0, text.indexOf(": ") + 2)}`
    : `${text}: `;
}

function renameReasons(item: ExtractItem): string[] {
  return RENAMES.filter(([bit]) => ((item.renamed ?? 0) & bit) !== 0).map(([, text]) => text);
}

/** The result of one report item. */
export function itemText(item: ExtractItem): string {
  if (item.skip !== undefined) {
    if (item.detail === WRAPPED_REASON) return `${itemLead(item)}${item.detail}`;
    const text = SKIPS[item.skip] ?? "Skipped";
    // The detail can tell the same as the clause: no second time.
    return item.detail === undefined ||
      item.detail.toLowerCase() === skipClause(item.skip).toLowerCase()
      ? text
      : `${text}: ${item.detail}`;
  }
  return `Renamed to ${item.path ?? ""} (${renameReasons(item).join("; ")})`;
}

/** The report as tab-separated lines: name, result. */
export function reportTsv(report: ExtractReport): string {
  const clean = (text: string) => text.replace(/[\t\r\n]/g, " ");
  const lines = report.items.map((item) => `${clean(item.name)}\t${clean(itemText(item))}`);
  if (report.more > 0) lines.push(`… and ${report.more} more\t`);
  return lines.join("\n");
}

/** The title of a report: it names the outcome. */
export function reportTitle(plan: ExtractPlanInfo, report: ExtractReport): string {
  const output = nameLabel(report.output ?? plan.name);
  if (report.outcome === "cancelled") return `Extraction of “${output}” stopped`;
  if (report.written === 0 && (report.outcome === "failed" || plan.files > 0)) {
    return `Extraction of “${output}” failed`;
  }
  if (report.outcome === "failed") return `Extraction of “${output}” stopped`;
  return report.written < plan.files ? `Extracted “${output}” in part` : `Extracted “${output}”`;
}

/** The first line of a report. */
export function summary(plan: ExtractPlanInfo, report: ExtractReport): string {
  const output = nameLabel(report.output ?? plan.name);
  if (report.outcome === "failed" && report.written === 0) {
    return `Zipscope did not extract “${output}”: ${report.error ?? "an error stopped it"}.`;
  }
  if (plan.target.kind === "entry") {
    return report.outcome === "cancelled"
      ? "The extraction stopped. The file is not complete."
      : `Saved “${output}”. Its size and CRC-32 verified.`;
  }
  // The part of the whole comes from the counts of the job, not from the
  // items, so it stays true when the report does not list all items.
  // The size is the size of the written files, not of the plan.
  const part = `${integers.format(report.written)} of ${count(plan.files, "file")} (${formatSize(report.bytes)} written)`;
  if (report.outcome === "cancelled") return `The extraction stopped after ${part}.`;
  if (report.outcome === "failed") {
    return `The extraction stopped after ${part}: ${report.error ?? "an error"}.`;
  }
  if (report.written === 0) return `Zipscope wrote no files to “${output}”.`;
  const verified =
    report.written < plan.files ? "Each written file verified." : "Each file verified.";
  return `Extracted ${part} to “${output}”. ${verified}`;
}

/** True for a skip of the plan (a path, a link, a method): the row is
 *  not a file of the plan, so the summary does not count it. The other
 *  skips are files or folders of the plan that the job did not write. */
const planSkip = (skip: ExtractSkip) => skip <= ExtractSkip.METHOD;

/** The counts of the report items, or undefined when there are none.
 *  "Skipped" counts the items that the plan skipped, and "not written"
 *  counts the files and folders of the plan that the job did not write.
 *  Thus, when the report lists all items, the files that are not written
 *  and the written files of the summary give the files of the plan. */
export function itemCounts(report: ExtractReport): string | undefined {
  const all = report.items.length + report.more;
  if (all === 0) return undefined;
  let renamed = 0;
  let skipped = 0;
  let files = 0;
  let folders = 0;
  for (const item of report.items) {
    if (item.skip === undefined) renamed++;
    else if (planSkip(item.skip)) skipped++;
    else if (item.row < 0) folders++;
    else files++;
  }
  // The most severe count first.
  const parts: string[] = [];
  const failed = [
    files > 0 ? count(files, "file") : "",
    folders > 0 ? count(folders, "folder") : "",
  ];
  if (files + folders > 0)
    parts.push(`${failed.filter((part) => part !== "").join(" and ")} not written`);
  if (skipped > 0) parts.push(`${count(skipped, "item")} skipped`);
  if (renamed > 0) parts.push(`${count(renamed, "item")} renamed`);
  if (report.more > 0) parts.push(`${count(report.more, "more item")} not listed`);
  return `${parts.join(", ")}.`;
}

/** What the plan has, for the confirmation. */
export function planFacts(plan: ExtractPlanInfo): string {
  if (plan.target.kind === "entry") {
    return `${formatSize(plan.bytes)}, ${formatSize(plan.compressed)} compressed.`;
  }
  const folders = plan.folders > 0 ? ` in ${count(plan.folders, "folder")}` : "";
  return `${count(plan.files, "file")}${folders}, ${formatSize(plan.bytes)} (${formatSize(plan.compressed)} compressed).`;
}

/** The note about skipped and renamed items before the extraction. */
export function planNote(plan: ExtractPlanInfo): string | undefined {
  const parts: string[] = [];
  if (plan.skipped > 0) parts.push(`${count(plan.skipped, "entry", "entries")} will be skipped`);
  if (plan.renamed > 0) parts.push(`${count(plan.renamed, "item")} renamed`);
  if (parts.length === 0) return undefined;
  const one = plan.skipped + plan.renamed === 1;
  return `${parts.join(" and ")}. The report lists ${one ? "it" : "them"}.`;
}
