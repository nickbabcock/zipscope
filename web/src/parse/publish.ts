// Copies new rows and arena bytes from wasm memory into the shared mirrors,
// then commits the row count. Then it writes the folder rollups, the
// permutation and the flattened tree into the inactive set and publishes
// it. The module doc of `contracts.ts` gives the publish protocol.
import {
  BEST_MATCH_ORDER,
  CHUNK_BYTES,
  COLUMN_ID,
  COLUMN_LAYOUT,
  FOLDER_RECORD_BYTES,
  Header,
  PAGE_BYTES,
  PAGE_ROWS,
  ROLLUP_RECORD_BYTES,
  HARD_BUDGET_BYTES,
  SORT_DESCENDING,
  TREE_RECORD_WORDS,
  TreeOrder,
  toFloat32Bits,
} from "../contracts";
import type { ColumnLayout, Mirror } from "../contracts";
import { StoreReservation } from "./memory";

/** The largest size of one growable mirror: the hard stop of the memory
 *  budget. */
export const GROWABLE_MAX_BYTES = HARD_BUDGET_BYTES;

/** The part of the wasm `Parser` that publishing reads. */
export interface StoreSource {
  rows(): number;
  progress(): number;
  columnPtr(page: number, column: number): number;
  nameChunkCount(): number;
  nameChunkPtr(chunk: number): number;
  nameChunkLength(chunk: number): number;
  commentChunkCount(): number;
  commentChunkPtr(chunk: number): number;
  commentChunkLength(chunk: number): number;
  /** Folders, including the root. */
  folderCount(): number;
  /** The address of folder record 0. */
  folderPtr(): number;
  /** The address of rollup record 0. */
  rollupPtr(): number;
  /** Folders whose explicit row changed after their record was copied. */
  folderUpdateCount(): number;
  folderUpdatesPtr(): number;
  clearFolderUpdates(): void;
  /** The folder that the permutation lists. */
  permutationFolder(): number;
  permutationPtr(): number;
  /** The information words of the permutation, one for each value. */
  permutationInfoPtr(): number;
  /** Values in the permutation. */
  permutationLength(): number;
  treePtr(): number;
  /** Rows in the flattened tree. */
  treeLength(): number;
  /** The order of the flattened tree, a `TreeOrder`. */
  treeOrder?(): number;
  /** Numbers that change when the rollups, the permutation or the tree
   *  change. The writer copies a view only when its number changed. */
  rollupVersion(): number;
  permutationVersion(): number;
  treeVersion(): number;
  /** The largest uncompressed size of a row of the permutation. */
  permutationLargest(): number;
  /** The largest files below the folder of the permutation:
   *  the address of their `u32` store rows, their number, and a number
   *  that changes when they change. */
  largestFilesPtr?(): number;
  largestFilesLength?(): number;
  largestFilesVersion?(): number;
  /** True while a requested listing is built in steps. */
  viewsBuilding?(): boolean;
  /** True when the listing as it is now is in the best-match order. */
  listingBestMatch?(): boolean;
  /** True when parsed rows are not in the listing as it is now. */
  rowsWaiting?(): boolean;
  /** Rows whose `marks` changed after the row was added. */
  markUpdateCount?(): number;
  markUpdatesPtr?(): number;
  clearMarkUpdates?(): void;
  /** The health vector. `HealthField` gives the indexes. */
  health?(): ArrayLike<number>;
}

/** Allocates a buffer of `bytes` after it reserves them. Throws a
 *  `MemoryLimitError` when they do not fit below the hard stop. */
function allocate(bytes: number, memory: StoreReservation): SharedArrayBuffer {
  memory.take(bytes);
  try {
    return new SharedArrayBuffer(bytes);
  } catch (error) {
    memory.give(bytes);
    throw error;
  }
}

/** Grows a growable mirror in place to at least `bytes`. Each growth is
 *  reserved before it. */
function ensure(buffer: SharedArrayBuffer, bytes: number, memory: StoreReservation): void {
  if (bytes <= buffer.byteLength) {
    return;
  }
  if (bytes > buffer.maxByteLength) {
    throw new Error("A view is larger than the memory limit");
  }
  // Double, so that a growing archive grows the buffer few times. Near the
  // hard stop, grow only as much as is needed. The sizes are whole wasm
  // pages, which are the units of the reservation.
  const step = Math.max(bytes, buffer.byteLength * 2, 65536);
  const next = Math.min(buffer.maxByteLength, Math.ceil(step / 65536) * 65536);
  const needed = Math.min(next, Math.ceil(bytes / 65536) * 65536, buffer.maxByteLength);
  let size = next;
  if (!memory.tryTake(next - buffer.byteLength)) {
    memory.take(needed - buffer.byteLength);
    size = needed;
  }
  const growth = size - buffer.byteLength;
  try {
    buffer.grow(size);
  } catch (error) {
    memory.give(growth);
    throw error;
  }
}

