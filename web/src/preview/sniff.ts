// Decides how the preview shows entry data, and decodes it. Archive data is
// untrusted: text is only ever text, HTML is never rendered, and an image
// shows only through <img> from a Blob URL, also SVG, where scripts cannot
// run. This file has no DOM code, so the unit tests and workers can use it.

/** How the preview shows an entry. */
export type PreviewKind = "text" | "image" | "hex";

/** The bytes that the sniffers read from the start of an entry. */
export const SNIFF_BYTES = 8192;

/** True when `bytes` starts with `prefix`, at `at`. */
function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  return prefix.every((value, index) => bytes[at + index] === value);
}

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** The extension of a name, in lower case, without the dot. */
export function extension(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * Returns the image MIME type of entry data, or undefined. The bytes
 * decide for raster images. SVG is text, so it needs the `.svg` extension
 * and an `<svg` element near the start.
 */
export function imageType(name: string, bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) {
    return "image/gif";
  }
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(bytes, ascii("BM")) && extension(name) === "bmp") return "image/bmp";
  if (startsWith(bytes, [0, 0, 1, 0]) && extension(name) === "ico") return "image/x-icon";
  if (startsWith(bytes, ascii("ftypavif"), 4)) return "image/avif";
  if (extension(name) === "svg") {
    const head = new TextDecoder("utf-8").decode(bytes.subarray(0, SNIFF_BYTES));
    if (/<svg[\s>]/i.test(head)) return "image/svg+xml";
  }
  return undefined;
}

/** The UTF-16 byte order mark of the data, or undefined. */
export function utf16Order(bytes: Uint8Array): "utf-16le" | "utf-16be" | undefined {
  if (startsWith(bytes, [0xff, 0xfe])) return "utf-16le";
  if (startsWith(bytes, [0xfe, 0xff])) return "utf-16be";
  return undefined;
}

/** Returns the length of the valid UTF-8 sequence at `at`, or 0. */
function sequenceLength(bytes: Uint8Array, at: number): number {
  const first = bytes[at]!;
  let length: number;
  let min: number;
  if (first < 0x80) return 1;
  if (first >= 0xc2 && first <= 0xdf) [length, min] = [2, 0x80];
  else if (first >= 0xe0 && first <= 0xef) [length, min] = [3, 0x800];
  else if (first >= 0xf0 && first <= 0xf4) [length, min] = [4, 0x10000];
  else return 0;
  let code = first & (0xff >> (length + 1));
  for (let index = 1; index < length; index++) {
    const next = bytes[at + index];
    // A sequence that the sample cuts is not invalid.
    if (next === undefined) return bytes.length - at;
    if ((next & 0xc0) !== 0x80) return 0;
    code = (code << 6) | (next & 0x3f);
  }
  if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return 0;
  return length;
}

/**
 * True when the start of the data looks binary: it has a NUL byte, more
 * than 2% control characters, or more than 30% bytes that are not valid
 * UTF-8, counted on at least 64 bytes. Text in Windows-1252 has invalid
 * UTF-8 bytes, but each accented letter is one byte among ASCII letters.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, SNIFF_BYTES);
  if (sample.length === 0) return false;
  if (utf16Order(sample) !== undefined) return false;
  let controls = 0;
  let invalid = 0;
  let at = 0;
  while (at < sample.length) {
    const byte = sample[at]!;
    if (byte === 0) return true;
    // Tab, line feed, form feed, carriage return and escape are text.
    const text = byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x1b;
    if ((byte < 0x20 && !text) || byte === 0x7f) {
      controls++;
      at++;
      continue;
    }
    const length = sequenceLength(sample, at);
    if (length === 0) {
      invalid++;
      at++;
    } else {
      at += length;
    }
  }
  // A short text with one or two accented letters is still text.
  const base = Math.max(sample.length, 64);
  return controls * 50 > base || invalid * 10 > base * 3;
}

/** Decides how to show an entry from its name and its first bytes. */
export function previewKind(name: string, bytes: Uint8Array): PreviewKind {
  if (imageType(name, bytes) !== undefined) return "image";
  return looksBinary(bytes) ? "hex" : "text";
}

/** Text decoded from the start of an entry. */
export interface DecodedText {
  text: string;
  /** The encoding that decoded the bytes. */
  encoding: "utf-8" | "windows-1252" | "utf-16le" | "utf-16be";
}

/**
 * Decodes the bytes of an entry as text. UTF-8 comes first. Bytes that are
 * not valid UTF-8 make the whole text Windows-1252, which decodes all
 * bytes. With `complete` false, more bytes follow: a UTF-8 sequence that
 * the end cuts is not an error and is not decoded.
 */
export function decodeText(bytes: Uint8Array, complete: boolean): DecodedText {
  const order = utf16Order(bytes);
  if (order !== undefined) {
    // Drop an odd last byte until the next bytes come.
    const even = complete ? bytes : bytes.subarray(0, bytes.length & ~1);
    return { text: new TextDecoder(order).decode(even), encoding: order };
  }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return { text: decoder.decode(bytes, { stream: !complete }), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

/** The number of lines of a text, for the line numbers. A last line
 *  without a line feed counts. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  let count = 1;
  let at = text.indexOf("\n");
  while (at !== -1) {
    if (at !== text.length - 1) count++;
    at = text.indexOf("\n", at + 1);
  }
  return count;
}

const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0"));

/**
 * Formats bytes as a hex dump: the offset, 16 bytes in hex and the
 * printable ASCII characters, one line for each 16 bytes.
 * `00000000  48 65 6c 6c 6f 0a                                 |Hello.|`
 */
export function hexDump(bytes: Uint8Array, offset = 0, width: 8 | 16 = 16): string {
  const lines: string[] = [];
  for (let start = 0; start < bytes.length; start += width) {
    const row = bytes.subarray(start, start + width);
    let hex = "";
    let text = "";
    for (let index = 0; index < width; index++) {
      const value = row[index];
      // A gap at the middle of the row.
      if (index === width / 2) hex += " ";
      if (value === undefined) {
        hex += "   ";
      } else {
        hex += `${HEX[value]} `;
        text += value >= 0x20 && value < 0x7f ? String.fromCharCode(value) : ".";
      }
    }
    lines.push(`${(offset + start).toString(16).padStart(8, "0")}  ${hex} |${text}|`);
  }
  return lines.join("\n");
}

/** Joins each group of `size` lines into one text, in order. The last text
 *  can have fewer lines. */
export function chunkLines(lines: readonly string[], size: number): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < lines.length; start += size) {
    chunks.push(lines.slice(start, start + size).join("\n"));
  }
  return chunks;
}
