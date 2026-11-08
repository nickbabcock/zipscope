// UI text for table values, and the number format of all UI text. v1 is
// English only. All UI strings for the table are in this module, so that a
// later change can translate them.
import { Encryption, TimeKind } from "./contracts";

const UNITS = ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB"] as const;

/** The number formats of the UI. They use the browser locale for the
 *  group and decimal marks: a German browser shows `65.539 entries` and
 *  `1,5 KiB`. The digits are Latin in all
 *  locales, because the words and the column layout are for Latin digits.
 *  Each format is made one time, because the table formats many rows. Text
 *  that the user copies does not use these formats: it has one fixed form
 *  in all locales. */
const LATIN = { numberingSystem: "latn" } as const;

/** The format of a count or of an exact byte count: `65,539`. */
export const integers = new Intl.NumberFormat(undefined, { ...LATIN, maximumFractionDigits: 0 });

/** The formats of a size, a ratio or a percent, with 1 and 2 decimals:
 *  `1.5`. They have no group marks, so that a size keeps the width that
 *  the table has for it (at most 4 digits before the decimal mark). */
const decimals = [1, 2].map(
  (digits) =>
    new Intl.NumberFormat(undefined, {
      ...LATIN,
      useGrouping: false,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }),
);

/** Formats a number with 1 or 2 decimals in the browser locale: `0.1`. */
export function decimal(value: number, digits: 1 | 2 = 1): string {
  return decimals[digits - 1]!.format(value);
}

/** Formats a count with its noun: "1 file", "1,204 files". */
export function count(value: number, one: string, many = `${one}s`): string {
  return `${integers.format(value)} ${value === 1 ? one : many}`;
}

/** The space between a number and its unit: a no-break space, so that a
 *  line never breaks between them. */
export const UNIT_SPACE = "\u00a0";

/** Formats a byte count with binary units: `512 B`, `1.5 KiB`, `2.25 GiB`. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes}${UNIT_SPACE}B`;
  }
  let unit = 0;
  let value = bytes / 1024;
  for (;;) {
    // GiB and larger below 10 show two decimals, as in the design sketch.
    const digits = unit >= 2 && value < 10 ? 2 : 1;
    // Rounding can give 1024.0. Then use the next unit. The check is on
    // the rounded number, not on the text of the locale.
    const rounded = Number(value.toFixed(digits));
    if (rounded < 1024 || unit === UNITS.length - 1) {
      return `${decimal(rounded, digits)}${UNIT_SPACE}${UNITS[unit]}`;
    }
    value /= 1024;
    unit++;
  }
}

/** Formats the exact byte count for the hover text. */
export function exactBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) {
    return "";
  }
  const text = `${integers.format(bytes)} ${bytes === 1 ? "byte" : "bytes"}`;
  // A size above 2^53 is not exact in f64.
  return Number.isSafeInteger(bytes) ? text : `About ${text}`;
}

/** Formats compressed ÷ uncompressed as a percentage. Zero bytes show "—".
 *  A ratio above 100% (the entry grew) shows as it is. */
export function formatRatio(compressed: number, uncompressed: number): string {
  if (uncompressed === 0) {
    return "—";
  }
  // Round the number first, as `copiedRatio` does, so that the shown
  // text and the copied text have the same digits.
  return `${decimal(Number(((compressed / uncompressed) * 100).toFixed(1)))}%`;
}

/** Formats the ratio in one fixed form for text that the user copies:
 *  `12.5%` in all locales. */
export function copiedRatio(compressed: number, uncompressed: number): string {
  if (uncompressed === 0) {
    return "—";
  }
  return `${((compressed / uncompressed) * 100).toFixed(1)}%`;
}

const METHODS: Record<number, string> = {
  0: "Stored",
  1: "Shrunk",
  2: "Reduced",
  3: "Reduced",
  4: "Reduced",
  5: "Reduced",
  6: "Imploded",
  8: "Deflate",
  9: "Deflate64",
  10: "DCL Implode",
  12: "bzip2",
  14: "LZMA",
  16: "IBM CMPSC",
  18: "IBM TERSE",
  19: "IBM LZ77",
  20: "Zstandard",
  93: "Zstandard",
  94: "MP3",
  95: "XZ",
  96: "JPEG",
  97: "WavPack",
  98: "PPMd",
  99: "AES",
};

