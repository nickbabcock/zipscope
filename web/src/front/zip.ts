// A small zip writer for the demo archive. It writes local headers, the
// data, the central directory and the end record. Each entry is deflated
// with `CompressionStream`, or stored when deflate does not make it
// smaller. It does not write zip64 records, so the archive must stay below
// 4 GiB and 65,535 entries.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  /** True for a file that has the Unix execute permission. */
  executable?: boolean;
  /** True to store the data without an attempt to deflate it. */
  store?: boolean;
}

export interface ZipOptions {
  /** The modification time of all entries. */
  time: Date;
  /** Bytes after the end record of the archive. */
  trailer?: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Returns the CRC-32 of the bytes. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function dosTime(time: Date): { date: number; time: number } {
  return {
    date:
      ((time.getUTCFullYear() - 1980) << 9) | ((time.getUTCMonth() + 1) << 5) | time.getUTCDate(),
    time: (time.getUTCHours() << 11) | (time.getUTCMinutes() << 5) | (time.getUTCSeconds() >> 1),
  };
}

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** Bit 11: the name is UTF-8. */
const FLAG_UTF8 = 1 << 11;
/** Made by Unix (3), version 3.0. */
const MADE_BY = (3 << 8) | 30;
const NEEDED = 20;

/** Writes the entries as a zip archive. */
export async function writeZip(entries: readonly ZipEntry[], options: ZipOptions): Promise<Blob> {
  const encoder = new TextEncoder();
  const stamp = dosTime(options.time);
  const packed = await Promise.all(
    entries.map(async (entry) => {
      const deflated = entry.store === true ? entry.data : await deflate(entry.data);
      const smaller = deflated.length < entry.data.length;
      return {
        name: encoder.encode(entry.name),
        crc: crc32(entry.data),
        size: entry.data.length,
        method: smaller ? METHOD_DEFLATE : METHOD_STORED,
        body: smaller ? deflated : entry.data,
        mode: entry.executable === true ? 0o100755 : 0o100644,
      };
    }),
  );

  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const entry of packed) {
    const local = new Uint8Array(30 + entry.name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, NEEDED, true);
    view.setUint16(6, FLAG_UTF8, true);
    view.setUint16(8, entry.method, true);
    view.setUint16(10, stamp.time, true);
    view.setUint16(12, stamp.date, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.body.length, true);
    view.setUint32(22, entry.size, true);
    view.setUint16(26, entry.name.length, true);
    local.set(entry.name, 30);

    const central = new Uint8Array(46 + entry.name.length);
    const record = new DataView(central.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, MADE_BY, true);
    record.setUint16(6, NEEDED, true);
    record.setUint16(8, FLAG_UTF8, true);
    record.setUint16(10, entry.method, true);
    record.setUint16(12, stamp.time, true);
    record.setUint16(14, stamp.date, true);
    record.setUint32(16, entry.crc, true);
    record.setUint32(20, entry.body.length, true);
    record.setUint32(24, entry.size, true);
    record.setUint16(28, entry.name.length, true);
    record.setUint32(38, (entry.mode << 16) >>> 0, true);
    record.setUint32(42, offset, true);
    central.set(entry.name, 46);

    parts.push(local, entry.body);
    directory.push(central);
    offset += local.length + entry.body.length;
  }
  const directorySize = directory.reduce((sum, record) => sum + record.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, packed.length, true);
  view.setUint16(10, packed.length, true);
  view.setUint32(12, directorySize, true);
  view.setUint32(16, offset, true);
  const trailer = options.trailer ?? new Uint8Array(0);
  return new Blob([...parts, ...directory, end, trailer] as Uint8Array<ArrayBuffer>[], {
    type: "application/zip",
  });
}