function growable(maxBytes: number): SharedArrayBuffer {
  return new SharedArrayBuffer(0, { maxByteLength: maxBytes });
}

/** The buffers of one set of the double-buffered views, and the versions
 *  of the views that they hold. */
interface ViewSet {
  rollups: SharedArrayBuffer;
  permutation: SharedArrayBuffer;
  permutationInfo: SharedArrayBuffer;
  tree: SharedArrayBuffer;
  /** The folder count, the rollup, permutation and tree versions, and the
   *  lengths, of the last write. */
  written: string[];
}

const LENGTH_SLOTS = [
  {
    permutation: Header.PERMUTATION_LENGTH_0,
    tree: Header.TREE_LENGTH_0,
    folder: Header.PERMUTATION_FOLDER_0,
    largest: Header.LISTING_LARGEST_0,
    sort: Header.LISTING_SORT_0,
    files: Header.LARGEST_FILES_0,
    treeOrder: Header.TREE_ORDER_0,
  },
  {
    permutation: Header.PERMUTATION_LENGTH_1,
    tree: Header.TREE_LENGTH_1,
    folder: Header.PERMUTATION_FOLDER_1,
    largest: Header.LISTING_LARGEST_1,
    sort: Header.LISTING_SORT_1,
    files: Header.LARGEST_FILES_1,
    treeOrder: Header.TREE_ORDER_1,
  },
] as const;

/** The chunks of one arena, as `StoreSource` gives them. */
interface ArenaSource {
  count(): number;
  ptr(chunk: number): number;
  length(chunk: number): number;
}

/** The mirrors of one arena. It sends each chunk one time. */
class ArenaMirror {
  private readonly chunks: Uint8Array[] = [];
  /** Bytes copied from each chunk. */
  private readonly copied: number[] = [];

  constructor(
    private readonly header: Int32Array,
    private readonly countSlot: number,
    private readonly kind: "nameChunk" | "commentChunk",
    private readonly send: (mirror: Mirror) => void,
    private readonly reservation: StoreReservation,
  ) {}

  get chunkCount(): number {
    return this.chunks.length;
  }

  copy(source: ArenaSource, memory: ArrayBuffer): void {
    const count = source.count();
    // Only the last mirrored chunk and new chunks can have new bytes.
    for (let chunk = Math.max(0, this.chunks.length - 1); chunk < count; chunk++) {
      if (chunk === this.chunks.length) {
        const buffer = allocate(CHUNK_BYTES, this.reservation);
        this.chunks.push(new Uint8Array(buffer));
        this.copied.push(0);
        this.send({ kind: this.kind, index: chunk, buffer });
        Atomics.store(this.header, this.countSlot, this.chunks.length);
      }
      const length = source.length(chunk);
      const from = this.copied[chunk] ?? 0;
      if (length > from) {
        const bytes = new Uint8Array(memory, source.ptr(chunk) + from, length - from);
        this.chunks[chunk]?.set(bytes, from);
        this.copied[chunk] = length;
      }
    }
  }
}

function wasmView(memory: ArrayBuffer, column: ColumnLayout, address: number, length: number) {
  switch (column.type) {
    case "f64":
      return new Float64Array(memory, address, length);
    case "u32":
      return new Uint32Array(memory, address, length);
    case "u16":
      return new Uint16Array(memory, address, length);
    case "u8":
      return new Uint8Array(memory, address, length);
  }
}

function mirrorView(page: SharedArrayBuffer, column: ColumnLayout, row: number, length: number) {
  const offset = column.byteOffset + row * column.width;
  switch (column.type) {
    case "f64":
      return new Float64Array(page, offset, length);
    case "u32":
      return new Uint32Array(page, offset, length);
    case "u16":
      return new Uint16Array(page, offset, length);
    case "u8":
      return new Uint8Array(page, offset, length);
  }
}

/** Identifies the views of the store: the listing, the tree, the
 *  rollups and the largest files. */
function listingKey(source: StoreSource): string {
  return [
    source.folderCount(),
    source.rollupVersion(),
    source.permutationFolder(),
    source.permutationLength(),
    source.permutationVersion(),
    source.treeLength(),
    source.treeVersion(),
    source.largestFilesVersion?.() ?? 0,
  ].join(":");
}

