// Reads the shared mirrors on the main thread. The module doc of
// `contracts.ts` gives the reading protocol.
import {
  CHUNK_BITS,
  CHUNK_BYTES,
  COLUMN_ID,
  COLUMN_LAYOUT,
  FOLDER_RECORD_BYTES,
  Header,
  LARGEST_FILES,
  PAGE_ROWS,
  ROLLUP_RECORD_BYTES,
  State,
  TREE_RECORD_WORDS,
  columnView,
  fromFloat32Bits,
} from "../contracts";
import type { ColumnName, Mirror } from "../contracts";

type ColumnView = ReturnType<typeof columnView>;

interface PageViews {
  /** One view for each column, by column id. */
  columns: ColumnView[];
  nameOffset: Uint32Array;
  nameLength: Uint32Array;
}

/** Chunks of one arena, received without gaps from index 0. */
class ArenaViews {
  private readonly chunks: (Uint8Array | undefined)[] = [];
  count = 0;

  receive(index: number, buffer: SharedArrayBuffer): void {
    this.chunks[index] = new Uint8Array(buffer, 0, CHUNK_BYTES);
    while (this.chunks[this.count] !== undefined) {
      this.count++;
    }
  }

  /** Returns a copy of a value in an ordinary buffer, or undefined when
   *  its chunk has not arrived. Older browsers reject shared views in
   *  `TextDecoder`. */
  copy(offset: number, length: number): Uint8Array | undefined {
    const chunk = this.chunks[offset >>> CHUNK_BITS];
    if (chunk === undefined) {
      return undefined;
    }
    const start = offset & (CHUNK_BYTES - 1);
    return chunk.slice(start, start + length);
  }
}

/** The buffers of one set of the double-buffered views. */
interface ViewBuffers {
  rollups?: SharedArrayBuffer;
  permutation?: SharedArrayBuffer;
  permutationInfo?: SharedArrayBuffer;
  tree?: SharedArrayBuffer;
}

/**
 * One set of the views, read under the generation seqlock. The arrays are
 * views of shared memory: read them only until `stable` returns.
 */
export interface ViewSet {
  generation: number;
  set: 0 | 1;
  /** The folder that the permutation lists. */
  folder: number;
  /** Tagged indexes of the listing. */
  permutation: Uint32Array;
  /** One word for each value of the permutation, with the bits of word 1
   *  of a tree record (`TreeInfo`). The level is 0 for the rows of the
   *  listed folder. */
  info: Uint32Array;
  /** TREE_RECORD_WORDS words for each visible tree row. */
  tree: Uint32Array;
  treeRows: number;
  /** The order of `tree`, a `TreeOrder`. */
  treeOrder: number;
  /** 3 values for each folder: uncompressed, compressed, entry count. */
  rollups: Float64Array;
  /** The largest uncompressed size of a row of the permutation, as a
   *  float32. Use it only for size-bar proportions, never as a byte count. */
  largest: number;
  /** The sort of the permutation, as `LISTING_SORT_n` holds it. */
  sort: number;
  /** The store rows of the largest files below `folder`, from the
   *  largest. Empty for search results. */
  largestFiles: Uint32Array;
}

const PERMUTATION_SLOTS = [Header.PERMUTATION_LENGTH_0, Header.PERMUTATION_LENGTH_1] as const;
const TREE_SLOTS = [Header.TREE_LENGTH_0, Header.TREE_LENGTH_1] as const;
const FOLDER_SLOTS = [Header.PERMUTATION_FOLDER_0, Header.PERMUTATION_FOLDER_1] as const;
const LARGEST_SLOTS = [Header.LISTING_LARGEST_0, Header.LISTING_LARGEST_1] as const;
const SORT_SLOTS = [Header.LISTING_SORT_0, Header.LISTING_SORT_1] as const;
const FILES_SLOTS = [Header.LARGEST_FILES_0, Header.LARGEST_FILES_1] as const;
const TREE_ORDER_SLOTS = [Header.TREE_ORDER_0, Header.TREE_ORDER_1] as const;

export class MirrorReader {
  private header: Int32Array | undefined;
  private readonly pages: (PageViews | undefined)[] = [];
  private readonly names = new ArenaViews();
  private readonly comments = new ArenaViews();
  /** Pages received without gaps from index 0. */
  private pageCount = 0;
  /** With `ignoreBOM`, so that a name that starts with U+FEFF keeps it: the
   *  core counts the true name. */
  private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  private failedToOpen = false;
  private folders: SharedArrayBuffer | undefined;
  private readonly sets: [ViewBuffers, ViewBuffers] = [{}, {}];

  /** Sets the header from `OpenInfo`. */
  attach(header: SharedArrayBuffer): void {
    this.header = new Int32Array(header);
  }

  /** Returns true when the header arrived. Without it, no views come. */
  opened(): boolean {
    return this.header !== undefined;
  }

