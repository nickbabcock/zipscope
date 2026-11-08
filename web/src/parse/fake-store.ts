// A store in an ArrayBuffer with the same layout rules as the Rust store.
// Tests use it in place of wasm memory.
import {
  CHUNK_BITS,
  CHUNK_BYTES,
  COLUMN_ID,
  COLUMN_LAYOUT,
  PAGE_ROWS,
  TREE_RECORD_WORDS,
  columnView,
} from "../contracts";
import type { ColumnName } from "../contracts";
import type { BatchParser } from "./loop";

/** A row for the fake store. Columns that it does not give stay 0. */
export interface FakeRow {
  name: string;
  comment?: string;
  columns?: Partial<Record<ColumnName, number>>;
}

/** Views that a test gives to the fake store. Records use the contract
 *  layouts: 4 u32 for each folder, 3 f64 for each rollup, and
 *  TREE_RECORD_WORDS u32 for each tree row. */
export interface FakeViews {
  folders: number[];
  rollups: number[];
  permutation: number[];
  /** The information words of the permutation. Zeros when not given. */
  info?: number[];
  permutationFolder: number;
  tree: number[];
  /** Folder ids whose explicit row changed. */
  updates?: number[];
  /** The largest size of a row of the permutation. */
  largest?: number;
}

interface Arena {
  chunks: { address: number; length: number }[];
}

export class FakeStore implements BatchParser {
  memory: ArrayBuffer;
  private next = 8;
  /** The address of each column of each page. Columns other than the
   *  name columns are allocated when a row first gives a value. */
  private readonly pages: Map<number, number>[] = [];
  private readonly names: Arena = { chunks: [] };
  private readonly comments: Arena = { chunks: [] };
  private count = 0;
  private readonly encoder = new TextEncoder();
  private pending: FakeRow[] = [];
  private status = 1;
  private failure: string | undefined;
  private views: FakeViews | undefined;
  /** Each `setViews` call changes all views. */
  private version = 0;
  private markUpdates: number[] = [];
  private viewAddresses = {
    folders: 0,
    rollups: 0,
    permutation: 0,
    info: 0,
    tree: 0,
    updates: 0,
  };

  constructor(bytes: number) {
    this.memory = new ArrayBuffer(bytes);
  }

  /** Names that `parse` adds next. */
  queue(rows: (string | FakeRow)[]): void {
    this.pending.push(...rows.map((row) => (typeof row === "string" ? { name: row } : row)));
  }

  /** Makes `parse` fail after the queued names. */
  failAfterQueue(message: string): void {
    this.failure = message;
  }

  /** Replaces the memory buffer, as wasm memory growth does. */
  grow(bytes: number): void {
    const memory = new ArrayBuffer(bytes);
    new Uint8Array(memory).set(new Uint8Array(this.memory));
    this.memory = memory;
  }

  private alloc(bytes: number): number {
    const address = this.next;
    this.next += bytes;
    if (this.next > this.memory.byteLength) {
      throw new Error("The fake memory is full");
    }
    return address;
  }

  /** Appends a value to an arena with the rules of the Rust arena. An
   *  empty comment before the first chunk gets offset 0. */
  private append(arena: Arena, bytes: Uint8Array, allocateEmpty: boolean): number {
    let last = arena.chunks.at(-1);
    if (last === undefined && bytes.length === 0 && !allocateEmpty) {
      return 0;
    }
    if (last === undefined || last.length + bytes.length > CHUNK_BYTES) {
      last = { address: this.alloc(CHUNK_BYTES), length: 0 };
      arena.chunks.push(last);
    }
    new Uint8Array(this.memory, last.address + last.length, bytes.length).set(bytes);
    const position = Math.min(last.length, CHUNK_BYTES - 1);
    last.length += bytes.length;
    return (((arena.chunks.length - 1) << CHUNK_BITS) | position) >>> 0;
  }

  private column(page: Map<number, number>, id: number) {
    let address = page.get(id);
    if (address === undefined) {
      const column = COLUMN_LAYOUT[id]!;
      address = this.alloc(column.width * PAGE_ROWS + 8);
      address += (column.width - (address % column.width)) % column.width;
      page.set(id, address);
    }
    return columnView(this.memory, { ...COLUMN_LAYOUT[id]!, byteOffset: address });
  }

  push(row: FakeRow): void {
    if (this.count % PAGE_ROWS === 0) {
      const page = new Map<number, number>();
      this.pages.push(page);
      this.column(page, COLUMN_ID.nameOffset);
      this.column(page, COLUMN_ID.nameLength);
    }
    const page = this.pages.at(-1)!;
    const index = this.count % PAGE_ROWS;
    const name = this.encoder.encode(row.name);
    this.column(page, COLUMN_ID.nameOffset)[index] = this.append(this.names, name, true);
    this.column(page, COLUMN_ID.nameLength)[index] = name.length;
    if (row.comment !== undefined) {
      const comment = this.encoder.encode(row.comment);
      this.column(page, COLUMN_ID.commentOffset)[index] = this.append(
        this.comments,
        comment,
        false,
      );
      this.column(page, COLUMN_ID.commentLength)[index] = comment.length;
    }
    for (const [name, value] of Object.entries(row.columns ?? {})) {
      this.column(page, COLUMN_ID[name as ColumnName])[index] = value;
    }
    this.count++;
  }

