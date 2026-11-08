// The contract between the parse worker, the UI and the core wasm: the
// shared-memory layout, the Comlink API and the protocols below.
//
// The Rust side (`crates/core/src/contract.rs`, `health.rs`, `query.rs` and
// `crates/marks`) must have the same values. `contracts.test.ts` compares the
// two through the `contractValues` export of the core wasm. When the layout of
// a header slot, a column or a record changes, increase `LAYOUT_VERSION`. A
// value in a slot or a bit that was reserved does not change the version when
// only the parse worker writes it and only the UI of the same build reads it.
// The health vector goes through a wasm call, so it is not in the layout.
//
// Channels. Data moves through `SharedArrayBuffer` mirrors: the parse worker
// writes them, and the UI reads them on each animation frame. Commands move
// through Comlink: open, new mirror buffers, completion and terminal errors.
// The worker never sends a message for each batch. Cancel is the shared
// `CANCEL` flag, so the worker sees it within one batch.
//
// Append-only data. Column pages and arena chunks never change after they are
// committed, except that `marks` can gain bits. The worker sends each buffer
// one time, so this data needs no lock. A value never spans arena chunks, and
// names go into the arena in row order, so the chunk index of `nameOffset`
// never decreases from one row to the next.
//
// Publish (worker, after each batch, in this order):
//  1. Make new views of wasm memory: a growth replaces its buffer.
//  2. Send each new name and comment chunk with `sink.mirror`, increase its
//     count, and copy the new bytes.
//  3. Send each new page, increase `PAGE_COUNT`, copy the new rows, then copy
//     the `marks` of each row in `markUpdatesPtr` again.
//  4. Copy the new and changed folder records, then store `FOLDER_COUNT`.
//  5. Write the inactive set of the mutable views (see the seqlock below).
//  6. Store `PROGRESS` and `STORE_KIB`. Add 1 to `HEALTH_GENERATION` when
//     the health vector changed.
//  7. `Atomics.store` of `COMMITTED_ROWS`, after all row data.
//  8. Store `ACTIVE_SET`, then add 1 to `VIEW_GENERATION`.
// The terminal `STATE` comes after the last publish, so `COMMITTED_ROWS` is
// final when the UI sees `COMPLETE`. A view request (`list`, `expand`,
// `sort`, `search`) publishes with the same steps.
//
// Read (UI, on each frame): `count = COMMITTED_ROWS >>> 0`, clamped to the
// rows of the pages received with no gap, and then to the first row whose name
// chunk has not arrived (a binary search, because the chunk index never
// decreases). A buffer message can arrive after the count moved into that
// buffer, so the clamp is necessary. Folders clamp the same way. Copy name
// bytes out of the shared buffer before `TextDecoder`, with `ignoreBOM`.
//
// Generation seqlock. The permutations, the flattened trees, the rollups and
// their header slots are double-buffered as one set. The worker writes the
// inactive set, stores `ACTIVE_SET`, then adds 1 to `VIEW_GENERATION`. The UI
// loads the generation, reads the active set, and loads the generation again.
// When it changed, the UI renders again before the browser paints. The worker
// never writes a set again before it published the other set.
//
// Cancel. The UI stores 1 in `CANCEL`. Before each batch, the worker loads it,
// runs the bounded final checks on the prefix, stores `CANCELLED` and resolves
// `finished()`. Wasm memory never shrinks, so the UI terminates the worker to
// free it.
//
// Memory. The parse worker and the read worker are in one renderer process and
// share one hard stop. Each worker reserves memory before it grows, with a
// compare-and-swap on `RESERVED` (see `web/src/memory.ts`). At the soft budget,
// the worker pauses and asks the UI through `sink.confirmMemory`.

/** The version of the shared-memory layout. */
export const LAYOUT_VERSION = 3;

/** Int32 slots in the header. */
export const HEADER_SLOTS = 64;
export const HEADER_BYTES = HEADER_SLOTS * 4;

/** Slot indexes in the header `Int32Array`. Counts are read as unsigned. */
export const Header = {
  /** `LAYOUT_VERSION`. The worker writes it before the header is shared. */
  LAYOUT: 0,
  /** One of `State`. */
  STATE: 1,
  /** Committed rows. The worker stores it last, after the data. */
  COMMITTED_ROWS: 2,
  /** The UI stores 1 to ask the worker to stop. */
  CANCEL: 3,
  /** Parsed part of the central directory, in millionths. */
  PROGRESS: 4,
  /** Column pages that the worker has allocated and sent. */
  PAGE_COUNT: 5,
  /** Name arena chunks that the worker has allocated and sent. */
  NAME_CHUNK_COUNT: 6,
  /** Comment arena chunks that the worker has allocated and sent. */
  COMMENT_CHUNK_COUNT: 7,
  /** Seqlock generation of the mutable views. */
  VIEW_GENERATION: 8,
  /** The active set (0 or 1) of the double-buffered views. */
  ACTIVE_SET: 9,
  /** Permutation length of set 0 and set 1. */
  PERMUTATION_LENGTH_0: 10,
  PERMUTATION_LENGTH_1: 11,
  /** Flattened tree length of set 0 and set 1. */
  TREE_LENGTH_0: 12,
  TREE_LENGTH_1: 13,
  /** Committed folder-table records. */
  FOLDER_COUNT: 14,
  /** Store memory (wasm and all mirrors), in KiB. */
  STORE_KIB: 15,
  /** The folder that the permutation of set 0 and set 1 lists. */
  PERMUTATION_FOLDER_0: 16,
  PERMUTATION_FOLDER_1: 17,
  /** The largest uncompressed size of a row of the permutation of set 0
   *  and set 1, as the bits of a float32. The table scales its size bars
   *  to it. */
  LISTING_LARGEST_0: 18,
  LISTING_LARGEST_1: 19,
  /** Changes when the health report changes. The UI then asks for the
   *  report with `health()`. */
  HEALTH_GENERATION: 20,
  /** Read worker memory (its wasm memory), in KiB. The read worker writes
   *  it. The memory budget counts it with `STORE_KIB`. */
  READ_KIB: 21,
  /** The memory that each worker reserved, in units of
   *  `RESERVATION_UNIT_BYTES`: the parse worker in bits 16 to 31, the read
   *  worker in bits 0 to 15. Both workers change it, only with
   *  `Atomics.compareExchange` (see `memory.ts`). The hard stop applies
   *  to it. */
  RESERVED: 22,
  /** The sort of the permutation of set 0 and set 1: the `SortColumn` in
   *  bits 0 to 7, and `SORT_DESCENDING` for a descending sort. 0 is
   *  archive order, and `BEST_MATCH_ORDER` is the best-match order of a
   *  search. */
  LISTING_SORT_0: 23,
  LISTING_SORT_1: 24,
  /** The number of the largest files below the folder of the permutation
   *  of set 0 and set 1, from 0 to `LARGEST_FILES`. Their
   *  store rows follow the listing in the permutation buffer of the set. */
  LARGEST_FILES_0: 25,
  LARGEST_FILES_1: 26,
  /** The order of the flattened tree of set 0 and set 1, a `TreeOrder`. */
  TREE_ORDER_0: 27,
  TREE_ORDER_1: 28,
} as const;