  /** Returns the `marks` column of each page that arrived. Each view is on
   *  the shared mirror, so a worker that gets it makes no copy. */
  marksColumns(): Uint8Array[] {
    return this.pages.slice(0, this.pageCount).map((page) => {
      return page!.columns[COLUMN_ID.marks] as Uint8Array;
    });
  }

  /** Records that `open` failed, so no header will come. */
  openFailed(): void {
    this.failedToOpen = true;
  }

  /** Takes a mirror buffer from the worker. */
  receive(mirror: Mirror): void {
    if (mirror.kind === "page") {
      const columns = COLUMN_LAYOUT.map((column) => columnView(mirror.buffer, column));
      this.pages[mirror.index] = {
        columns,
        nameOffset: columns[COLUMN_ID.nameOffset] as Uint32Array,
        nameLength: columns[COLUMN_ID.nameLength] as Uint32Array,
      };
      while (this.pages[this.pageCount] !== undefined) {
        this.pageCount++;
      }
    } else if (mirror.kind === "nameChunk") {
      this.names.receive(mirror.index, mirror.buffer);
    } else if (mirror.kind === "commentChunk") {
      this.comments.receive(mirror.index, mirror.buffer);
    } else if (mirror.kind === "folders") {
      this.folders = mirror.buffer;
    } else {
      this.sets[mirror.set][mirror.kind] = mirror.buffer;
    }
  }

  /** Returns the seqlock generation of the views. */
  generation(): number {
    return this.header === undefined ? 0 : Atomics.load(this.header, Header.VIEW_GENERATION);
  }

  /**
   * Returns the active set of the views, or undefined when no set is
   * published or its buffers have not arrived. Call `stable` after the
   * render: when it returns false, the set changed during the render.
   */
  views(): ViewSet | undefined {
    const header = this.header;
    if (header === undefined) {
      return undefined;
    }
    const generation = Atomics.load(header, Header.VIEW_GENERATION);
    if (generation === 0) {
      return undefined;
    }
    const set = Atomics.load(header, Header.ACTIVE_SET) === 1 ? 1 : 0;
    const buffers = this.sets[set];
    const length = Atomics.load(header, PERMUTATION_SLOTS[set]) >>> 0;
    const treeRows = Atomics.load(header, TREE_SLOTS[set]) >>> 0;
    const folder = Atomics.load(header, FOLDER_SLOTS[set]) >>> 0;
    const largest = fromFloat32Bits(Atomics.load(header, LARGEST_SLOTS[set]));
    const sort = Atomics.load(header, SORT_SLOTS[set]);
    const treeOrder = Atomics.load(header, TREE_ORDER_SLOTS[set]);
    const files = Math.min(Atomics.load(header, FILES_SLOTS[set]) >>> 0, LARGEST_FILES);
    const { rollups, permutation, permutationInfo, tree } = buffers;
    // `byteLength` of a growable buffer is a sequentially consistent read,
    // so the growth before the generation store is visible here.
    if (
      rollups === undefined ||
      permutation === undefined ||
      permutationInfo === undefined ||
      tree === undefined ||
      permutation.byteLength < (length + files) * 4 ||
      permutationInfo.byteLength < length * 4 ||
      tree.byteLength < treeRows * TREE_RECORD_WORDS * 4
    ) {
      return undefined;
    }
    return {
      generation,
      set,
      folder,
      permutation: new Uint32Array(permutation, 0, length),
      info: new Uint32Array(permutationInfo, 0, length),
      tree: new Uint32Array(tree, 0, treeRows * TREE_RECORD_WORDS),
      treeRows,
      treeOrder,
      rollups: new Float64Array(rollups, 0, Math.floor(rollups.byteLength / 8)),
      largest,
      sort,
      largestFiles: new Uint32Array(permutation, length * 4, files),
    };
  }

  /** Returns true when the views did not change after `views` gave `set`. */
  stable(set: ViewSet): boolean {
    return this.generation() === set.generation;
  }

  /**
   * Returns the folders that are safe to read: min(committed folder count,
   * records in the received folder buffer), then only folders whose name
   * chunk has arrived. Folders are made in row order, so their name chunk
   * index never decreases.
   */
  visibleFolders(): number {
    const header = this.header;
    const buffer = this.folders;
    if (header === undefined || buffer === undefined) {
      return 0;
    }
    const records = new Uint32Array(buffer, 0, Math.floor(buffer.byteLength / 4));
    const count = Math.min(
      Atomics.load(header, Header.FOLDER_COUNT) >>> 0,
      Math.floor(buffer.byteLength / FOLDER_RECORD_BYTES),
    );
    // The root has no name, so it needs no chunk.
    const ready = (folder: number) =>
      folder === 0 || records[folder * 4]! >>> CHUNK_BITS < this.names.count;
    if (count === 0 || ready(count - 1)) {
      return count;
    }
    let low = 0;
    let high = count - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ready(middle)) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  private folderRecord(folder: number): Uint32Array {
    if (this.folders === undefined) {
      throw new Error(`Folder ${folder} is not visible`);
    }
    return new Uint32Array(this.folders, folder * FOLDER_RECORD_BYTES, 4);
  }

