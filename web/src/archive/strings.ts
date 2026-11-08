// The UI strings of the Archive panel, and the pure helpers
// that make them. v1 is English only; all panel text is in this module, so
// that a later change can translate it.
import { RegionKind, RegionLabel, Zip64Use } from "../contracts";
import type { ArchiveFacts, ArchiveRegion, Breakdown, LayoutCounts } from "../contracts";
import { count, encryptionName, formatSize, hexOffset, integers, methodName } from "../format";

export { hexOffset };

/** Formats a count, with "about" when it is not exact in f64. */
export function aboutCount(value: number): string {
  const text = integers.format(value);
  return Number.isSafeInteger(value) ? text : `about ${text}`;
}

function plural(value: number, one: string, many: string): string {
  return `${aboutCount(value)} ${value === 1 ? one : many}`;
}

/** The name of a region kind. */
export const KIND_NAMES: Record<RegionKind, string> = {
  [RegionKind.PRELUDE]: "Prelude",
  [RegionKind.ENTRIES]: "Entry data",
  [RegionKind.GAP]: "Gap",
  [RegionKind.DIRECTORY]: "Central directory",
  [RegionKind.ZIP64_RECORD]: "Zip64 end record",
  [RegionKind.ZIP64_LOCATOR]: "Zip64 locator",
  [RegionKind.END_RECORD]: "End record",
  [RegionKind.EPILOGUE]: "Epilogue",
};

/** What the sniffer found, as a short phrase. */
export const LABEL_NAMES: Record<RegionLabel, string> = {
  [RegionLabel.NONE]: "",
  [RegionLabel.WINDOWS_PROGRAM]: "Windows program: a self-extractor stub",
  [RegionLabel.LINUX_PROGRAM]: "Linux program: a self-extractor stub",
  [RegionLabel.MAC_PROGRAM]: "macOS program: a self-extractor stub",
  [RegionLabel.SHELL_SCRIPT]: "Shell script prefix",
  [RegionLabel.APK_SIGNING_BLOCK]: "APK signing block",
  [RegionLabel.ZEROS]: "Zero bytes",
  [RegionLabel.LOCAL_HEADER]: "A local header that no entry lists",
  [RegionLabel.DIRECTORY_RECORD]: "A central-directory record",
  [RegionLabel.END_RECORD]: "An end record, as of another archive",
};

/** True for the regions that the panel can show in hex and save: the
 *  bytes that no part of the archive accounts for. */
export function unaccounted(kind: RegionKind): boolean {
  return kind === RegionKind.PRELUDE || kind === RegionKind.GAP || kind === RegionKind.EPILOGUE;
}

/** The name of a region in its row of the region list. */
export function regionName(region: ArchiveRegion): string {
  const name = KIND_NAMES[region.kind] ?? `Region ${region.kind}`;
  if (region.kind === RegionKind.END_RECORD && region.end - region.start > 22) {
    return `${name} and comment`;
  }
  return name;
}

/** The second line of a region row, or "". */
export function regionNote(region: ArchiveRegion): string {
  const label = LABEL_NAMES[region.label] ?? "";
  if (region.foldedGaps > 0) {
    const gaps = plural(region.foldedGaps, "small gap", "small gaps");
    return `Has ${gaps} (${formatSize(region.foldedBytes)}) that the list does not show one by one`;
  }
  return label;
}

/** The file name for a saved region. */
export function regionFileName(archive: string, region: ArchiveRegion): string {
  const base = archive.replace(/\.[^./\\]*$/, "") || "archive";
  const kind =
    region.kind === RegionKind.PRELUDE
      ? "prelude"
      : region.kind === RegionKind.EPILOGUE
        ? "epilogue"
        : `gap-${region.start.toString(16)}`;
  return `${base}.${kind}.bin`;
}