/** The values of `TREE_ORDER_n`. */
export const TreeOrder = {
  /** The order that the parser first saw the folders. */
  ARCHIVE: 0,
  /** Name order, with the comparison of the table. */
  NAME: 1,
} as const;
export type TreeOrder = (typeof TreeOrder)[keyof typeof TreeOrder];

/** The most largest files that a set holds. */
export const LARGEST_FILES = 10;

/** The bit of `LISTING_SORT_n` for a descending sort. */
export const SORT_DESCENDING = 0x100;

/** The value of `LISTING_SORT_n` for a search in the best-match order. It is
 *  no column: `sort` does not take it. */
export const BEST_MATCH_ORDER = 7;

export const State = {
  OPENING: 0,
  PARSING: 1,
  COMPLETE: 2,
  CANCELLED: 3,
  FAILED: 4,
  PAUSED: 5,
} as const;
export type State = (typeof State)[keyof typeof State];

/** Rows in one column page. */
export const PAGE_ROWS = 1 << 16;
/** The memory budget: wasm memory and all mirrors, in bytes. At the soft
 *  budget the worker pauses and asks to continue. At the hard stop it stops
 *  and keeps the partial listing. */
export const SOFT_BUDGET_BYTES = 2 ** 30;
export const HARD_BUDGET_BYTES = 2 ** 31;
/** The most memory that the hard stop keeps for the read worker. The hard
 *  stop counts the larger of the read worker memory and the reserve, so
 *  the parse worker stops early enough for a preview after the stop. */
export const READ_RESERVE_BYTES = 96 * 2 ** 20;

/** The least reserve: the read worker uses a few MiB when it starts,
 *  before it can check the limit (1.7 to 3.6 MiB in the tests), and a
 *  first preview reads 1 MiB. */
export const READ_RESERVE_MIN_BYTES = 8 * 2 ** 20;

/** The read worker reserve for a hard stop: one eighth of the hard stop,
 *  from `READ_RESERVE_MIN_BYTES` to `READ_RESERVE_BYTES`. */
export function readReserve(hardBytes: number): number {
  const eighth = Math.floor(hardBytes / 8);
  return Math.min(READ_RESERVE_BYTES, Math.max(READ_RESERVE_MIN_BYTES, eighth));
}
/** The most that the read worker memory grows in one wasm call, a fixed
 *  bound for every archive: one read of 16 MiB, one new Zstandard window of
 *  32 MiB, and 2 MiB for the decoder buffers and the free room of a step.
 *  A scan step grows the wayfinder table by at most one chunk (2.5 MiB).
 *  The read worker publishes `READ_KIB` after each call. */
export const READ_CALL_GROWTH_BYTES = 50 * 2 ** 20;
/** The unit of the reservations in `Header.RESERVED`: one wasm page. */
export const RESERVATION_UNIT_BYTES = 65_536;
/** The slack that the parse worker reserves for the allocations of the
 *  core wasm that cannot fail (`setMemorySlack`). */
export const STORE_GROWTH_SLACK_BYTES = 2 ** 20;
/** The slack that the read worker reserves for the same purpose. */
export const READ_GROWTH_SLACK_BYTES = 256 * 1024;
/** Bits for the position in an arena chunk. */
export const CHUNK_BITS = 22;
/** Bytes in one arena chunk (4 MiB). */
export const CHUNK_BYTES = 1 << CHUNK_BITS;

type ColumnType = "f64" | "u32" | "u16" | "u8";

interface ColumnSpec {
  name: string;
  type: ColumnType;
}

const WIDTH: Record<ColumnType, number> = { f64: 8, u32: 4, u16: 2, u8: 1 };

/** The columns of a page, in page order. The index is the column id. */
export const COLUMNS = [
  { name: "uncompressedSize", type: "f64" },
  { name: "compressedSize", type: "f64" },
  { name: "localHeaderOffset", type: "f64" },
  { name: "modified", type: "f64" },
  { name: "nameOffset", type: "u32" },
  { name: "nameLength", type: "u32" },
  { name: "commentOffset", type: "u32" },
  { name: "commentLength", type: "u32" },
  { name: "crc32", type: "u32" },
  { name: "externalAttributes", type: "u32" },
  { name: "method", type: "u16" },
  { name: "flags", type: "u16" },
  { name: "versionMadeBy", type: "u16" },
  { name: "aesMethod", type: "u16" },
  { name: "nameSource", type: "u8" },
  { name: "timeKind", type: "u8" },
  { name: "encryption", type: "u8" },
  { name: "marks", type: "u8" },
] as const satisfies readonly ColumnSpec[];

export type ColumnName = (typeof COLUMNS)[number]["name"];

export interface ColumnLayout {
  id: number;
  name: ColumnName;
  type: ColumnType;
  width: number;
  /** Byte offset of row 0 in the page. */
  byteOffset: number;
}

export const COLUMN_LAYOUT: readonly ColumnLayout[] = (() => {
  let byteOffset = 0;
  return COLUMNS.map((column, id) => {
    const width = WIDTH[column.type];
    const layout = { id, name: column.name, type: column.type, width, byteOffset };
    byteOffset += width * PAGE_ROWS;
    return layout;
  });
})();

export const COLUMN_ID = Object.fromEntries(COLUMN_LAYOUT.map((c) => [c.name, c.id])) as Record<
  ColumnName,
  number
>;

/** Bytes in one page. */
export const PAGE_BYTES = COLUMN_LAYOUT.reduce((total, c) => total + c.width * PAGE_ROWS, 0);

