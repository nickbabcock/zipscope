// Decodes the facts and layout vectors of the read wasm, and
// counts the totals of the listed rows. `facts_vector` and `layout_vector` in
// `crates/read/src/wasm.rs` give the indexes of the vectors.
import type {
  ArchiveFacts,
  ArchiveRegion,
  ArchiveTotals,
  Breakdown,
  ByteMap,
  RegionKind,
  RegionLabel,
  Zip64Use,
} from "../contracts";

/** Values in the facts vector. */
export const FACTS_FIELDS = 30;
/** Counts at the start of the layout vector. */
export const LAYOUT_COUNTS = 10;
/** Values of one region in the layout vector. */
export const REGION_FIELDS = 6;

/** Makes the facts from the facts vector and the comment bytes. */
export function factsOf(vector: ArrayLike<number>, comment: Uint8Array): ArchiveFacts {
  if (vector.length !== FACTS_FIELDS) {
    throw new Error(`The facts vector has ${vector.length} values, expected ${FACTS_FIELDS}`);
  }
  const at = (index: number) => vector[index]!;
  const facts: ArchiveFacts = {
    size: at(0),
    endRecordOffset: at(1),
    endOffset: at(2),
    directoryOffset: at(3),
    directoryEnd: at(29),
    declaredEntries: at(4),
    declaredDirectorySize: at(28),
    zip64: at(5) as Zip64Use,
    spansDisks: at(27) === 1,
    endRecord: {
      disk: at(6),
      directoryDisk: at(7),
      diskEntries: at(8),
      totalEntries: at(9),
      directorySize: at(10),
      directoryOffset: at(11),
      commentLength: at(12),
    },
    comment,
  };
  if (at(13) >= 0) {
    facts.locator = { offset: at(13), disk: at(14), recordOffset: at(15), totalDisks: at(16) };
  }
  if (at(17) >= 0) {
    facts.record = {
      offset: at(17),
      size: at(18),
      versionMadeBy: at(19),
      versionNeeded: at(20),
      disk: at(21),
      directoryDisk: at(22),
      diskEntries: at(23),
      totalEntries: at(24),
      directorySize: at(25),
      directoryOffset: at(26),
    };
  }
  return facts;
}

/** Makes the byte map from the layout vector. */
export function byteMap(vector: ArrayLike<number>): ByteMap {
  const at = (index: number) => vector[index]!;
  if (vector.length < LAYOUT_COUNTS || (vector.length - LAYOUT_COUNTS) % REGION_FIELDS !== 0) {
    return { ok: false, error: `The layout vector has ${vector.length} values` };
  }
  const regions: ArchiveRegion[] = [];
  for (let index = LAYOUT_COUNTS; index < vector.length; index += REGION_FIELDS) {
    regions.push({
      kind: at(index) as RegionKind,
      start: at(index + 1),
      end: at(index + 2),
      label: at(index + 3) as RegionLabel,
      foldedGaps: at(index + 4),
      foldedBytes: at(index + 5),
    });
  }
  return {
    ok: true,
    counts: {
      rows: at(0),
      badHeaders: at(1),
      pastDirectory: at(2),
      intoDirectory: at(3),
      overlapping: at(4),
      missingDescriptors: at(5),
      gaps: at(6),
      gapBytes: at(7),
      otherDiskRows: at(8),
      zip64Rows: at(9),
    },
    regions,
  };
}

/** Makes the totals from the totals vector: the entries, compressed and
 *  uncompressed bytes of all rows, then each breakdown (method,
 *  encryption, creating system) as a group count and four values for each
 *  group (code, entries, compressed, uncompressed). Each breakdown has the
 *  most entries first. */
export function totalsOf(vector: ArrayLike<number>): ArchiveTotals {
  const at = (index: number) => {
    const value = vector[index];
    if (value === undefined) throw new Error(`The totals vector ends at ${index}`);
    return value;
  };
  let index = 3;
  const breakdown = (): Breakdown[] => {
    const count = at(index++);
    const groups: Breakdown[] = [];
    for (let group = 0; group < count; group++) {
      groups.push({
        key: at(index),
        entries: at(index + 1),
        compressed: at(index + 2),
        uncompressed: at(index + 3),
      });
      index += 4;
    }
    return groups.sort((a, b) => b.entries - a.entries || a.key - b.key);
  };
  const methods = breakdown();
  const encryption = breakdown();
  const systems = breakdown();
  return {
    entries: at(0),
    compressed: at(1),
    uncompressed: at(2),
    methods,
    encryption,
    systems,
  };
}
