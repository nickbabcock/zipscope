// Builds stored zip archives with a prelude, gaps, a comment, an epilogue
// and false end-record fields, for the Archive panel tests.
// The offsets are absolute, as a self-extractor writes them.

export interface PanelEntry {
  name: string;
  data: Buffer;
  /** Bytes after the data of this entry: a gap. */
  after?: Buffer;
  /** Version made by: the creating OS in the high byte. */
  madeBy?: number;
  /** The compression method (the data stays as it is). */
  method?: number;
  /** The general purpose flags: bit 0 marks ZipCrypto encryption. */
  flags?: number;
}

export interface PanelZip {
  prelude?: Buffer;
  entries: PanelEntry[];
  /** Bytes between the last entry and the central directory. */
  beforeDirectory?: Buffer;
  comment?: Buffer;
  epilogue?: Buffer;
  /** The entry count in the end record. */
  declared?: number;
  disk?: number;
  directoryDisk?: number;
  /** Write a zip64 end record and locator, with "see zip64" markers. */
  zip64?: boolean;
  /** The comment length field, when it is not the length of the comment. */
  commentLength?: number;
}

export function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** Returns the archive and the offset of each part. */
export function panelZip(spec: PanelZip): { bytes: Buffer; directory: number; end: number } {
  const parts: Buffer[] = [];
  let offset = 0;
  const add = (part: Buffer) => {
    parts.push(part);
    offset += part.length;
  };
  add(spec.prelude ?? Buffer.alloc(0));
  const centrals: Buffer[] = [];
  for (const entry of spec.entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(entry.method ?? 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.madeBy ?? 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(entry.method ?? 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    add(Buffer.concat([local, name, entry.data, entry.after ?? Buffer.alloc(0)]));
  }
  add(spec.beforeDirectory ?? Buffer.alloc(0));
  const directory = offset;
  const records = Buffer.concat(centrals);
  add(records);
  const count = spec.declared ?? spec.entries.length;
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(spec.disk ?? 0, 4);
  endRecord.writeUInt16LE(spec.directoryDisk ?? 0, 6);
  if (spec.zip64 === true) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(records.length), 40);
    record.writeBigUInt64LE(BigInt(directory), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset), 8);
    locator.writeUInt32LE(1, 16);
    add(record);
    add(locator);
    endRecord.writeUInt16LE(0xffff, 8);
    endRecord.writeUInt16LE(0xffff, 10);
    endRecord.writeUInt32LE(0xffffffff, 12);
    endRecord.writeUInt32LE(0xffffffff, 16);
  } else {
    endRecord.writeUInt16LE(count, 8);
    endRecord.writeUInt16LE(count, 10);
    endRecord.writeUInt32LE(records.length, 12);
    endRecord.writeUInt32LE(directory, 16);
  }
  const comment = spec.comment ?? Buffer.alloc(0);
  endRecord.writeUInt16LE(spec.commentLength ?? comment.length, 20);
  const end = offset;
  add(endRecord);
  add(comment);
  add(spec.epilogue ?? Buffer.alloc(0));
  return { bytes: Buffer.concat(parts), directory, end };
}

/** An APK signing block of `pairs` bytes of pairs, with its magic. */
export function apkSigningBlock(pairs: number): Buffer {
  const size = BigInt(pairs + 8 + 16);
  const head = Buffer.alloc(8);
  head.writeBigUInt64LE(size);
  return Buffer.concat([head, Buffer.alloc(pairs, 7), head, Buffer.from("APK Sig Block 42")]);
}