/** Returns a typed view of one column in a page buffer. */
export function columnView(page: ArrayBufferLike, column: ColumnLayout) {
  switch (column.type) {
    case "f64":
      return new Float64Array(page, column.byteOffset, PAGE_ROWS);
    case "u32":
      return new Uint32Array(page, column.byteOffset, PAGE_ROWS);
    case "u16":
      return new Uint16Array(page, column.byteOffset, PAGE_ROWS);
    case "u8":
      return new Uint8Array(page, column.byteOffset, PAGE_ROWS);
  }
}

/** Values of the `nameSource` column. */
export const NameSource = {
  UTF8_FLAG: 0,
  UTF8: 1,
  UNICODE_PATH: 2,
  CP437: 3,
  LOSSY: 4,
} as const;

/** Values of the `timeKind` column. */
export const TimeKind = {
  NONE: 0,
  /** No time zone, 2-second precision, stored as if UTC. */
  DOS: 1,
  EXTENDED: 2,
  NTFS: 3,
  UNIX: 4,
} as const;

/** Values of the `encryption` column. The low 7 bits are the kind. */
export const Encryption = {
  NONE: 0,
  ZIP_CRYPTO: 1,
  AES_128: 2,
  AES_192: 3,
  AES_256: 4,
  OTHER: 5,
  AES_UNKNOWN: 6,
  /** Set with an AES kind for AE-2. */
  AE2: 0x80,
} as const;

/** Bits of the `marks` column. */
export const Marks = {
  DUPLICATE_NAME: 1 << 0,
  DEPTH_CAP: 1 << 1,
  BOMB_RATIO: 1 << 2,
  OVERLAP: 1 << 3,
  RAW_NAME_KEPT: 1 << 4,
  FOLDER_CAP: 1 << 5,
  CONTROL_NAME: 1 << 6,
  WRAPPED_OFFSET: 1 << 7,
} as const;

/** Why a row with `Marks.WRAPPED_OFFSET` is not read: in a preview, in an
 *  extraction report and in the report of a zstd copy. The offset of the
 *  row wrapped at 4 GiB, so it is not at the offset that rawzip reads. */
export const WRAPPED_REASON =
  "This entry cannot be read here. The archive is over 4 GiB and was written without Zip64, the format that large archives need, so its central directory does not give the true place of this entry";

/** Indexes of the health vector of `parser.health()`. An example is the
 *  first row with the finding, or -1. */
export const HealthField = {
  DECLARED_ENTRIES: 0,
  COUNT_MISMATCH: 1,
  DUPLICATE_ROWS: 2,
  DUPLICATE_EXAMPLE: 3,
  BOMB_ROWS: 4,
  BOMB_EXAMPLE: 5,
  OVERLAP_ROWS: 6,
  OVERLAP_EXAMPLE: 7,
  DEPTH_CAP_ROWS: 8,
  DEPTH_CAP_EXAMPLE: 9,
  FOLDER_CAP_ROWS: 10,
  FOLDER_CAP_EXAMPLE: 11,
  PRELUDE_BYTES: 12,
  EPILOGUE_BYTES: 13,
  OVERLAPS_CHECKED: 14,
  /** Rows for each encryption kind 1 to 6, at `ENCRYPTED + kind - 1`. */
  ENCRYPTED: 15,
  DUPLICATES_CHECKED: 21,
  CONTROL_NAME_ROWS: 22,
  CONTROL_NAME_EXAMPLE: 23,
  WRAPPED_ROWS: 24,
  WRAPPED_EXAMPLE: 25,
  COMMENT_DECLARED: 26,
  COMMENT_PRESENT: 27,
  END_SKIPPED: 28,
  END_OTHERS: 29,
  END_UNCHECKED: 30,
  END_SECOND_DIRECTORY: 31,
  COUNT_WRAPPED: 32,
  INTO_DIRECTORY_ROWS: 33,
  INTO_DIRECTORY_EXAMPLE: 34,
  OVERLAP_DATA_ROWS: 35,
  OVERLAP_DATA_EXAMPLE: 36,
  END_DECLARED_DIRECTORY: 37,
  END_FOUND_DIRECTORY: 38,
  END_EARLIER_RECORDS: 39,
  END_EARLIER_RECORD: 40,
  END_EARLIER_DIRECTORY: 41,
} as const;
export const HEALTH_FIELDS = 42;

// Folder table and mutable views ---------------------------------------

/** An absent folder id or row: the parent of the root and the explicit row
 *  of an implied folder. */
export const NONE = 0xffffffff;
/** The folder id of the archive root. */
export const ROOT = 0;
/** Bit 31 of a tagged index. When it is set, bits 0 to 30 are a folder id.
 *  If not, the value is an entry row. */
export const FOLDER_TAG = 0x80000000;

const float32 = new Float32Array(1);
const float32Bits = new Int32Array(float32.buffer);

/** Returns the bits of a number as a float32, for a header slot. */
export function toFloat32Bits(value: number): number {
  float32[0] = value;
  return float32Bits[0]!;
}

/** Returns the number in the float32 bits of a header slot. */
export function fromFloat32Bits(bits: number): number {
  float32Bits[0] = bits;
  return float32[0]!;
}

/** Bytes in one folder record: nameOffset, nameLength, parent, explicitRow
 *  (u32 each). */
export const FOLDER_RECORD_BYTES = 16;
/** Bytes in one rollup record: uncompressedSize, compressedSize,
 *  entryCount (f64 each). */
export const ROLLUP_RECORD_BYTES = 24;
/** u32 words in one flattened tree record: tagged index, info, position,
 *  set size. */
export const TREE_RECORD_WORDS = 4;

/** Bits of word 1 (info) of a flattened tree record. */
export const TreeInfo = {
  /** Bits 0 to 14: the level. The root row is level 0. */
  LEVEL_MASK: 0x7fff,
  /** Bits 15 to 29: the folders in the row, minus 1. */
  CHAIN_SHIFT: 15,
  CHAIN_MASK: 0x7fff,
  /** Bit 30: the last folder of the row has child folders. */
  HAS_CHILDREN: 1 << 30,
  /** Bit 31: the row shows its child rows. */
  EXPANDED: 0x80000000,
} as const;

/** Sort columns of the listing, as `sort` takes them. */
export const SortColumn = {
  /** Archive order: folders by id, rows by row. */
  ARCHIVE: 0,
  NAME: 1,
  SIZE: 2,
  COMPRESSED: 3,
  RATIO: 4,
  METHOD: 5,
  MODIFIED: 6,
} as const;
export type SortColumn = (typeof SortColumn)[keyof typeof SortColumn];

