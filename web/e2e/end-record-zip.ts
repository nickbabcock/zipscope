// Archives with false and extra end records, for the end record tests.
import { panelZip } from "./archive-zip";
import type { PanelZip } from "./archive-zip";

export const SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
/** Two small stored files. */
export const ENTRIES = [
  { name: "a.txt", data: Buffer.from("first file\n") },
  { name: "b.txt", data: Buffer.from("second file\n") },
];

/** A zip of `ENTRIES` with the parts of `spec`. */
export function zip(spec: Partial<PanelZip>): Buffer {
  return panelZip({ entries: ENTRIES, ...spec }).bytes;
}

/** A comment with an end record signature and more bytes than a record. */
export const noteComment = Buffer.concat([
  Buffer.from("note "),
  SIGNATURE,
  Buffer.from(" and more text than an end record needs"),
]);

/** A true archive whose comment holds a fake directory and a fake record. */
export function withFakeRecord(after = Buffer.alloc(0)): Buffer {
  const fake = panelZip({ entries: [{ name: "FAKE.txt", data: Buffer.from("fake") }] });
  const directory = fake.bytes.subarray(fake.directory, fake.end);
  const record = Buffer.alloc(22);
  SIGNATURE.copy(record);
  record.writeUInt16LE(1, 8);
  record.writeUInt16LE(1, 10);
  record.writeUInt32LE(directory.length, 12);
  return zip({ comment: Buffer.concat([directory, record, after]) });
}

/** A true archive with a fake record behind a Zip64 locator in its comment. rawzip
 *  refuses that record, because its classic fields differ from the Zip64 record,
 *  and Python `zipfile` extracts the fake entry. */
export function withFakeBehindLocator(): Buffer {
  const start = zip({}).length;
  const fake = panelZip({ entries: [{ name: "fake.txt", data: Buffer.from("fake data") }] });
  const local = fake.bytes.subarray(0, fake.directory);
  const directory = Buffer.from(fake.bytes.subarray(fake.directory, fake.end));
  directory.writeUInt32LE(start, 42);
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeBigUInt64LE(1n, 24);
  record.writeBigUInt64LE(1n, 32);
  record.writeBigUInt64LE(BigInt(directory.length), 40);
  const directoryAt = start + local.length;
  record.writeBigUInt64LE(BigInt(directoryAt), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(directoryAt + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  SIGNATURE.copy(end);
  end.writeUInt16LE(7, 8);
  end.writeUInt16LE(7, 10);
  end.writeUInt32LE(1, 12);
  end.writeUInt32LE(1, 16);
  return zip({ comment: Buffer.concat([local, directory, record, locator, end]) });
}

/** An archive whose end record declares the directory one or more bytes after it. */
export function withDeclaredAfter(bytes: number): Buffer {
  const archive = panelZip({ entries: ENTRIES });
  const file = Buffer.from(archive.bytes);
  file.writeUInt32LE(archive.directory + bytes, archive.end + 16);
  return file;
}

/** A true archive and, after its end record, an archive of a fake entry. */
export function withAppendedArchive(): Buffer {
  const first = panelZip({ entries: ENTRIES });
  const second = panelZip({
    prelude: first.bytes,
    entries: [{ name: "fake.txt", data: Buffer.from("fake") }],
  });
  return second.bytes;
}

/** The record and the directory of the first archive of `withAppendedArchive`. */
export function firstPlaces(): { record: string; directory: string } {
  const { directory, end } = panelZip({ entries: ENTRIES });
  const hex = (value: number) => `0x${value.toString(16).padStart(8, "0")}`;
  return { record: hex(end), directory: hex(directory) };
}

/** A stored zip in a zip, with a local extra field of 22 bytes that its record
 *  does not have. By the sizes in the record, the row stops before the inner end
 *  record. The local header gives the true end. */
export function withLongLocalExtra(): Buffer {
  const inner = panelZip({ entries: ENTRIES }).bytes;
  const whole = panelZip({ entries: [{ name: "a.zip", data: inner }] });
  const name = 30 + "a.zip".length;
  const local = Buffer.concat([
    whole.bytes.subarray(0, name),
    Buffer.alloc(22),
    whole.bytes.subarray(name, whole.directory),
  ]);
  local.writeUInt16LE(22, 28);
  const rest = Buffer.from(whole.bytes.subarray(whole.directory));
  rest.writeUInt32LE(whole.directory + 22, whole.end - whole.directory + 16);
  return Buffer.concat([local, rest]);
}

/** A tail of 1 MiB of zeros and 20 false end records. Each record has its
 *  own directory places before the bytes that the open keeps, so each one
 *  costs reads. */
export function falseRecordsTail(): Buffer {
  const head = Buffer.alloc(1 << 20);
  const parts: Buffer[] = [head];
  let at = head.length;
  for (let index = 0; index < 20; index++) {
    const record = Buffer.alloc(22);
    SIGNATURE.copy(record);
    record.writeUInt16LE(1, 8);
    record.writeUInt16LE(1, 10);
    record.writeUInt32LE(at - 2000 - index * 100, 12);
    record.writeUInt32LE(30_000 + index * 100, 16);
    parts.push(record);
    at += record.length;
  }
  return Buffer.concat(parts);
}
