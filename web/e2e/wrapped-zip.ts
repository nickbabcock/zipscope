// Sparse archives of more than 4 GiB with no Zip64: the offsets of the rows
// past 4 GiB wrapped. A test writes the file, not an old zip tool, and the
// rows that cannot be read are holes. The file is sparse, so it uses some
// kilobytes of disk, and the writer checks that.
import { closeSync, ftruncateSync, openSync, statSync, writeSync } from "node:fs";
import { crc32 } from "node:zlib";

export const GIB = 2 ** 30;

export interface WrappedRow {
  name: string;
  /** The place of the local header in the file. */
  at: number;
  /** The declared size. The default is the size of the body. */
  size?: number;
  body?: string | Buffer;
  /** The offset field, if it is not the low 32 bits of `at`. */
  field?: number;
  /** The file has no local header for this record. */
  noHeader?: boolean;
}

/** The local header and the data of a row. */
export function localBytes(row: WrappedRow): Buffer {
  const name = Buffer.from(row.name);
  const body = Buffer.from(row.body ?? "");
  const size = row.size ?? body.length;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(body), 14);
  local.writeUInt32LE(size, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(name.length, 26);
  return Buffer.concat([local, name, body]);
}

/** Writes a sparse zip with stored rows at exact places and no Zip64 to
 *  `file`. `headers` are more local headers with no record. */
export function writeWrappedZip(
  file: string,
  rows: WrappedRow[],
  directory: number,
  declared = directory % 2 ** 32,
  headers: WrappedRow[] = [],
): void {
  const fd = openSync(file, "w");
  const records: Buffer[] = [];
  for (const row of rows) {
    const name = Buffer.from(row.name);
    const body = Buffer.from(row.body ?? "");
    const size = row.size ?? body.length;
    const crc = crc32(body);
    if (row.noHeader !== true) writeSync(fd, localBytes(row), 0, undefined, row.at);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(size, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(row.field ?? row.at % 2 ** 32, 42);
    records.push(record, name);
  }
  for (const header of headers) writeSync(fd, localBytes(header), 0, undefined, header.at);
  const central = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(rows.length, 8);
  end.writeUInt16LE(rows.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(declared, 16);
  const tail = Buffer.concat([central, end]);
  writeSync(fd, tail, 0, undefined, directory);
  ftruncateSync(fd, directory + tail.length);
  closeSync(fd);
  const stat = statSync(file);
  if (stat.size <= 4 * GIB) throw new Error("The file must be larger than 4 GiB");
  if (stat.blocks * 512 >= 2 ** 20) throw new Error("The file must be sparse");
}

/** The shape: 2 rows before 4 GiB, and one past it that can be read. */
export function theShape(folder = ""): WrappedRow[] {
  return [
    { name: `${folder}a.bin`, at: 0, size: 2 * GIB },
    { name: `${folder}b.bin`, at: 2 * GIB + 100, size: 2 * GIB + GIB / 2 },
    { name: `${folder}c.txt`, at: 4 * GIB + GIB / 2 + 200, body: "The last row can be read.\n" },
  ];
}

/** The place of the central directory of `theShape`. */
export const DIRECTORY = 4 * GIB + GIB / 2 + 400;

/** A row beside the folder of `theShape("docs/")`. It keeps the listing at
 *  the root. */
export const BESIDE: WrappedRow = { name: "top.txt", at: DIRECTORY - 100, body: "top" };

/**
 * Writes the attack to `file`: `padding` rows with no header move to one low
 * header of 0 bytes and use all reads of the parse. Then the data of
 * `docs/a.txt` holds the header and the data of `docs/b.txt`. Returns these
 * two bodies.
 */
export function writeAttackZip(file: string, padding: number): { a: Buffer; b: Buffer } {
  const at = 4 * GIB + 100_000;
  const b = Buffer.alloc(5_000, 0x62);
  const name = "docs/a.txt";
  const inner: WrappedRow = {
    name: "docs/b.txt",
    at: at + 30 + name.length + 40,
    body: b,
    noHeader: true,
  };
  const a = Buffer.concat([Buffer.alloc(40, 0x2e), localBytes(inner)]);
  const rows: WrappedRow[] = [];
  for (let index = 0; index < padding; index++) {
    rows.push({ name: `low/${String(index).padStart(4, "0")}`, at: 500, noHeader: true });
  }
  rows.push({ name, at, body: a }, inner, { name: "top.txt", at: at + 50_000, body: "top" });
  const directory = at + 100_000;
  writeWrappedZip(file, rows, directory, directory % 2 ** 32, [{ name: "low.bin", at: 500 }]);
  return { a, b };
}