// Comlink API --------------------------------------------------------------

/** A mirror buffer that the worker hands to the UI one time. */
export type Mirror =
  | { kind: "page"; index: number; buffer: SharedArrayBuffer }
  | { kind: "nameChunk"; index: number; buffer: SharedArrayBuffer }
  | { kind: "commentChunk"; index: number; buffer: SharedArrayBuffer }
  | { kind: "folders"; buffer: SharedArrayBuffer }
  | { kind: "rollups"; set: 0 | 1; buffer: SharedArrayBuffer }
  | { kind: "permutation"; set: 0 | 1; buffer: SharedArrayBuffer }
  | { kind: "permutationInfo"; set: 0 | 1; buffer: SharedArrayBuffer }
  | { kind: "tree"; set: 0 | 1; buffer: SharedArrayBuffer };

/**
 * The UI side of the control plane. The UI passes it to `open` through
 * `Comlink.proxy`. The worker calls it only when it allocates a mirror
 * buffer, never for each batch.
 */
export interface MirrorSink {
  mirror(mirror: Mirror): void;
  /**
   * The memory-budget prompt. The worker calls it one time, when the store
   * memory reaches the soft budget, and waits. Resolve true to continue to
   * the hard stop, false to cancel. Without it, the worker continues.
   */
  confirmMemory?(usage: MemoryUsage): Promise<boolean>;
}

/** The committed rows and the store memory in bytes at the soft budget. */
export interface MemoryUsage {
  rows: number;
  bytes: number;
}

export interface OpenInfo {
  /** The header. The UI reads it on each animation frame. */
  header: SharedArrayBuffer;
  /** The entry count from the end of central directory record (a hint). */
  entriesHint: number;
}

/** How parsing ended. The worker keeps the rows parsed before the end. */
export type ParseOutcome =
  | { kind: "complete"; rows: number }
  | { kind: "cancelled"; rows: number }
  | { kind: "failed"; rows: number; message: string };

/** The memory budget in bytes. */
export interface MemoryBudget {
  soft: number;
  hard: number;
}

export interface OpenOptions {
  /** Only for tests. The default is `SOFT_BUDGET_BYTES` and
   *  `HARD_BUDGET_BYTES`. */
  budget?: MemoryBudget;
  /** Only for tests: the budget refuses each view request after its
   *  change, as when the growth of its listing does not fit below the hard
   *  stop. The e2e tests use it so that they do not depend on the memory
   *  that the store uses. With a kind, it refuses only the requests of
   *  that kind; after the first refusal, the worker refuses each request,
   *  as at the hard stop. */
  refuseViews?: boolean | RefusedView;
}

/** The rows with one finding and the first of them (-1 for none). */
export interface RowFinding {
  rows: number;
  example: number;
}

/** What the health panel shows. */
export interface HealthReport {
  /** Rows in the store. */
  rows: number;
  /** The entry count from the end of central directory record. */
  declaredEntries: number;
  /** Parsing is complete and the declared count is not the row count, and
   *  `countWrapped` is false. */
  countMismatch: boolean;
  /** Parsing is complete, the archive has no Zip64 locator, and the declared
   *  count is the row count in 16 bits, but not the row count. */
  countWrapped: boolean;
  duplicates: RowFinding;
  bombs: RowFinding;
  /** Rows with `marks` bit 3: the range of the row overlaps another range. */
  overlaps: RowFinding;
  /** The rows of `overlaps` with data whose range overlaps the range of another
   *  row with data. */
  overlapData: RowFinding;
  /** Rows whose local header of 30 bytes and data run into the central
   *  directory. No bit of `marks` holds this finding. */
  intoDirectory: RowFinding;
  depthCap: RowFinding;
  folderCap: RowFinding;
  /** Rows whose name has a character that shows as a mark. */
  controlNames: RowFinding;
  /** Rows of an archive over 4 GiB with no Zip64 whose offset wrapped, so
   *  they cannot be read. */
  wrapped: RowFinding;
  /** The overlap check covers all rows. It is complete after parsing. */
  overlapsChecked: boolean;
  /** The duplicate check covers all rows. It runs after parsing. */
  duplicatesChecked: boolean;
  /** Bytes before the first local header. */
  preludeBytes: number;
  /** Bytes after the end of central directory record and its comment. */
  epilogueBytes: number;
  /** What the walk to the end record saw. */
  endRecord: {
    /** The length that the record declares for its comment, when the end of
     *  the file cut it. Else 0. */
    commentDeclared: number;
    /** The bytes of a cut comment that are in the file. */
    commentPresent: number;
    /** The end signatures after the chosen record with no other directory at a
     *  place that they give. */
    skipped: number;
    /** The other records with a central directory at a place that they give:
     *  after the chosen record, before it with the chosen record in their comment,
     *  or before a chosen record with no entries. */
    others: number;
    /** The other records of that shape that were not checked. */
    unchecked: number;
    /** The chosen record also gives a place with another directory. */
    secondDirectory: boolean;
    /** The directory offset that the chosen record declares, when it is after
     *  the central directory. Else 0. */
    declaredDirectory: number;
    /** The place of the central directory, when `declaredDirectory` is set. */
    foundDirectory: number;
    /** The records before the chosen record with a central directory, when no
     *  entry covers them. */
    earlierRecords: number;
    /** The place of the first of them, the nearest to the chosen record. */
    earlierRecord: number;
    /** The place of the central directory of that record. */
    earlierDirectory: number;
  };
  /** Encrypted rows by kind. */
  encrypted: {
    zipCrypto: number;
    aes128: number;
    aes192: number;
    aes256: number;
    other: number;
    aesUnknown: number;
  };
  /** The terminal parse error, if parsing failed. */
  error?: string;
  budget: {
    limits: MemoryBudget;
    /** Store memory at the last publish. */
    storeBytes: number;
    /** Parsing paused at the soft budget. */
    softReached: boolean;
    /** The user did not continue at the soft budget. */
    declined: boolean;
    /** Parsing stopped at the hard stop. */
    hardReached: boolean;
    /** True when the memory limit left no room to add rows to the published
     *  listing, and the status counts these rows. */
    rowsMissing: boolean;
    /** The kind of the last view request that the hard stop refused, if
     *  one was refused. The worker did not publish its listing. */
    refused?: RefusedView;
  };
}

