// Builds small zip archives with real entry data for the preview tests.
import { crc32, deflateRawSync, deflateSync, zstdCompressSync } from "node:zlib";

export interface ContentEntry {
  name: string;
  data: Buffer;
  /** 0 stored, 8 deflate or 93 Zstandard. The default is deflate. */
  method?: 0 | 8 | 93;
  /** The bytes after the local header. The default compresses `data`. */
  compressed?: Buffer;
  /** A local header name that is not the central-directory name. */
  localName?: string;
  /** The CRC-32 in the headers. The default is the CRC-32 of `data`. */
  crc?: number;
  /** The uncompressed size in the headers. The default is the length of
   *  `data`. */
  size?: number;
  /** The general purpose flags in the headers. The default is 0. */
  flags?: number;
  /** The external attributes and the version made by. */
  attributes?: number;
  madeBy?: number;
}

/** Returns an archive with the entries in order. */
export function contentZip(entries: ContentEntry[]): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body =
      entry.compressed ??
      (method === 8
        ? deflateRawSync(entry.data)
        : method === 93
          ? zstdCompressSync(entry.data)
          : entry.data);
    const crc = entry.crc ?? crc32(entry.data);
    const size = entry.size ?? entry.data.length;
    const name = Buffer.from(entry.name);
    const localName = Buffer.from(entry.localName ?? entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(localName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.madeBy ?? 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    // 2026-10-28 09:13
    central.writeUInt16LE((9 << 11) | (13 << 5), 12);
    central.writeUInt16LE((46 << 9) | (10 << 5) | 28, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.attributes ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    parts.push(local, localName, body);
    centrals.push(central, name);
    offset += local.length + localName.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  // A count above 65,535 needs zip64. The count is only a hint.
  end.writeUInt16LE(Math.min(entries.length, 0xffff), 8);
  end.writeUInt16LE(Math.min(entries.length, 0xffff), 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Returns a PNG image of `width` × `height` red pixels. */
export function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from([255, 0, 0]))]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A skippable Zstandard frame with `length` bytes of content. */
export function skippableFrame(length: number): Buffer {
  const frame = Buffer.alloc(8 + length);
  frame.writeUInt32LE(0x184d2a50, 0);
  frame.writeUInt32LE(length, 4);
  return frame;
}
