// Reads the zstd copy of the remux tests: each record of the
// central directory with its raw fields, and its data decoded (stored,
// deflate or Zstandard) with the CRC-32 checked. No zip64 support: the
// test copies are small.
import { crc32, inflateRawSync, zstdDecompressSync } from "node:zlib";
import { png } from "./content-zip";
import type { ContentEntry } from "./content-zip";

export interface CopyEntry {
  name: string;
  method: number;
  flags: number;
  time: number;
  date: number;
  external: number;
  comment: string;
  extra: Buffer;
  localExtra: Buffer;
  offset: number;
  compressed: Buffer;
  data: Buffer;
  verified: boolean;
}

export interface Copy {
  entries: CopyEntry[];
  comment: string;
}

export function hasEndRecord(zip: Buffer): boolean {
  return zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0;
}

export function readCopy(zip: Buffer): Copy {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("No end of central directory record");
  const count = zip.readUInt16LE(end + 10);
  const comment = zip.subarray(end + 22, end + 22 + zip.readUInt16LE(end + 20)).toString();
  let at = zip.readUInt32LE(end + 16);
  const entries: CopyEntry[] = [];
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`No record at ${at}`);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const offset = zip.readUInt32LE(at + 42);
    const nameEnd = at + 46 + nameLength;
    const local = offset + 30 + zip.readUInt16LE(offset + 26);
    const localExtra = zip.subarray(local, local + zip.readUInt16LE(offset + 28));
    const compressed = zip.subarray(
      local + localExtra.length,
      local + localExtra.length + compressedSize,
    );
    const data =
      method === 8
        ? inflateRawSync(compressed)
        : method === 93
          ? zstdDecompressSync(compressed)
          : Buffer.from(compressed);
    entries.push({
      name: zip.subarray(at + 46, nameEnd).toString("utf8"),
      method,
      flags: zip.readUInt16LE(at + 8),
      time: zip.readUInt16LE(at + 12),
      date: zip.readUInt16LE(at + 14),
      external: zip.readUInt32LE(at + 38),
      comment: zip
        .subarray(nameEnd + extraLength, nameEnd + extraLength + commentLength)
        .toString(),
      extra: zip.subarray(nameEnd, nameEnd + extraLength),
      localExtra,
      offset,
      compressed,
      data,
      verified: data.length === size && crc32(data) >>> 0 === crc >>> 0,
    });
    at = nameEnd + extraLength + commentLength;
  }
  return { entries, comment };
}

/** `length` bytes of text that compress well, from a seed. */
export function text(length: number, seed = 1): Buffer {
  const words = ["survey", "sheet", "contour", "margin", "scale", "legend", "zstd", "remux"];
  const parts: string[] = [];
  let state = seed;
  let size = 0;
  while (size < length) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const word = words[state % words.length]!;
    parts.push(word);
    size += word.length + 1;
  }
  return Buffer.from(parts.join(" ").slice(0, length));
}

/** `length` bytes that do not compress. */
export function noise(length: number, seed = 7): Buffer {
  const out = Buffer.alloc(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/** An archive with stored, deflate and Zstandard rows, an image, data that
 *  does not compress, an empty file and a row with a false CRC-32. */
export const REMUX_ENTRIES: ContentEntry[] = [
  { name: "docs/readme.txt", data: text(300_000, 1) },
  { name: "docs/stored.txt", data: text(80_000, 2), method: 0 },
  { name: "docs/already.txt", data: text(50_000, 3), method: 93 },
  { name: "img/red.png", data: png(40, 40) },
  { name: "bin/noise.bin", data: noise(200_000), method: 0 },
  { name: "empty.txt", data: Buffer.alloc(0), method: 0 },
  { name: "bad-crc.txt", data: text(5000, 4), crc: 0x12345678 },
  { name: "tail.txt", data: text(10_000, 5), method: 0 },
];

/** The zip with `bytes` put at the file offset `at`, and with its offsets moved, so each
 *  offset gives the true place. At 0 it is a prelude that the offsets count. */
export function insertBytes(zip: Buffer, at: number, bytes: Buffer): Buffer {
  const out = Buffer.concat([zip.subarray(0, at), bytes, zip.subarray(at)]);
  const end = out.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let record = out.readUInt32LE(end + 16) + bytes.length;
  out.writeUInt32LE(record, end + 16);
  for (let row = 0; row < out.readUInt16LE(end + 10); row++) {
    const offset = out.readUInt32LE(record + 42);
    if (offset >= at) out.writeUInt32LE(offset + bytes.length, record + 42);
    record +=
      46 +
      out.readUInt16LE(record + 28) +
      out.readUInt16LE(record + 30) +
      out.readUInt16LE(record + 32);
  }
  return out;
}

/** The fact of 1,000,000 bytes outside the entries. */
export const OUTSIDE =
  "976.6\u00a0KiB of this archive is outside the entries. The copy does not keep those bytes.";
/** One small entry that deflate makes smaller, so no entry is stored. */
export const SMALL: ContentEntry[] = [{ name: "a.txt", data: text(2000, 1) }];