/** The kind of a view request: a sort, a search, or a folder change (list,
 *  expand and expand in place). */
export type RefusedView = "sort" | "search" | "folder";

/** The parse worker API, exposed with `Comlink.expose`. One archive per worker. */
export interface ParseWorkerApi {
  /**
   * Opens the archive and starts to parse it. Resolves when the end of the
   * central directory is found. Rejects when the file is not a zip archive.
   */
  open(file: File, sink: MirrorSink, options?: OpenOptions): Promise<OpenInfo>;
  /**
   * Resolves one time, when parsing ends: complete, cancelled (the
   * acknowledgement of the `CANCEL` flag), or failed (the terminal error).
   */
  finished(): Promise<ParseOutcome>;
  /** Loads the core wasm before an archive opens. The front door calls it
   *  in idle time, so that a later open does not need the network. */
  warm(): Promise<void>;
  /**
   * Lists a folder in the permutation and expands its ancestors in the
   * tree. The listing then stops following the end of the root chain.
   * Resolves when the views are published. Rejects for an unknown folder.
   */
  list(folder: number): Promise<void>;
  /**
   * Expands or collapses the tree row whose last folder is `folder`.
   * Resolves when the views are published. Rejects for an unknown folder.
   */
  expand(folder: number, open: boolean): Promise<void>;
  /** Returns the health report, including a failed open attempt. Rejects
   *  until the open attempt has a result. */
  health(): Promise<HealthReport>;
  /**
   * Opens or closes the table row whose last folder is `folder` in place.
   * With `deep`, all folders below it change too. Listing another folder
   * closes all rows. Resolves when the views are published. Rejects for an
   * unknown folder.
   */
  expandInline(folder: number, open: boolean, deep: boolean): Promise<void>;
  /**
   * Returns the folder that lists a row: for an entry, the folder of the
   * entry; for the explicit row of a folder, that folder with
   * `FOLDER_TAG`. Returns `NONE` for a row that is not parsed. "Show in
   * tree" uses it, so the UI does not decode names.
   */
  entryFolder(row: number): Promise<number>;
  /**
   * Sorts the listing: folders first, then entries, each by the column.
   * Items with no value come last in both directions. Equal items stay in
   * archive order. This is a choice of the user, also archive order: it ends
   * the best-match order for this archive. Resolves when the sorted listing
   * is published. Rejects for an unknown column.
   */
  sort(column: SortColumn, descending: boolean): Promise<void>;
  /** Ends a listing that is still in steps after the parse: the default sort
   *  that the parse started, or a listing that a stopped parse left. Resolves
   *  when it is published, and at once when none is left. */
  settleListing(): Promise<void>;
  /** Resolves when the job of the tree order ended and its result is
   *  published, or at once when no job runs. It also resolves when the job
   *  stopped at the memory limit: the tree then stays in archive order. */
  settleTreeOrder(): Promise<void>;
  /**
   * Lists the rows whose name contains `query` (ASCII letters in either
   * case), from the whole archive: in the sort that the user chose, else in
   * the best-match order. The permutation folder is then `NONE`. An empty
   * query lists the selected folder again.
   * Resolves when the results for the parsed rows are published.
   */
  search(query: string): Promise<void>;
}

// The read worker. It loads lazily, on the first preview, with
// its own wasm bundle. It gets the File and the shared mirrors; it never
// talks to the parse worker.

/** Bits of `EntryCheck.mismatches`: where the local header disagrees with
 *  the central directory. */
export const LocalMismatch = {
  NAME: 1 << 0,
  /** Not checked when a data descriptor holds the sizes. */
  SIZES: 1 << 1,
  /** Not checked when a data descriptor holds the CRC-32. */
  CRC: 1 << 2,
  METHOD: 1 << 3,
} as const;

/** What the read worker found for a row before it decoded the data. */
export interface EntryCheck {
  /** `LocalMismatch` bits. 0 when the local header agrees. */
  mismatches: number;
  /** The name in the local header (lossy UTF-8), when it was read. */
  localName: string;
  /** Why the data cannot be decoded (encrypted, an unknown method, no
   *  local header), or undefined. */
  error?: string;
}

/** One step of decoded entry data. */
export interface ReadChunk {
  row: number;
  /** The decoded bytes, from `offset` in the entry. */
  bytes: Uint8Array;
  offset: number;
  /** `reading`: more bytes can follow. `verified`: the data ended, and its
   *  size and CRC-32 agree with the central directory. `failed`: decoding
   *  stopped at `error`; the bytes before it are not verified. */
  state: "reading" | "verified" | "failed";
  error?: string;
  check: EntryCheck;
}

// The Archive panel. The read worker reads the records at the
// end of the archive and maps each byte of the file to one region.

/** The kind of a region of the byte map. */
export const RegionKind = {
  /** Bytes before the first local header. */
  PRELUDE: 0,
  /** Local headers, entry data and data descriptors of listed rows. */
  ENTRIES: 1,
  /** Bytes between entries, or before the central directory, that no
   *  listed row uses. */
  GAP: 2,
  DIRECTORY: 3,
  ZIP64_RECORD: 4,
  ZIP64_LOCATOR: 5,
  /** The end of central directory record and the archive comment. */
  END_RECORD: 6,
  /** Bytes after the archive comment. */
  EPILOGUE: 7,
} as const;
export type RegionKind = (typeof RegionKind)[keyof typeof RegionKind];

/** What the sniffer found in a prelude, a gap or an epilogue. */
export const RegionLabel = {
  NONE: 0,
  WINDOWS_PROGRAM: 1,
  LINUX_PROGRAM: 2,
  MAC_PROGRAM: 3,
  SHELL_SCRIPT: 4,
  APK_SIGNING_BLOCK: 5,
  ZEROS: 6,
  LOCAL_HEADER: 7,
  DIRECTORY_RECORD: 8,
  END_RECORD: 9,
} as const;
export type RegionLabel = (typeof RegionLabel)[keyof typeof RegionLabel];

/** How the archive end uses zip64. */
export const Zip64Use = {
  /** No zip64 locator before the end record. */
  NONE: 0,
  /** The zip64 end record gives the central directory. */
  USED: 1,
  /** A zip64 locator is there, but its record is missing or does not
   *  agree with the end record, so the reader does not use it. */
  IGNORED: 2,
} as const;
export type Zip64Use = (typeof Zip64Use)[keyof typeof Zip64Use];

