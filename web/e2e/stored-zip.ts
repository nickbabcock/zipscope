// Builds small stored zip archives for the e2e tests.

/** Returns a stored zip archive with entries of these sizes. The ingest
 *  reads only the central directory, so the CRC-32 values are 0. With
 *  `declared`, a zip64 end record declares that entry count, which can be
 *  false. */
export function storedZip(entries: [string, number][], declared?: bigint): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [entry, size] of entries) {
    const name = Buffer.from(entry);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, Buffer.alloc(size));
    centrals.push(central, name);
    offset += local.length + name.length + size;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  if (declared === undefined) {
    // A writer with no Zip64 keeps the low 16 bits of the count.
    end.writeUInt16LE(entries.length & 0xffff, 8);
    end.writeUInt16LE(entries.length & 0xffff, 10);
    return Buffer.concat([...locals, directory, end]);
  }
  // The zip64 end record and its locator come before the end record, whose
  // counts then say "see zip64".
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  const zip64 = Buffer.alloc(56);
  zip64.writeUInt32LE(0x06064b50, 0);
  zip64.writeBigUInt64LE(44n, 4);
  zip64.writeUInt16LE(45, 12);
  zip64.writeUInt16LE(45, 14);
  zip64.writeBigUInt64LE(declared, 24);
  zip64.writeBigUInt64LE(declared, 32);
  zip64.writeBigUInt64LE(BigInt(directory.length), 40);
  zip64.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([...locals, directory, zip64, locator, end]);
}