  /** Returns the name of a visible folder. The root has an empty name. */
  folderName(folder: number): string {
    const record = this.folderRecord(folder);
    const length = record[1]!;
    if (length === 0) {
      return "";
    }
    const bytes = this.names.copy(record[0]!, length);
    if (bytes === undefined) {
      throw new Error(`Folder ${folder} is not visible`);
    }
    return this.decoder.decode(bytes);
  }

  /** Returns the parent of a visible folder, or 0xffffffff for the root. */
  folderParent(folder: number): number {
    return this.folderRecord(folder)[2]!;
  }

  /** Returns the explicit row of a visible folder, or 0xffffffff. */
  folderRow(folder: number): number {
    return this.folderRecord(folder)[3]!;
  }

  state(): State {
    if (this.header === undefined) {
      return this.failedToOpen ? State.FAILED : State.OPENING;
    }
    return Atomics.load(this.header, Header.STATE) as State;
  }

  /** Requests the worker to stop at its next batch. */
  cancel(): void {
    if (this.header !== undefined) {
      Atomics.store(this.header, Header.CANCEL, 1);
    }
  }

  /** Returns the parsed part of the central directory, from 0 to 1. */
  progress(): number {
    return this.header === undefined ? 0 : Atomics.load(this.header, Header.PROGRESS) / 1_000_000;
  }

  /** Returns the memory that the budget counts, in bytes: the store
   *  memory (wasm memory, the header and all mirrors) in `STORE_KIB` and
   *  the read worker memory in `READ_KIB`. */
  storeBytes(): number {
    return this.header === undefined
      ? 0
      : ((Atomics.load(this.header, Header.STORE_KIB) >>> 0) +
          (Atomics.load(this.header, Header.READ_KIB) >>> 0)) *
          1024;
  }

  /** Returns a number that changes when the health report changes. */
  healthGeneration(): number {
    return this.header === undefined ? 0 : Atomics.load(this.header, Header.HEALTH_GENERATION);
  }

  committedRows(): number {
    return this.header === undefined ? 0 : Atomics.load(this.header, Header.COMMITTED_ROWS) >>> 0;
  }

  /** Returns the rows whose column pages arrived. The byte map of the
   *  read worker uses only columns, so it clamps to this count. */
  pageRows(): number {
    return this.pageCount * PAGE_ROWS;
  }

  /**
   * Returns the rows that are safe to render: min(committed count, rows
   * covered by the received pages and name chunks). A page or chunk message
   * can arrive after the count has moved into it.
   */
  visibleRows(): number {
    const rows = Math.min(this.committedRows(), this.pageCount * PAGE_ROWS);
    if (rows === 0 || this.chunkOf(rows - 1) < this.names.count) {
      return rows;
    }
    // Names are appended in row order, so the chunk index never decreases.
    // Find the first row whose chunk is not received.
    let low = 0;
    let high = rows - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.chunkOf(middle) < this.names.count) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  /** Returns the rollup of a folder in a view set: uncompressed size,
   *  compressed size and entry count. Undefined when it is not in the set. */
  static rollup(set: ViewSet, folder: number): [number, number, number] | undefined {
    const at = (folder * ROLLUP_RECORD_BYTES) / 8;
    if (at + 3 > set.rollups.length) {
      return undefined;
    }
    return [set.rollups[at]!, set.rollups[at + 1]!, set.rollups[at + 2]!];
  }

  /** Returns the name of a visible row. */
  name(row: number): string {
    const page = this.page(row);
    const index = row % PAGE_ROWS;
    const bytes = this.names.copy(page.nameOffset[index]!, page.nameLength[index]!);
    if (bytes === undefined) {
      throw new Error(`Row ${row} is not visible`);
    }
    return this.decoder.decode(bytes);
  }

  /** Returns the comment of a visible row. It is undefined when the
   *  comment chunk has not arrived yet. */
  comment(row: number): string | undefined {
    const length = this.value(row, "commentLength");
    if (length === 0) {
      return "";
    }
    const bytes = this.comments.copy(this.value(row, "commentOffset"), length);
    return bytes === undefined ? undefined : this.decoder.decode(bytes);
  }

  /** Returns the value of a column in a visible row. */
  value(row: number, column: ColumnName): number {
    return this.page(row).columns[COLUMN_ID[column]]![row % PAGE_ROWS]!;
  }

  private chunkOf(row: number): number {
    return this.page(row).nameOffset[row % PAGE_ROWS] >>> CHUNK_BITS;
  }

  private page(row: number): PageViews {
    const page = this.pages[Math.floor(row / PAGE_ROWS)];
    if (page === undefined) {
      throw new Error(`Row ${row} is not visible`);
    }
    return page;
  }
}