/** The fields of the end of central directory record, as written. */
export interface EndRecordFields {
  disk: number;
  directoryDisk: number;
  diskEntries: number;
  totalEntries: number;
  directorySize: number;
  directoryOffset: number;
  commentLength: number;
}

/** The zip64 end of central directory locator, as written. */
export interface Zip64LocatorFields {
  /** Where the locator is in the file. */
  offset: number;
  disk: number;
  recordOffset: number;
  totalDisks: number;
}

/** The fixed fields of the zip64 end of central directory record. */
export interface Zip64RecordFields {
  /** Where the record is in the file. */
  offset: number;
  size: number;
  versionMadeBy: number;
  versionNeeded: number;
  disk: number;
  directoryDisk: number;
  diskEntries: number;
  totalEntries: number;
  directorySize: number;
  directoryOffset: number;
}

/** The facts of the archive end. Values above 2^53 are not exact; they
 *  come only from hostile fields and are for display. */
export interface ArchiveFacts {
  size: number;
  endRecordOffset: number;
  /** The offset after the archive comment. */
  endOffset: number;
  /** The central-directory offset that the reader uses. */
  directoryOffset: number;
  /** The end of the central directory: the zip64 record or the end
   *  record. */
  directoryEnd: number;
  /** The entry count that the reader uses (a hint only). */
  declaredEntries: number;
  /** The central-directory size that the archive declares. */
  declaredDirectorySize: number;
  zip64: Zip64Use;
  /** True when a disk field says that the archive has more than one disk. */
  spansDisks: boolean;
  endRecord: EndRecordFields;
  locator?: Zip64LocatorFields;
  record?: Zip64RecordFields;
  /** The raw bytes of the archive comment. */
  comment: Uint8Array;
}

/** One region of the byte map. The regions are in file order and cover
 *  the file from 0 to its size without overlap. */
export interface ArchiveRegion {
  kind: RegionKind;
  start: number;
  end: number;
  label: RegionLabel;
  /** For entry data: the gaps in it that the map does not list one by
   *  one, and their bytes. */
  foldedGaps: number;
  foldedBytes: number;
}

/** Counts of the rows of the byte map. */
export interface LayoutCounts {
  rows: number;
  /** Rows whose local header is missing or has no signature. */
  badHeaders: number;
  /** Rows whose local header offset is in or after the central
   *  directory. */
  pastDirectory: number;
  /** Rows whose data runs into the central directory. */
  intoDirectory: number;
  /** Rows that start before an earlier row ends. */
  overlapping: number;
  /** Rows with a data descriptor flag whose descriptor was not found. */
  missingDescriptors: number;
  gaps: number;
  gapBytes: number;
  /** Rows whose central-directory record gives a start disk that is not
   *  0: a sign of a spanned archive. */
  otherDiskRows: number;
  /** Rows that use zip64: a marker or a zip64 extra field in the
   *  central-directory record or the local header, or a size or offset
   *  of 0xffffffff or more (APPNOTE 4.5.3). */
  zip64Rows: number;
}

export type ByteMap =
  | { ok: true; counts: LayoutCounts; regions: ArchiveRegion[] }
  | { ok: false; error: string };

/** Entries, uncompressed bytes and compressed bytes of one group. */
export interface Breakdown {
  /** The method, the encryption kind (low 7 bits) or the creating OS. */
  key: number;
  entries: number;
  uncompressed: number;
  compressed: number;
}

/** The totals of the listed rows, with breakdowns. Each breakdown has the
 *  most entries first. */
export interface ArchiveTotals {
  entries: number;
  uncompressed: number;
  compressed: number;
  /** By the method of the central directory (99 for AES). */
  methods: Breakdown[];
  encryption: Breakdown[];
  /** By the high byte of "version made by". */
  systems: Breakdown[];
}

export interface ArchiveLayout {
  /** The parse state when the map was made: COMPLETE, CANCELLED or
   *  FAILED. */
  state: State;
  totals: ArchiveTotals;
  map: ByteMap;
}

/** The read worker API, exposed with `Comlink.expose`. One archive per
 *  worker. */
export interface ReadWorkerApi {
  /**
   * Finds the archive in the file and starts the pass over the central
   * directory. `header` and `pages` are the shared mirrors of the parse
   * worker. `options.budget` is the budget of the parse worker (only for
   * tests): the read worker stays below its hard stop. Rejects when the
   * file is not a zip archive.
   */
  open(
    file: File,
    header: SharedArrayBuffer,
    pages: readonly SharedArrayBuffer[],
    options?: OpenOptions,
  ): Promise<void>;
  /** Loads the read wasm before an archive opens. The front door calls it
   *  in idle time, so that a later preview does not need the network. */
  warm(): Promise<void>;
  /** Gives a column page that the parse worker sent after `open`. */
  page(index: number, buffer: SharedArrayBuffer): Promise<void>;
  /** Resolves when the pass over the central directory does not run. The
   *  UI then reads `READ_KIB` again. */
  settled(): Promise<void>;
  /**
   * Decodes up to `bytes` bytes of a committed row from `offset`. A read
   * that starts where the last read of the row ended continues its
   * stream; another offset decodes the row again from the start. The
   * first read of a row checks its local header. Rejects for a row that
   * is not committed, or when the mirrors and the central directory do not
   * agree about the row.
   */
  read(row: number, offset: number, bytes: number): Promise<ReadChunk>;
  /** Reads the records at the end of the archive. */
  facts(): Promise<ArchiveFacts>;
  /**
   * Maps each byte of the file to a region and counts the totals of the
   * listed rows. It reads the local header of each row, in
   * steps with a yield between them. Rejects until parsing ended. The
   * worker keeps the result, so a second call returns it at once.
   */
  layout(): Promise<ArchiveLayout>;
  /**
   * Counts the totals with no byte map. It rejects until parsing ended. It
   * reads no bytes of the file for its rows, so the panel has its method table
   * before the byte map. The answer is kept.
   */
  totals(): Promise<ArchiveTotals>;
  /** Gives a chunk of the name arena. The read worker reads
   *  the names of the rows that it extracts. */
  names(index: number, buffer: SharedArrayBuffer): Promise<void>;
  /**
   * Makes the plan of an extraction: the safe output names,
   * the skipped rows and the declared sizes. A folder plan rejects until
   * parsing ended. The worker keeps the plan for `extract`.
   */
  plan(target: ExtractTarget): Promise<ExtractPlanInfo>;
  /**
   * Writes the files of a plan to `sink` through the verifying reader.
   * `progress` is the progress buffer (`ExtractProgress`). Resolves with
   * the report, also when the extraction failed or was cancelled. One
   * extraction at a time; a second call rejects.
   */
  extract(plan: number, sink: ExtractSink, progress: SharedArrayBuffer): Promise<ExtractReport>;
  /** Frees a plan that the user did not extract. */
  dropPlan(plan: number): Promise<void>;
}