export class MirrorWriter {
  /** The listing key at the last publish. */
  private shown: string | undefined;
  /** The last sort that the store accepted, as `LISTING_SORT_n` holds it. */
  private storeSort = 0;
  /** The sort of the published permutation. */
  private listingSort = 0;
  /** See `listingBehind`. */
  private behind = false;
  private readonly header: Int32Array;
  private readonly pages: SharedArrayBuffer[] = [];
  private readonly names: ArenaMirror;
  private readonly comments: ArenaMirror;
  private copiedRows = 0;
  private readonly folders: SharedArrayBuffer;
  private copiedFolders = 0;
  private readonly sets: [ViewSet, ViewSet];
  private lastHealth: number[] = [];
  /** The reservation of the store on the shared memory budget. */
  readonly reservation: StoreReservation;

  constructor(
    header: SharedArrayBuffer,
    private readonly send: (mirror: Mirror) => void,
    /** Returns the current wasm memory. Memory growth replaces the buffer. */
    private readonly memory: () => ArrayBuffer,
    /** The hard stop. No mirror allocation passes it. */
    hardBytes: number = GROWABLE_MAX_BYTES,
    /** The memory that the hard stop keeps for the read worker
     *  (`readReserve`). */
    readReserveBytes = 0,
    /** The reservation that the worker made before it opened the
     *  archive. Without it, the writer makes one now. */
    reservation?: StoreReservation,
  ) {
    this.header = new Int32Array(header);
    this.reservation =
      reservation ?? new StoreReservation(header, hardBytes, readReserveBytes, memory);
    const reserve = this.reservation;
    this.names = new ArenaMirror(this.header, Header.NAME_CHUNK_COUNT, "nameChunk", send, reserve);
    this.comments = new ArenaMirror(
      this.header,
      Header.COMMENT_CHUNK_COUNT,
      "commentChunk",
      send,
      reserve,
    );
    const maxBytes = Math.min(hardBytes, GROWABLE_MAX_BYTES);
    this.folders = growable(maxBytes);
    const set = (): ViewSet => ({
      rollups: growable(maxBytes),
      permutation: growable(maxBytes),
      permutationInfo: growable(maxBytes),
      tree: growable(maxBytes),
      written: [],
    });
    this.sets = [set(), set()];
    Atomics.store(this.header, Header.STORE_KIB, Math.ceil(this.storeBytes() / 1024));
    // The growable mirrors go to the UI one time. They grow in place.
    send({ kind: "folders", buffer: this.folders });
    for (const index of [0, 1] as const) {
      const views = this.sets[index];
      send({ kind: "rollups", set: index, buffer: views.rollups });
      send({ kind: "permutation", set: index, buffer: views.permutation });
      send({ kind: "permutationInfo", set: index, buffer: views.permutationInfo });
      send({ kind: "tree", set: index, buffer: views.tree });
    }
  }

  /** Records a sort that the store accepted. The permutation has this
   *  sort when no listing build is in progress and it is not in the
   *  best-match order. */
  sorted(column: number, descending: boolean): void {
    this.storeSort = column | (descending ? SORT_DESCENDING : 0);
  }

  /**
   * Mirrors what the store added since the last call and commits it. With
   * `lastMerge`, the parse has stopped and this publish adds the rows that
   * waited. It does not stop at the hard stop by itself, because it can have
   * no growth. A growth that does not fit still throws.
   */
  publish(source: StoreSource, lastMerge = false): void {
    if (!lastMerge) this.reservation.check();
    // While a build runs, the old listing and its sort stay published. The
    // store knows if the listing as it is now has the best-match order. The
    // word goes to the set with the rows, so the order cannot tear from them.
    const building = source.viewsBuilding?.() ?? false;
    const sort =
      source.listingBestMatch?.() === true
        ? BEST_MATCH_ORDER
        : building
          ? this.listingSort
          : this.storeSort;
    // Make a new view after each wasm call: growth detaches the old buffer.
    const memory = this.memory();
    this.names.copy(
      {
        count: () => source.nameChunkCount(),
        ptr: (chunk) => source.nameChunkPtr(chunk),
        length: (chunk) => source.nameChunkLength(chunk),
      },
      memory,
    );
    this.comments.copy(
      {
        count: () => source.commentChunkCount(),
        ptr: (chunk) => source.commentChunkPtr(chunk),
        length: (chunk) => source.commentChunkLength(chunk),
      },
      memory,
    );
    const rows = source.rows();
    this.copyRows(source, memory, rows);
    this.copyMarkUpdates(source);
    this.copyFolders(source);
    // The UI reads the active set. Write the other one.
    const next = Atomics.load(this.header, Header.ACTIVE_SET) === 0 ? 1 : 0;
    this.writeSet(source, next, sort);
    Atomics.store(this.header, Header.PROGRESS, Math.round(source.progress() * 1_000_000));
    Atomics.store(this.header, Header.STORE_KIB, Math.ceil(this.storeBytes() / 1024));
    this.checkHealth(source);
    // The count goes after the data. The UI reads only rows below it.
    Atomics.store(this.header, Header.COMMITTED_ROWS, rows);
    this.copiedRows = rows;
    // Publish the set: the generation seqlock of `contracts.ts`.
    Atomics.store(this.header, Header.ACTIVE_SET, next);
    Atomics.add(this.header, Header.VIEW_GENERATION, 1);
    this.shown = listingKey(source);
    this.listingSort = sort;
    this.behind = source.rowsWaiting?.() ?? false;
  }