/** Notes about the rows of the byte map, the most important first. */
export function layoutNotes(counts: LayoutCounts, partial: boolean): string[] {
  const notes: string[] = [];
  if (partial) {
    notes.push(
      "The listing is partial, so the data of the entries that are not listed shows as gaps.",
    );
  }
  if (counts.badHeaders > 0) {
    notes.push(
      `${plural(counts.badHeaders, "entry has", "entries have")} no local header at the offset that the central directory gives. The map counts no bytes for them.`,
    );
  }
  if (counts.pastDirectory > 0) {
    notes.push(
      `${plural(counts.pastDirectory, "entry points", "entries point")} into or past the central directory. The map counts no bytes for them.`,
    );
  }
  if (counts.intoDirectory > 0) {
    notes.push(
      `The data of ${plural(counts.intoDirectory, "entry runs", "entries run")} into the central directory. The map cuts it there.`,
    );
  }
  if (counts.overlapping > 0) {
    notes.push(
      `${plural(counts.overlapping, "entry starts", "entries start")} inside the bytes of an earlier entry.`,
    );
  }
  if (counts.missingDescriptors > 0) {
    notes.push(
      `${plural(counts.missingDescriptors, "entry has", "entries have")} the data descriptor flag, but no descriptor after the data.`,
    );
  }
  return notes;
}

/** True when the byte map has something to show: a prelude, a gap, an
 *  epilogue, or an entry that overlaps another. Else the bar is almost
 *  one color, and the panel gives one sentence. */
export function unusualLayout(regions: readonly ArchiveRegion[], counts: LayoutCounts): boolean {
  return (
    counts.overlapping > 0 || counts.gaps > 0 || regions.some((region) => unaccounted(region.kind))
  );
}

/** The sentence in place of the bar and the region list. The map has no bytes
 *  for a row with no local header, so the health list can have an overlap that
 *  the map does not show. Then the sentence says nothing about overlaps. */
export function plainLayout(size: number, overlapFinding = false): string {
  return `Each byte of the ${formatSize(size)} file is entry data, the central directory or an end record. There is no prelude, gap or epilogue${overlapFinding ? "" : ", and no entry overlaps another"}.`;
}

/** The sentence above the region list. */
export function layoutSummary(size: number, counts: LayoutCounts): string {
  const gaps =
    counts.gaps === 0
      ? "There are no gaps between entries."
      : `${plural(counts.gaps, "gap", "gaps")} ${counts.gaps === 1 ? "holds" : "hold"} ${formatSize(counts.gapBytes)}.`;
  return `Each byte of the ${formatSize(size)} file is in one region. ${gaps}`;
}

/** Creating systems: the high byte of "version made by" (APPNOTE 4.4.2). */
const SYSTEMS: Record<number, string> = {
  0: "MS-DOS (FAT)",
  1: "Amiga",
  2: "OpenVMS",
  3: "Unix",
  4: "VM/CMS",
  5: "Atari ST",
  6: "OS/2 (HPFS)",
  7: "Macintosh",
  8: "Z-System",
  9: "CP/M",
  10: "Windows (NTFS)",
  11: "MVS",
  12: "VSE",
  13: "Acorn RISC OS",
  14: "VFAT",
  15: "Alternate MVS",
  16: "BeOS",
  17: "Tandem",
  18: "OS/400",
  19: "macOS (Darwin)",
};

export function systemName(system: number): string {
  return SYSTEMS[system] ?? `System ${system}`;
}

export { methodName };

/** The name of an encryption kind (low 7 bits). */
export function encryptionLabel(kind: number): string {
  return encryptionName(kind) ?? "None";
}

/** One fact of the Format section: a term, a value, and a level when the
 *  fact is a problem. */
export interface Fact {
  id: string;
  term: string;
  value: string;
  level?: "warning" | "error";
}

/** How far the listing came: still parsing, complete, or stopped before
 *  the end of the central directory. */
export type ListingStatus = "parsing" | "complete" | "partial";

/** Returns a value of a fact with no period at its end, when it is one sentence:
 *  a value in a grid is not a sentence. A value of more sentences keeps them. */
export function factText(value: string): string {
  return value.endsWith(".") && !value.slice(0, -1).includes(". ") ? value.slice(0, -1) : value;
}

