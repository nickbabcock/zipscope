// Make small archives. Set header fields separately when a test needs it.
import {
  crc32,
  deflateRawSync,
  inflateRawSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";

export interface HostileEntry {
  name: string | Buffer;
  body: Buffer;
  method?: number;
  data?: Buffer;
  flags?: number;
  size?: bigint;
  crc?: number;
  localName?: Buffer;
  localSize?: bigint;
  localCompressed?: bigint;
  localOffset?: number;
  extra?: Buffer;
  madeBy?: number;
  attributes?: number;
  descriptor?: "signed" | "unsigned";
}

function sizes(size: bigint, compressed: bigint) {
  const zip64 = size >= 0xffff_ffffn || compressed >= 0xffff_ffffn;
  const extra = Buffer.alloc(zip64 ? 20 : 0);
  if (zip64) {
    extra.writeUInt16LE(1, 0);
    extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(size, 4);
    extra.writeBigUInt64LE(compressed, 12);
  }
  return {
    size: zip64 ? 0xffff_ffff : Number(size),
    compressed: zip64 ? 0xffff_ffff : Number(compressed),
    extra,
    version: zip64 ? 45 : 20,
  };
}

export function unicodePath(raw: Buffer, name: string): Buffer {
  const text = Buffer.from(name);
  const field = Buffer.alloc(9);
  field.writeUInt16LE(0x7075, 0);
  field.writeUInt16LE(5 + text.length, 2);
  field[4] = 1;
  field.writeUInt32LE(crc32(raw), 5);
  return Buffer.concat([field, text]);
}

export function hostileZip(entries: readonly HostileEntry[]): Buffer {
  const locals: Buffer[] = [];
  const records: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const localName = entry.localName ?? name;
    const method = entry.method ?? 0;
    const data =
      entry.data ??
      (method === 8
        ? deflateRawSync(entry.body)
        : method === 20 || method === 93
          ? zstdCompressSync(entry.body)
          : entry.body);
    const size = entry.size ?? BigInt(entry.body.length);
    const crc = entry.crc ?? crc32(entry.body);
    const flags = (entry.flags ?? 0x800) | (entry.descriptor === undefined ? 0 : 8);
    const cdSize = sizes(size, BigInt(data.length));
    const lhSize = sizes(entry.localSize ?? size, entry.localCompressed ?? BigInt(data.length));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(lhSize.version, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entry.descriptor === undefined ? crc : 0, 14);
    local.writeUInt32LE(entry.descriptor === undefined ? lhSize.compressed : 0, 18);
    local.writeUInt32LE(entry.descriptor === undefined ? lhSize.size : 0, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(lhSize.extra.length, 28);
    const descriptor = Buffer.alloc(
      entry.descriptor === undefined ? 0 : entry.descriptor === "signed" ? 16 : 12,
    );
    if (descriptor.length !== 0) {
      const start = entry.descriptor === "signed" ? 4 : 0;
      if (start !== 0) descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, start);
      descriptor.writeUInt32LE(data.length, start + 4);
      descriptor.writeUInt32LE(Number(size), start + 8);
    }
    const extra = Buffer.concat([cdSize.extra, entry.extra ?? Buffer.alloc(0)]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.madeBy ?? 0x0314, 4);
    central.writeUInt16LE(cdSize.version, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(cdSize.compressed, 20);
    central.writeUInt32LE(cdSize.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(entry.attributes ?? 0, 38);
    central.writeUInt32LE(entry.localOffset ?? offset, 42);
    locals.push(local, localName, lhSize.extra, data, descriptor);
    records.push(central, name, extra);
    offset +=
      local.length + localName.length + lhSize.extra.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export interface DownloadEntry {
  name: string;
  body: Buffer;
  compressed: Buffer;
  method: number;
  attributes: number;
}

const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅ" +
  "ÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
  "áíóúñÑªº¿⌐¬½¼¡«»" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧" +
  "╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩" +
  "≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";

function decodedName(raw: Buffer, flags: number, extra: Buffer): string {
  for (let at = 0; at + 4 <= extra.length;) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (id === 0x7075) {
      if (
        length > 5 &&
        at + 4 + length <= extra.length &&
        extra[at + 4] === 1 &&
        extra.readUInt32LE(at + 5) === crc32(raw)
      ) {
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(
            extra.subarray(at + 9, at + 4 + length),
          );
        } catch {
          break;
        }
      }
      break;
    }
    at += 4 + length;
  }
  if ((flags & 0x800) !== 0) return raw.toString("utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return [...raw]
      .map((byte) => (byte < 128 ? String.fromCharCode(byte) : CP437_HIGH[byte - 128]))
      .join("");
  }
}

// Read the central directory. A data descriptor can contain ZIP signatures.
export function readDownload(bytes: Buffer): DownloadEntry[] {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("No end record");
  let count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffff_ffff) {
    if (bytes.readUInt32LE(end - 20) !== 0x07064b50) throw new Error("No zip64 locator");
    const zip64 = Number(bytes.readBigUInt64LE(end - 12));
    count = Number(bytes.readBigUInt64LE(zip64 + 32));
    at = Number(bytes.readBigUInt64LE(zip64 + 48));
  }
  const result: DownloadEntry[] = [];
  for (let row = 0; row < count; row++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error("Bad central record");
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const rawName = bytes.subarray(at + 46, at + 46 + nameLength);
    const extra = bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    const name = decodedName(rawName, bytes.readUInt16LE(at + 8), extra);
    let size = bytes.readUInt32LE(at + 24);
    let compressedSize = bytes.readUInt32LE(at + 20);
    let offset = bytes.readUInt32LE(at + 42);
    for (let field = at + 46 + nameLength; field < at + 46 + nameLength + extraLength;) {
      const id = bytes.readUInt16LE(field);
      const length = bytes.readUInt16LE(field + 2);
      if (id === 1) {
        let value = field + 4;
        if (size === 0xffff_ffff) {
          size = Number(bytes.readBigUInt64LE(value));
          value += 8;
        }
        if (compressedSize === 0xffff_ffff) {
          compressedSize = Number(bytes.readBigUInt64LE(value));
          value += 8;
        }
        if (offset === 0xffff_ffff) offset = Number(bytes.readBigUInt64LE(value));
      }
      field += 4 + length;
    }
    if (bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error("Bad local record");
    const localNameLength = bytes.readUInt16LE(offset + 26);
    const localExtraLength = bytes.readUInt16LE(offset + 28);
    if (!bytes.subarray(offset + 30, offset + 30 + localNameLength).equals(rawName)) {
      throw new Error("Output names differ");
    }
    const start = offset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(start, start + compressedSize);
    const method = bytes.readUInt16LE(at + 10);
    const body =
      method === 0
        ? compressed
        : method === 8
          ? inflateRawSync(compressed)
          : method === 20 || method === 93
            ? zstdDecompressSync(compressed)
            : undefined;
    if (body === undefined) throw new Error(`Unknown output method ${method}`);
    if (body.length !== size || crc32(body) !== bytes.readUInt32LE(at + 16)) {
      throw new Error("Output did not verify");
    }
    result.push({ name, body, compressed, method, attributes: bytes.readUInt32LE(at + 38) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}
