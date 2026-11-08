// The hint of the zstd copy, before the user saves it. It is a
// fact from the central directory, not a
// prediction: how much of the archive is stored or barely compressed.
// The dialog reads it from the mirrors, with no decode and no worker.
import { Marks, RegionKind } from "../contracts";
import type { ByteMap } from "../contracts";

/** An entry is barely compressed when its compressed size is at least
 *  this part of its uncompressed size (90%). */
export const BARELY_COMPRESSED = 0.9;
/** Below this part of the archive (5%) of stored or barely compressed bytes,
 *  the entries are not likely to get much smaller, and Cancel gets the focus.
 *  From this part on, bytes outside the entries get a sentence of their own. */
export const LOW_SHARE = 0.05;

/** The extensions of compressed formats. The copy keeps such entries as
 *  they are. This is the list of `crates/write/src/kind.rs` (`EXTENSIONS`),
 *  and a test makes sure that the two lists are the same. */
export const COMPRESSED_EXTENSIONS: ReadonlySet<string> = new Set(
  [
    // Images.
    "jpg jpeg jfif png apng gif webp avif heic heif jxl jp2",
    // Audio and video.
    "mp3 m4a aac ogg oga opus flac mp4 m4v mov mkv webm avi wmv flv 3gp",
    // Zip archives and formats that are zip archives.
    "zip jar war ear aar apk aab ipa xpi crx whl egg nupkg vsix docx xlsx pptx odt ods odp epub kmz",
    // Other archives and compressed streams.
    "gz tgz bz2 tbz tbz2 xz txz lz lzma lz4 zst zstd tzst br 7z rar cab dmg",
    // Fonts.
    "woff woff2",
  ].flatMap((group) => group.split(" ")),
);

/** True when the extension of `name` (after the last `.` of the last
 *  segment) is a compressed format, as `compressed_name` of the encoder. */
export function compressedName(name: string): boolean {
  const last = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = last.lastIndexOf(".");
  return dot >= 0 && COMPRESSED_EXTENSIONS.has(last.slice(dot + 1).toLowerCase());
}

/** The facts of one row for the hint. */
export interface HintRow {
  method: number;
  encrypted: boolean;
  uncompressed: number;
  compressed: number;
}

/** The sum of the hint that a row adds to: `loose` when it is stored or
 *  barely compressed, `formats` when it is that but a compressed format that the
 *  copy keeps as it is, else undefined. Only stored and deflate rows can be
 *  loose: Zstandard rows stay as they are, and the copy leaves out
 *  encrypted rows and the other methods. `name` gives the name only when
 *  the sizes make it necessary, because a name costs a decode. */
export function hintKind(row: HintRow, name: () => string): keyof Hint | undefined {
  if (row.encrypted || (row.method !== 0 && row.method !== 8)) return undefined;
  if (row.uncompressed <= 0 || row.compressed < BARELY_COMPRESSED * row.uncompressed) {
    return undefined;
  }
  return compressedName(name()) ? "formats" : "loose";
}

/** The sums of the hint, in compressed bytes of the archive. */
export interface Hint {
  /** Stored or barely compressed, and not a compressed format. */
  loose: number;
  /** Stored or barely compressed, but a compressed format. */
  formats: number;
}

/** The bytes of the file that no row uses: the prelude, the gaps and the
 *  epilogue of the byte map, which the Archive panel already asked for.
 *  Undefined when the map failed, or when a row has no place in the map,
 *  because a gap can then hold the data of that row. */
export function outsideBytes(map: ByteMap): number | undefined {
  if (!map.ok || map.counts.badHeaders > 0 || map.counts.pastDirectory > 0) return undefined;
  return map.regions.reduce(
    (sum, region) =>
      region.kind === RegionKind.PRELUDE || region.kind === RegionKind.EPILOGUE
        ? sum + region.end - region.start
        : sum,
    map.counts.gapBytes,
  );
}

/** The most rows that one turn of the count reads. */
export const COUNT_ROWS = 65_536;
/** The longest time of one turn of the count, in milliseconds. A row
 *  that counts costs a name decode, so 65,536 such rows can take more
 *  than 100 ms. */
export const COUNT_BUDGET_MS = 12;
/** The count reads the clock after this number of rows. */
const CLOCK_ROWS = 256;

/** The bytes of the rows, the rows that the copy leaves out and the
 *  hint, from the mirrors. */
export interface Counts {
  bytes: number;
  /** Rows that are encrypted or have a method that Zipscope cannot read,
   *  and that are not folder rows. */
  leftOut: number;
  /** File rows that cannot be read here (`Marks.WRAPPED_OFFSET`). */
  wrapped: number;
  hint: Hint;
}

/** The parts of the mirror reader that the count reads. */
export interface CountReader {
  value(
    row: number,
    column: "uncompressedSize" | "compressedSize" | "crc32" | "method" | "flags" | "marks",
  ): number;
  name(row: number): string;
}

/** The rule of `Kind::Folder` in the lead. The copy keeps such a row. The lead
 *  applies this rule before its rules for encryption and for the method. */
function folderRow(reader: CountReader, row: number, uncompressed: number): boolean {
  return uncompressed === 0 && reader.value(row, "crc32") === 0 && reader.name(row).endsWith("/");
}

/** The clock and the pause between two turns, so the tests can control
 *  them. */
export interface CountTurns {
  now(): number;
  pause(): Promise<void>;
}

const browserTurns: CountTurns = {
  now: () => performance.now(),
  pause: () => new Promise((resolve) => setTimeout(resolve, 0)),
};

/**
 * Counts the first `rows` rows of `reader`. A large archive has many
 * rows, so the count reads them in turns and does not stop the main
 * thread for long: a turn ends after COUNT_ROWS rows or COUNT_BUDGET_MS,
 * whichever comes first. Returns undefined when `live` becomes false.
 */
export async function countRows(
  reader: CountReader,
  rows: number,
  live: () => boolean,
  turns: CountTurns = browserTurns,
): Promise<Counts | undefined> {
  let bytes = 0;
  let leftOut = 0;
  let wrapped = 0;
  const hint: Hint = { loose: 0, formats: 0 };
  let start = turns.now();
  let turn = 0;
  for (let row = 0; row < rows; row++) {
    const uncompressed = reader.value(row, "uncompressedSize");
    bytes += uncompressed;
    const method = reader.value(row, "method");
    const encrypted = (reader.value(row, "flags") & 1) !== 0 || method === 99;
    // A row that cannot be read goes out of the copy, so it adds no hint.
    if ((reader.value(row, "marks") & Marks.WRAPPED_OFFSET) !== 0) {
      if (!folderRow(reader, row, uncompressed)) wrapped++;
    } else {
      if (
        (encrypted || ![0, 8, 20, 93].includes(method)) &&
        !folderRow(reader, row, uncompressed)
      ) {
        leftOut++;
      }
      const compressed = reader.value(row, "compressedSize");
      const kind = hintKind({ method, encrypted, uncompressed, compressed }, () =>
        reader.name(row),
      );
      if (kind !== undefined) hint[kind] += compressed;
    }
    turn++;
    const late = turn % CLOCK_ROWS === 0 && turns.now() - start >= COUNT_BUDGET_MS;
    if (row + 1 < rows && (turn >= COUNT_ROWS || late)) {
      await turns.pause();
      if (!live()) return undefined;
      start = turns.now();
      turn = 0;
    }
  }
  return { bytes, leftOut, wrapped, hint };
}