/** The Format section of the panel. `rows` is the count of listed rows. */
export function formatFacts(
  facts: ArchiveFacts,
  rows: number,
  listing: ListingStatus,
  otherDiskRows = 0,
  zip64Rows = 0,
  more: readonly Fact[] = [],
): Fact[] {
  const list: Fact[] = [];
  const end = facts.endRecord;
  if (facts.zip64 === Zip64Use.USED && facts.record !== undefined) {
    const markers = end.totalEntries === 0xffff || end.directoryOffset === 0xffffffff;
    list.push({
      id: "zip64",
      term: "Zip64",
      value: `Yes. The zip64 end record at ${hexOffset(facts.record.offset)} gives the central directory${markers ? "" : ", although the end record holds no zip64 markers"}.`,
    });
  } else if (facts.zip64 === Zip64Use.IGNORED && facts.locator !== undefined) {
    list.push({
      id: "zip64",
      term: "Zip64",
      value: `A zip64 locator is at ${hexOffset(facts.locator.offset)}, but its end record is missing or does not agree with the end record. Zipscope uses the end record.`,
      level: "warning",
    });
  } else if (zip64Rows > 0) {
    list.push({
      id: "zip64",
      term: "Zip64",
      value: `Yes. ${plural(zip64Rows, "entry uses", "entries use")} zip64 fields; the end record has no zip64 record.`,
    });
  } else {
    list.push({ id: "zip64", term: "Zip64", value: "No." });
  }

  const disks = [
    `end record on disk ${end.disk}`,
    `central directory on disk ${end.directoryDisk}`,
  ];
  if (facts.locator !== undefined) {
    disks.push(`zip64 locator: ${plural(facts.locator.totalDisks, "disk", "disks")}`);
  }
  if (otherDiskRows > 0) {
    disks.push(`${plural(otherDiskRows, "entry starts", "entries start")} on another disk`);
  }
  list.push(
    facts.spansDisks || otherDiskRows > 0
      ? {
          id: "disks",
          term: "Disks",
          value: `The disk fields say this is part of a spanned archive (${disks.join(", ")}). Zipscope reads one file, so it does not support spanned archives. The listing can be incomplete.`,
          level: "error",
        }
      : { id: "disks", term: "Disks", value: "One disk." },
  );

  const declared = facts.declaredEntries;
  // The rule of the parse (`count_wrapped` of `crates/core/src/ingest.rs`). A
  // writer with no Zip64 keeps the low 16 bits of the count.
  const wrapped =
    listing === "complete" &&
    facts.zip64 === Zip64Use.NONE &&
    declared !== rows &&
    declared === rows % 65_536;
  const disagree = listing === "complete" && declared !== rows && !wrapped;
  const found =
    listing === "parsing" ? `${aboutCount(rows)} listed so far` : `${aboutCount(rows)} found`;
  const parts = [`${aboutCount(declared)} declared`, found];
  if (end.diskEntries !== end.totalEntries) {
    parts.push(`${aboutCount(end.diskEntries)} on this disk in the end record`);
  }
  list.push({
    id: "entries",
    term: "Entries",
    value: `${parts.join(", ")}.${listing === "partial" ? " The listing did not read the whole central directory." : ""}${wrapped ? " With no Zip64, the count has only 16 bits, and the declared and found values agree in 16 bits." : ""}`,
    ...(disagree ? { level: "warning" as const } : {}),
  });

  // The byte map gives the place and the size of the central directory
  // and of the end record. The Format section names the central
  // directory only when its declared size is false.
  const actual = facts.directoryEnd - facts.directoryOffset;
  if (facts.declaredDirectorySize !== actual) {
    list.push({
      id: "directory",
      term: "Central directory",
      value: `At ${hexOffset(facts.directoryOffset)}, ${formatSize(actual)}. The archive declares ${formatSize(facts.declaredDirectorySize)}.`,
      level: "warning",
    });
  }
  list.push(...more);
  return list;
}