// Extraction. The read worker decodes and writes; the UI picks
// the place and shows the progress and the report.

/** What to extract: one entry, or the rows below a folder. `path` is the
 *  folder path as the tree gives it, with `/` after each segment. An
 *  empty path is the whole archive. */
export type ExtractTarget = { kind: "entry"; row: number } | { kind: "folder"; path: string };

/** Where the read worker writes an extraction. */
export type ExtractSink =
  /** One entry, to the file that `showSaveFilePicker` gave. */
  | { kind: "file"; handle: FileSystemFileHandle }
  /** A folder, to a new folder `name` in the folder that
   *  `showDirectoryPicker` gave. A name that is used gets a suffix. */
  | { kind: "directory"; handle: FileSystemDirectoryHandle; name: string }
  /** The bytes of one entry, or one zip of a folder, to a service-worker
   *  download (`DownloadMessage`). Transfer the port. */
  | { kind: "stream"; port: MessagePort }
  /** The same bytes as `stream`, in a Blob (the fallback without a
   *  service worker). */
  | { kind: "blob" };

/** The plan of an extraction. */
export interface ExtractPlanInfo {
  id: number;
  target: ExtractTarget;
  /** The safe file name of the entry, or the safe name of the output
   *  folder (the zip name without `.zip`). */
  name: string;
  /** The files to write and the folders to make. */
  files: number;
  folders: number;
  /** The declared uncompressed and compressed bytes of the files. */
  bytes: number;
  compressed: number;
  /** Files that declare more than `EXTRACT_CONFIRM_BYTES`. */
  large: number;
  /** Files that declare at least `EXTRACT_RATIO_MIN_BYTES` and more than
   *  `EXTRACT_CONFIRM_RATIO` times their compressed bytes. */
  bombs: number;
  /** The largest declared size of one file. */
  largest: number;
  /** Rows that the plan skips, and files or folders that it renames. */
  skipped: number;
  renamed: number;
  /** Why a zip of this plan does not fit below the memory limit, or
   *  undefined. */
  zipError?: string;
}

/** A declared size above this needs confirmation (1 GiB). */
export const EXTRACT_CONFIRM_BYTES = 2 ** 30;
/** A ratio of uncompressed to compressed bytes above this needs
 *  confirmation, for a file of at least `EXTRACT_RATIO_MIN_BYTES`. */
export const EXTRACT_CONFIRM_RATIO = 100;
/** The smallest declared size for the ratio rule (16 MiB). A small file
 *  with a high ratio, for example a text file of a few KiB, is not a
 *  risk. The bomb-like health finding uses the same rule
 *  (`BOMB_MIN_BYTES` in crates/core). */
export const EXTRACT_RATIO_MIN_BYTES = 16 * 2 ** 20;
/** True when a file with a ratio above `EXTRACT_CONFIRM_RATIO` declares
 *  at least `EXTRACT_RATIO_MIN_BYTES` (a file with no compressed bytes
 *  has an infinite ratio). */
export function isBombLike(bytes: number, compressed: number): boolean {
  return bytes >= EXTRACT_RATIO_MIN_BYTES && bytes > compressed * EXTRACT_CONFIRM_RATIO;
}
/** True when a file of `bytes` declared bytes and `compressed`
 *  compressed bytes needs confirmation: more than 1 GiB, or bomb-like
 *  (`isBombLike`). */
export function fileNeedsConfirmation(bytes: number, compressed: number): boolean {
  return bytes > EXTRACT_CONFIRM_BYTES || isBombLike(bytes, compressed);
}

/** The most items that a report lists. It counts the others. */
export const MAX_REPORT_ITEMS = 10_000;

/** Why a row was not written (`sanitize::Skip` in crates/read). */
export const ExtractSkip = {
  TRAVERSAL: 1,
  ABSOLUTE: 2,
  DRIVE_LETTER: 3,
  NUL: 4,
  LINK: 5,
  TOO_LONG: 6,
  TOO_DEEP: 7,
  NO_NAME: 8,
  ENCRYPTED: 9,
  METHOD: 10,
  LOCAL_HEADER: 11,
  VERIFY: 12,
  WRITE: 13,
  MEMORY: 14,
  CANCELLED: 15,
} as const;
export type ExtractSkip = (typeof ExtractSkip)[keyof typeof ExtractSkip];

/** Bits of a rename (`sanitize::renamed` in crates/read). */
export const Renamed = {
  RESERVED: 1,
  CHARACTERS: 2,
  TRAILING: 4,
  TRUNCATED: 8,
  COLLISION: 16,
} as const;

/** One line of the extraction report: a row or a folder that was
 *  renamed, skipped or not written. */
export interface ExtractItem {
  /** The row, or -1 for an implied folder. */
  row: number;
  /** The name in the archive (a folder path for a folder). */
  name: string;
  /** The output path below the output folder, when it was written. */
  path?: string;
  /** `ExtractSkip`, when the row was not written. */
  skip?: ExtractSkip;
  /** `Renamed` bits, when the output name is not the archive name. */
  renamed?: number;
  /** The error text, for a row that did not verify or did not write. */
  detail?: string;
}

export interface ExtractReport {
  /** `complete`: all planned files were tried. `cancelled`: the user or
   *  the download stopped it. `failed`: an error stopped all of it. */
  outcome: "complete" | "cancelled" | "failed";
  /** The files written and their decoded bytes. */
  written: number;
  bytes: number;
  /** The name of the output folder or file, when it was made. */
  output?: string;
  /** At most `MAX_REPORT_ITEMS` items, in archive order. */
  items: ExtractItem[];
  /** The items that the report does not list. */
  more: number;
  error?: string;
  /** The output of a `blob` sink. */
  blob?: Blob;
}

/** Slots of the progress buffer: `Float64Array` values first, then
 *  `Int32Array` flags at `PROGRESS_FLAGS_OFFSET` bytes. */