  /** Adds `marks` bits to a row that exists, as a health check of the
   *  Rust core does for a committed row. */
  markRow(row: number, bits: number): void {
    const page = this.pages[Math.floor(row / PAGE_ROWS)]!;
    const marks = this.column(page, COLUMN_ID.marks);
    marks[row % PAGE_ROWS] = (marks[row % PAGE_ROWS] ?? 0) | bits;
    this.markUpdates.push(row);
  }

  markUpdateCount(): number {
    return this.markUpdates.length;
  }

  markUpdatesPtr(): number {
    const address = this.alloc(this.markUpdates.length * 4 + 4);
    const aligned = address + ((4 - (address % 4)) % 4);
    new Uint32Array(this.memory, aligned, this.markUpdates.length).set(this.markUpdates);
    return aligned;
  }

  clearMarkUpdates(): void {
    this.markUpdates = [];
  }

  /** Sets the views. Each call writes them to new fake memory. */
  setViews(views: FakeViews): void {
    const words = (values: number[]) => {
      const address = this.alloc(values.length * 4 + 4);
      new Uint32Array(this.memory, address, values.length).set(values);
      return address;
    };
    const rollups = this.alloc(views.rollups.length * 8 + 8);
    const aligned = rollups + ((8 - (rollups % 8)) % 8);
    new Float64Array(this.memory, aligned, views.rollups.length).set(views.rollups);
    this.viewAddresses = {
      folders: words(views.folders),
      rollups: aligned,
      permutation: words(views.permutation),
      info: words(views.info ?? views.permutation.map(() => 0)),
      tree: words(views.tree),
      updates: words(views.updates ?? []),
    };
    this.views = { ...views };
    this.version++;
  }

  rollupVersion(): number {
    return this.version;
  }

  permutationVersion(): number {
    return this.version;
  }

  treeVersion(): number {
    return this.version;
  }

  permutationLargest(): number {
    return this.views?.largest ?? 0;
  }

  refreshViews(): boolean {
    return false;
  }

  /** The fake has no listing to sort. */
  sort(_column: number, _descending: boolean): boolean {
    return false;
  }

  /** The fake has no listing to sort, so it refuses the default sort. */
  defaultSort(): number {
    return 0;
  }

  mergeViews(_budget: number): boolean {
    return false;
  }

  mergePending(): boolean {
    return false;
  }

  viewsBuilding(): boolean {
    return false;
  }

  rowsWaiting(): boolean {
    return false;
  }

  /** The fake has no tree to sort: the job ends when it starts. */
  startTreeOrder(): void {}

  treeOrderStep(_budget: number): boolean {
    return false;
  }

  treeOrderPending(): boolean {
    return false;
  }

  treeOrder(): number {
    return 0;
  }

  viewsBuildEpoch(): number {
    return 0;
  }

  folderCount(): number {
    return (this.views?.folders.length ?? 0) / 4;
  }

  folderPtr(): number {
    return this.viewAddresses.folders;
  }

  rollupPtr(): number {
    return this.viewAddresses.rollups;
  }

  folderUpdateCount(): number {
    return this.views?.updates?.length ?? 0;
  }

  folderUpdatesPtr(): number {
    return this.viewAddresses.updates;
  }

  clearFolderUpdates(): void {
    if (this.views !== undefined) {
      this.views.updates = [];
    }
  }

  permutationFolder(): number {
    return this.views?.permutationFolder ?? 0;
  }

  permutationPtr(): number {
    return this.viewAddresses.permutation;
  }

  permutationInfoPtr(): number {
    return this.viewAddresses.info;
  }

  permutationLength(): number {
    return this.views?.permutation.length ?? 0;
  }

  treePtr(): number {
    return this.viewAddresses.tree;
  }

  treeLength(): number {
    return (this.views?.tree.length ?? 0) / TREE_RECORD_WORDS;
  }

  parse(maxEntries: number): number {
    const names = this.pending.splice(0, maxEntries);
    for (const row of names) {
      this.push(row);
    }
    if (this.pending.length === 0) {
      this.status = this.failure === undefined ? 2 : 4;
    }
    return names.length;
  }

  state(): number {
    return this.status;
  }

  error(): string | undefined {
    return this.status === 4 ? this.failure : undefined;
  }

  /** The tests that need marks give their own count. */
  markedFrom(): number {
    return 0;
  }

  intoDirectoryFrom(): number {
    return 0;
  }

  rows(): number {
    return this.count;
  }

  progress(): number {
    return this.status === 2 ? 1 : 0.5;
  }

  columnPtr(page: number, column: number): number {
    return this.pages[page]?.get(column) ?? 0;
  }

  nameChunkCount(): number {
    return this.names.chunks.length;
  }

  nameChunkPtr(chunk: number): number {
    return this.names.chunks[chunk]?.address ?? 0;
  }

  nameChunkLength(chunk: number): number {
    return this.names.chunks[chunk]?.length ?? 0;
  }

  commentChunkCount(): number {
    return this.comments.chunks.length;
  }

  commentChunkPtr(chunk: number): number {
    return this.comments.chunks[chunk]?.address ?? 0;
  }

  commentChunkLength(chunk: number): number {
    return this.comments.chunks[chunk]?.length ?? 0;
  }
}