  /** True when the last publish committed rows that its listing does not have.
   *  The UI then shows a count that is larger than the listing can show. */
  listingBehind(): boolean {
    return this.behind;
  }

  /** Returns true when the last publish wrote the views that the store
   *  has now. Any caller can make that publish: a view
   *  request, or the parse loop. */
  shows(source: StoreSource): boolean {
    return this.shown === listingKey(source);
  }

  /** Tells the UI that the health report changed. */
  healthChanged(): void {
    Atomics.add(this.header, Header.HEALTH_GENERATION, 1);
  }

  private checkHealth(source: StoreSource): void {
    const vector = source.health?.();
    if (vector === undefined) {
      return;
    }
    const values = Array.from(vector);
    if (
      values.length !== this.lastHealth.length ||
      values.some((v, i) => v !== this.lastHealth[i])
    ) {
      this.lastHealth = values;
      this.healthChanged();
    }
  }

  /** Copies the `marks` value of the rows that the health checks marked
   *  after the rows were copied. A u8 store does not tear. */
  private copyMarkUpdates(source: StoreSource): void {
    const count = source.markUpdateCount?.() ?? 0;
    if (count === 0) {
      return;
    }
    const memory = this.memory();
    const rows = new Uint32Array(memory, source.markUpdatesPtr!(), count).slice();
    const marks = COLUMN_LAYOUT[COLUMN_ID.marks]!;
    for (const row of rows) {
      const page = Math.floor(row / PAGE_ROWS);
      const target = this.pages[page];
      const address = source.columnPtr(page, marks.id);
      if (target === undefined || address === 0) {
        continue;
      }
      const index = row % PAGE_ROWS;
      new Uint8Array(target, marks.byteOffset)[index] = new Uint8Array(memory, address)[index]!;
    }
    source.clearMarkUpdates!();
  }

  /** Returns the bytes that the memory budget counts: the store memory
   *  and the read worker memory in `READ_KIB`. */
  allocatedBytes(): number {
    return this.storeBytes() + this.readBytes();
  }

  /** Returns the bytes that the hard stop counts: the reservations of the
   *  store and the larger of the read worker reservation and its reserve
   *  (see `Reservations`). Thus the hard stop always leaves the reserve
   *  for a preview, also before the read worker starts. The memory in use
   *  is not more than the reservations. A test can set `READ_KIB` without
   *  a reservation, so that value counts too. */
  stopBytes(): number {
    const stop = this.reservation.stopBytes();
    const counted = this.storeBytes() + this.readBytes();
    return Math.max(stop, counted);
  }

  /** Returns the bytes that the parse worker can still reserve. */
  roomBytes(): number {
    return this.reservation.room();
  }

  private readBytes(): number {
    return (Atomics.load(this.header, Header.READ_KIB) >>> 0) * 1024;
  }

  /** Returns the store memory in bytes: wasm memory, the header and all
   *  mirrors, by their current lengths. `STORE_KIB` holds it. */
  storeBytes(): number {
    const memory = this.memory();
    let views = this.folders.byteLength;
    for (const set of this.sets) {
      views +=
        set.rollups.byteLength +
        set.permutation.byteLength +
        set.permutationInfo.byteLength +
        set.tree.byteLength;
    }
    return (
      memory.byteLength +
      this.header.byteLength +
      this.pages.length * PAGE_BYTES +
      (this.names.chunkCount + this.comments.chunkCount) * CHUNK_BYTES +
      views
    );
  }