export const ExtractProgress = {
  /** Decoded bytes of the files so far, and of all files. */
  BYTES: 0,
  TOTAL_BYTES: 1,
  /** Files done (written or not), and all files. */
  FILES: 2,
  TOTAL_FILES: 3,
  /** Int32 flags: the UI sets `CANCEL` to stop; the worker sets
   *  `STARTED` when the download asks for its first bytes. */
  CANCEL: 0,
  STARTED: 1,
} as const;
export const PROGRESS_FLAGS_OFFSET = 32;
export const PROGRESS_BYTES = 40;

/** The message that the UI posts to the service worker before a
 *  streamed download, with the port of the read worker. The download URL
 *  is `DOWNLOAD_PATH` + `id` below the scope of the service worker. */
export interface DownloadMessage {
  type: "zipscope-download";
  id: string;
  /** The safe file name. */
  name: string;
  /** The exact length, or undefined when it is not known (a zip). */
  length?: number;
  mime: string;
}
export const DOWNLOAD_PATH = "zipscope-download/";

/** The message on the start port of a streamed download. The service
 *  worker sends it to the UI one time, on the first pull of the stream. */
export interface DownloadStartMessage {
  type: "started";
}

/** The messages on the port of a streamed download. The service worker
 *  sends `pull` for each chunk that it wants and `cancel` when the
 *  download stops; the read worker answers one `chunk` for each `pull`,
 *  then `end` or `error`. */
export type DownloadPortMessage =
  | { type: "pull" }
  | { type: "cancel" }
  | { type: "chunk"; bytes: Uint8Array }
  | { type: "end" }
  | { type: "error"; message: string };

// Zstd remux. A lead worker and a pool of encoder workers,
// all with the write wasm (`zipscope_write`). The UI starts them for one
// copy and terminates all of them when the copy ends.

/** The most encoder workers in the pool. */
export const REMUX_MAX_WORKERS = 4;
/** The memory that the pool size counts for one encoder worker: its start
 *  memory, a Zstandard window of a source frame (at most 32 MiB), the
 *  Zstandard context of the encoder and the kept data of a small entry. */
export const REMUX_ENCODER_BYTES = 56 * 2 ** 20;
/** The most output bytes that one encoder sends before the lead takes
 *  them (its credit). The UI reserves this for each encoder. */
export const REMUX_INFLIGHT_BYTES = 8 * 2 ** 20;
/** The slack that each write worker reserves for the allocations of the
 *  write wasm that cannot fail. */
export const WRITE_GROWTH_SLACK_BYTES = 256 * 1024;
/** Int32 slots of the memory buffer of the write workers: two for each
 *  worker (the lead is worker 0): its reserved units and its wasm memory
 *  in KiB. */
export const WriteSlot = {
  RESERVED: 0,
  KIB: 1,
} as const;
export const WRITE_SLOTS_PER_WORKER = 2;

/** Where the copy goes. */
export type RemuxSink =
  /** The file that `showSaveFilePicker` gave. A failure or a cancel aborts
   *  the writable, so the file keeps its old content. */
  | { kind: "file"; handle: FileSystemFileHandle }
  /** A service-worker streamed download (`DownloadMessage`). Transfer the
   *  port. */
  | { kind: "stream"; port: MessagePort };

/** A row that the copy left out. `skip` is an `ExtractSkip` code. */
export interface RemuxItem {
  row: number;
  skip: ExtractSkip;
  detail: string;
}

export interface RemuxReport {
  /** `complete`: the copy has its central directory. `cancelled` and
   *  `failed`: the output was aborted, and it has no end records. */
  outcome: "complete" | "cancelled" | "failed";
  error?: string;
  /** The entries in the copy, of all rows. */
  written: number;
  rows: number;
  /** Files that went to Zstandard, files stored or copied as they are,
   *  and folders. */
  zstd: number;
  kept: number;
  folders: number;
  /** The uncompressed bytes of the files in the copy. */
  bytes: number;
  /** The bytes of the copy. */
  output: number;
  /** The rows left out, at most `MAX_REPORT_ITEMS`; `more` counts the
   *  others. */
  items: RemuxItem[];
  more: number;
}

/** The work of one row for an encoder. */
export interface EncodeJob {
  row: number;
  record: Uint8Array;
  base: number;
  offset: number;
  uncompressed: number;
}

/** Messages from the lead to an encoder, on its port. */
export type LeadMessage =
  | { type: "jobs"; jobs: EncodeJob[] }
  /** The lead took `bytes` of output: the encoder can send that much
   *  more. */
  | { type: "credit"; bytes: number };

/** A part of the output of a row. The first part has `method`. The last
 *  part has `end`: `done`, or `skip` (no part with bytes came before; the
 *  copy leaves the row out), or `failed` (bytes came before; the copy is
 *  not usable). */
export interface EncodePart {
  row: number;
  bytes: Uint8Array;
  /** Decoded bytes of the row since the last part, for the progress. */
  decoded: number;
  method?: number;
  end?: "done" | "skip" | "failed";
  skip?: ExtractSkip;
  error?: string;
}

/** Messages from an encoder to the lead. */
export type EncoderMessage = { type: "parts"; parts: EncodePart[] };

export interface RemuxOptions {
  /** The hard stop (only for tests; the default is `HARD_BUDGET_BYTES`). */
  hard: number;
  /** For the lead: the `marks` column of each page of the listed rows, on
   *  the shared mirrors. The copy leaves out a row with
   *  `Marks.WRAPPED_OFFSET`, as a preview and an extraction do. */
  marks?: Uint8Array[];
}

/** The encoder worker. The UI starts it, and the lead talks to it on the
 *  port of `open`. */
export interface EncoderWorkerApi {
  open(
    file: File,
    header: SharedArrayBuffer,
    slots: SharedArrayBuffer,
    index: number,
    progress: SharedArrayBuffer,
    port: MessagePort,
    options: RemuxOptions,
  ): Promise<void>;
}

/** The lead worker. */
export interface LeadWorkerApi {
  /** Writes the copy of the `rows` listed rows to `sink`, with the
   *  encoders on `ports`. Resolves with the report. */
  run(
    file: File,
    header: SharedArrayBuffer,
    slots: SharedArrayBuffer,
    rows: number,
    sink: RemuxSink,
    progress: SharedArrayBuffer,
    ports: MessagePort[],
    options: RemuxOptions,
  ): Promise<RemuxReport>;
}