/** The fact of an archive whose offsets wrapped at 4 GiB. */
export function wrappedFact(facts: ArchiveFacts): Fact {
  return {
    id: "wrapped-offsets",
    term: "Offsets",
    value: `The archive is over 4 GiB, but it has no Zip64, so its offsets wrapped at 4 GiB. The end record gives the central directory at ${hexOffset(facts.endRecord.directoryOffset)}, and it is at ${hexOffset(facts.directoryOffset)}. The byte map finds each entry by its local header, up to a limit of reads. After that limit it uses the order of the rows, and an entry can show at a place with no local header.`,
    level: "warning",
  };
}

/** CP437 characters for the bytes 0x80 to 0xff. */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

/** Decodes the archive comment like a name without the UTF-8 flag: UTF-8
 *  when the bytes are valid UTF-8, else CP437. When the end of the file `cut`
 *  the comment, its last character can be incomplete. That part is not shown,
 *  and it does not make the other bytes CP437. */
export function decodeComment(
  bytes: Uint8Array,
  cut = false,
): { text: string; encoding: "utf-8" | "cp437" } {
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: cut }),
      encoding: "utf-8",
    };
  } catch {
    let text = "";
    for (const byte of bytes) {
      text += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
    }
    return { text, encoding: "cp437" };
  }
}

export const panel = {
  comment: "Comment",
  cp437: "The comment is not valid UTF-8. It shows as CP437, as names do.",
  commentCut: (present: string, declared: string) =>
    `The file ends inside this comment. It shows ${present} of ${declared}.`,
  map: "Byte map",
  format: "Format",
  totals: "Totals",
  loading: "Reading the end of the archive…",
  mapping: "Mapping each byte of the file…",
  waiting: "The byte map shows when the listing ends.",
  hex: (region: string) => `View ${region} hex`,
  reading: "Reading the bytes…",
  hideHex: (region: string) => `Hide ${region} hex`,
  save: (region: string) => `Extract ${region}`,
  saved: (region: string) => `Extracted ${region}`,
  more: "Load more",
  build: (sha: string) => `Zipscope build ${sha}`,
  demo: "A synthetic archive made on this device for the demo.",
  moreGroups: (value: number) => `Show ${aboutCount(value)} more`,
  showFindings: (value: number) => `Show ${count(value, "finding")} in the health list`,
  remux: "Zstd copy",
  remuxNote:
    "Save a copy of the archive with Zstandard (zstd) compression. Before you save it, Zipscope shows how much of the archive is stored or barely compressed.",
  remuxButton: "Save zstd copy…",
};

/**
 * Returns the file range of a read of a region: `length` bytes from
 * `relative` in the region, cut at the region end. A read at the end is
 * empty. Throws for a read that starts past the end, and for a region or
 * a read whose end is not a safe integer. Thus a read never takes bytes
 * of the next region.
 */
export function regionRange(
  region: Pick<ArchiveRegion, "start" | "end">,
  relative: number,
  length: number,
): { start: number; end: number } {
  const { start, end } = region;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError("The region is not in the file");
  }
  if (!Number.isSafeInteger(relative) || relative < 0 || relative > end - start) {
    throw new RangeError("The read starts past the end of the region");
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("The read length is not valid");
  }
  const from = start + relative;
  return { start: from, end: Math.min(end, from + Math.min(length, end - from)) };
}

/** The groups of a breakdown that show at first, and the groups that each
 *  "Show more" adds. A hostile archive can have 65,536 methods. */
export const BREAKDOWN_FIRST = 10;
export const BREAKDOWN_STEP = 50;

/** The first `shown` groups of a breakdown, and the totals of the other
 *  groups in one row, so that the rows always add up to the totals. */
export function pageGroups(
  groups: readonly Breakdown[],
  shown: number,
): { rows: Breakdown[]; rest: (Omit<Breakdown, "key"> & { groups: number }) | undefined } {
  const rows = groups.slice(0, Math.max(0, shown));
  if (rows.length === groups.length) return { rows, rest: undefined };
  const rest = { groups: 0, entries: 0, uncompressed: 0, compressed: 0 };
  for (let index = rows.length; index < groups.length; index++) {
    const group = groups[index]!;
    rest.groups++;
    rest.entries += group.entries;
    rest.uncompressed += group.uncompressed;
    rest.compressed += group.compressed;
  }
  return { rows, rest };
}