  /** Copies the new folder records and the records whose explicit row
   *  changed, then commits the folder count. */
  private copyFolders(source: StoreSource): void {
    const count = source.folderCount();
    ensure(this.folders, count * FOLDER_RECORD_BYTES, this.reservation);
    const target = new Uint32Array(this.folders);
    const words = FOLDER_RECORD_BYTES / 4;
    const memory = this.memory();
    if (count > this.copiedFolders) {
      const from = this.copiedFolders * words;
      const records = new Uint32Array(memory, source.folderPtr() + from * 4, count * words - from);
      target.set(records, from);
    }
    const updates = source.folderUpdateCount();
    if (updates > 0) {
      const ids = new Uint32Array(memory, source.folderUpdatesPtr(), updates).slice();
      const records = new Uint32Array(memory, source.folderPtr(), count * words);
      for (const id of ids) {
        // A u32 store does not tear, so the UI can read the record now.
        target.set(records.subarray(id * words, id * words + words), id * words);
      }
      source.clearFolderUpdates();
    }
    Atomics.store(this.header, Header.FOLDER_COUNT, count);
    this.copiedFolders = count;
  }

  /** Copies the rollups, the permutation and the flattened tree into a
   *  set that the UI does not read, with its lengths. A view that did not
   *  change since the last write to this set is not copied again. */
  private writeSet(source: StoreSource, index: 0 | 1, sort: number): void {
    const set = this.sets[index];
    const slots = LENGTH_SLOTS[index];
    const folders = source.folderCount();
    const length = source.permutationLength();
    // The largest files follow the listing in the permutation buffer.
    const files = source.largestFilesLength?.() ?? 0;
    const treeRows = source.treeLength();
    const treeWords = treeRows * TREE_RECORD_WORDS;
    const versions = [
      `${folders}:${source.rollupVersion()}`,
      `${length}:${source.permutationVersion()}`,
      `${treeRows}:${source.treeVersion()}`,
    ];
    ensure(set.rollups, folders * ROLLUP_RECORD_BYTES, this.reservation);
    ensure(set.permutation, (length + files) * 4, this.reservation);
    ensure(set.permutationInfo, length * 4, this.reservation);
    ensure(set.tree, treeWords * 4, this.reservation);
    // Make the wasm views after the calls above.
    const memory = this.memory();
    if (versions[0] !== set.written[0]) {
      new Float64Array(set.rollups).set(
        new Float64Array(memory, source.rollupPtr(), (folders * ROLLUP_RECORD_BYTES) / 8),
      );
    }
    if (versions[1] !== set.written[1]) {
      new Uint32Array(set.permutation).set(
        new Uint32Array(memory, source.permutationPtr(), length),
      );
      new Uint32Array(set.permutationInfo).set(
        new Uint32Array(memory, source.permutationInfoPtr(), length),
      );
    }
    if (versions[2] !== set.written[2]) {
      new Uint32Array(set.tree).set(new Uint32Array(memory, source.treePtr(), treeWords));
    }
    if (files > 0) {
      // At most LARGEST_FILES words: copy them on each write.
      new Uint32Array(set.permutation, length * 4, files).set(
        new Uint32Array(memory, source.largestFilesPtr!(), files),
      );
    }
    set.written = versions;
    Atomics.store(this.header, slots.permutation, length);
    Atomics.store(this.header, slots.tree, treeRows);
    Atomics.store(this.header, slots.folder, source.permutationFolder());
    Atomics.store(this.header, slots.largest, toFloat32Bits(source.permutationLargest()));
    Atomics.store(this.header, slots.sort, sort);
    Atomics.store(this.header, slots.files, files);
    Atomics.store(this.header, slots.treeOrder, source.treeOrder?.() ?? TreeOrder.ARCHIVE);
  }

  private copyRows(source: StoreSource, memory: ArrayBuffer, rows: number) {
    if (rows <= this.copiedRows) {
      return;
    }
    const firstPage = Math.floor(this.copiedRows / PAGE_ROWS);
    const lastPage = Math.floor((rows - 1) / PAGE_ROWS);
    for (let page = firstPage; page <= lastPage; page++) {
      if (page === this.pages.length) {
        const buffer = allocate(PAGE_BYTES, this.reservation);
        this.pages.push(buffer);
        this.send({ kind: "page", index: page, buffer });
        Atomics.store(this.header, Header.PAGE_COUNT, this.pages.length);
      }
      const base = page * PAGE_ROWS;
      const from = Math.max(this.copiedRows, base) - base;
      const to = Math.min(rows, base + PAGE_ROWS) - base;
      const target = this.pages[page];
      if (target === undefined) {
        throw new Error(`Page ${page} is missing`);
      }
      for (const column of COLUMN_LAYOUT) {
        const address = source.columnPtr(page, column.id);
        if (address === 0) {
          continue;
        }
        const values = wasmView(memory, column, address + from * column.width, to - from);
        mirrorView(target, column, from, to - from).set(values as never);
      }
    }
  }
}
