// Archives with records at exact places, and archives with an entry count
// that does not agree with the rows, for the tests of the format rules.
import { storedZip } from "./stored-zip";

/** One record. `at` is the place of its local header. */
export interface PlacedRow {
  name: string;
  at: number;
  /** The compressed size in the record. */
  size?: number;
}

/** An archive with records at exact places. Each place holds a local header,
 *  and zero bytes fill the rest of the file before the central directory. */
export function placedZip(rows: PlacedRow[], directory: number, stub = Buffer.alloc(0)): Buffer {
  const body = Buffer.alloc(directory);
  const centrals: Buffer[] = [];
  for (const row of rows) {
    const name = Buffer.from(row.name);
    const size = row.size ?? 0;
    body.writeUInt32LE(0x04034b50, row.at);
    body.writeUInt16LE(20, row.at + 4);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(row.at, 42);
    centrals.push(central, name);
  }
  const records = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(rows.length, 8);
  end.writeUInt16LE(rows.length, 10);
  end.writeUInt32LE(records.length, 12);
  end.writeUInt32LE(directory, 16);
  return Buffer.concat([stub, body, records, end]);
}

/** Empty rows at true places, and `declared` in the end record. */
export function countZip(rows: number, declared: number): Buffer {
  const entries: [string, number][] = [];
  for (let index = 0; index < rows; index++) {
    entries.push([`e${index}`, 0]);
  }
  const bytes = storedZip(entries);
  bytes.writeUInt16LE(declared, bytes.length - 22 + 8);
  bytes.writeUInt16LE(declared, bytes.length - 22 + 10);
  return bytes;
}
