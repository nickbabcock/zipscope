// Reads a small zip for the extraction tests: the entries of
// the central directory, with their data decoded and their CRC-32 checked.
import { crc32, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  method: number;
  data: Buffer;
  /** True when the CRC-32 and the size of the decoded data agree with the
   *  central directory. */
  verified: boolean;
}

/** Returns the entries of a zip without zip64 records. */
export function readZip(zip: Buffer): ZipEntry[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("No end of central directory record");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`No record at ${at}`);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const local = 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const raw = zip.subarray(offset + local, offset + local + compressed);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    entries.push({
      name,
      method,
      data,
      verified: data.length === size && crc32(data) >>> 0 === crc >>> 0,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