/** Returns the name of a compression method. */
export function methodName(method: number): string {
  return METHODS[method] ?? `Method ${method}`;
}

/** Returns the encryption label, or undefined for an entry without
 *  encryption. */
export function encryptionName(encryption: number): string | undefined {
  switch (encryption & 0x7f) {
    case Encryption.NONE:
      return undefined;
    case Encryption.ZIP_CRYPTO:
      return "ZipCrypto";
    case Encryption.AES_128:
      return "AES-128";
    case Encryption.AES_192:
      return "AES-192";
    case Encryption.AES_256:
      return "AES-256";
    case Encryption.AES_UNKNOWN:
      return "AES";
    default:
      return "Encrypted";
  }
}

export interface CellText {
  text: string;
  /** The hover text. */
  title: string;
}

/** Formats the method cell: "Deflate", "AES-256 · Deflate". */
export function formatMethod(method: number, encryption: number, aesMethod: number): CellText {
  const kind = encryption & 0x7f;
  const name = encryptionName(encryption);
  if (name === undefined) {
    return { text: methodName(method), title: `Method ${method}` };
  }
  const aes = kind >= Encryption.AES_128 && kind <= Encryption.AES_256;
  if (aes) {
    const version = encryption & Encryption.AE2 ? "AE-2" : "AE-1";
    return {
      text: `${name} · ${methodName(aesMethod)}`,
      title: `${name} (${version}), method ${aesMethod}`,
    };
  }
  if (kind === Encryption.AES_UNKNOWN) {
    return {
      text: name,
      title: "AES, but the AES extra field is missing or not valid",
    };
  }
  return { text: `${name} · ${methodName(method)}`, title: `${name}, method ${method}` };
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

function dateText(date: Date, utc: boolean): string {
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
  const day = utc ? date.getUTCDate() : date.getDate();
  const hours = utc ? date.getUTCHours() : date.getHours();
  const minutes = utc ? date.getUTCMinutes() : date.getMinutes();
  return `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hours)}:${pad(minutes)}`;
}

export interface ModifiedText extends CellText {
  /** True for a DOS time, which has no time zone. */
  noTimeZone: boolean;
}

/** Formats the modified cell. A UTC time shows in the viewer's time zone,
 *  with UTC on hover. A DOS time shows as written, with a marker. */
export function formatModified(ms: number, kind: number): ModifiedText {
  const date = new Date(ms);
  if (kind === TimeKind.NONE || Number.isNaN(date.getTime())) {
    return { text: "—", title: "No modified time", noTimeZone: false };
  }
  const seconds = pad(date.getUTCSeconds());
  if (kind === TimeKind.DOS) {
    return {
      text: dateText(date, true),
      title: `No time zone: DOS time as written, ${dateText(date, true)}:${seconds}`,
      noTimeZone: true,
    };
  }
  return {
    text: dateText(date, false),
    title: `${dateText(date, true)}:${seconds} UTC`,
    noTimeZone: false,
  };
}

/** Marks a rolled-up value that can still grow while parsing: "≥ 1.2 GiB". */
export function settling(text: string, isSettling: boolean): string {
  return isSettling ? `≥ ${text}` : text;
}

/** One marker for a cell with no value. */
export const NO_VALUE = "—";

/** Formats a rolled-up size that can still grow. "≥ 0 B" tells nothing, so
 *  a sum of 0 while the size settles is the empty-cell marker. */
export function settlingSize(bytes: number, isSettling: boolean): string {
  return isSettling && bytes === 0 ? NO_VALUE : settling(formatSize(bytes), isSettling);
}

/** Formats an entry count: "1 entry", "1,204 entries". */
export function formatCount(value: number): string {
  return count(value, "entry", "entries");
}

/** Formats a file offset as hex: `0x0001a2b0`. */
export function hexOffset(offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) return "—";
  return `0x${offset.toString(16).padStart(8, "0")}`;
}
