// The reader of the read worker. It keeps one window for the local headers and
// the data of the rows. A row reads its central-directory record too, and that
// read must not replace this window: if it does, each row fills the window two
// times.
//
// A preview and a single entry read each record from the file. A folder job or
// a zip job has a second window for its records, and reads from the file at each
// JOB_CHECK_ROWS rows. The browser tells of a changed file only when a read goes
// to the file, so these reads find a changed file. The lead of a zstd copy
// (web/src/write/lead.ts) reads with the same rule: the copy is one job.
import { WindowReaderAt } from "../parse/reader";

/**
 * The rows of a job for one read that goes to the file. The value is 256: a
 * change to the file is found when at most 255 more rows have started, and these
 * rows have the bytes of the file that the user listed, and their CRC-32 verifies.
 * The read costs about 0.5 ms, so a check for each row makes a zip of small
 * rows more than 20 times slower.
 */
export const JOB_CHECK_ROWS = 256;

/** An object that the read wasm can read from. */
export interface RecordReader {
  readAt(offset: number, buffer: Uint8Array): number;
}

export class RowReaderAt extends WindowReaderAt {
  /** The second window. It exists only while a job runs. */
  private jobWindow: WindowReaderAt | undefined;
  /** The rows of the job that started. */
  private jobRows = 0;
  /** True when the next record of the job must come from the file. */
  private checkNext = false;
  /** The first read that failed in this job. */
  private refusal: { error: unknown } | undefined;

  /** The reader of the records of a preview and a single entry. */
  readonly records: RecordReader = {
    readAt: (offset, buffer) => this.readRecordFromFile(offset, buffer),
  };

  /** The reader of the records of a folder job or a zip job. */
  private readonly jobRecords: RecordReader = {
    readAt: (offset, buffer) => this.readJobRecord(offset, buffer),
  };

  /** Reads the local headers and the data. */
  override readAt(offset: number, buffer: Uint8Array): number {
    this.refuseAfterFailure();
    const held = super.readHeld(offset, buffer) || (this.jobWindow?.readHeld(offset, buffer) ?? 0);
    if (held > 0) {
      return held;
    }
    return this.guarded(() => super.readAt(offset, buffer));
  }

  /** Starts a job with its second window, and returns the reader of its
   *  records. */
  startJob(): RecordReader {
    if (this.jobWindow !== undefined) {
      throw new Error("A job is in progress");
    }
    this.jobWindow = new WindowReaderAt(this.file, this.reader, this.windowBytes);
    this.jobRows = 0;
    this.checkNext = false;
    this.refusal = undefined;
    return this.jobRecords;
  }

  /** Counts a row of the job. Call it one time for each output row, before the
   *  row starts. A zip opens a row two times, and that is one row. */
  startJobRow(): void {
    if (this.jobRows % JOB_CHECK_ROWS === 0) {
      this.checkNext = true;
    }
    this.jobRows++;
  }

  /** Ends the job and frees the second window. */
  endJob(): void {
    this.jobWindow?.close();
    this.jobWindow = undefined;
    this.checkNext = false;
    this.refusal = undefined;
  }

  /** The bytes of the second window. */
  get jobWindowBytes(): number {
    return this.jobWindow?.retainedBytes ?? 0;
  }

  override close(): void {
    this.endJob();
    super.close();
  }

  private readRecordFromFile(offset: number, buffer: Uint8Array): number {
    this.refuseAfterFailure();
    return this.guarded(() => super.readFile(offset, buffer));
  }

  private readJobRecord(offset: number, buffer: Uint8Array): number {
    this.refuseAfterFailure();
    if (this.checkNext) {
      this.checkNext = false;
      return this.readRecordFromFile(offset, buffer);
    }
    const job = this.jobWindow;
    if (job === undefined) {
      throw new Error("No job is in progress");
    }
    const held = job.readHeld(offset, buffer) || super.readHeld(offset, buffer);
    if (held > 0) {
      return held;
    }
    return this.guarded(() => job.readAt(offset, buffer));
  }

  /** After a failed read in a job, the job gets no more bytes: not from a window,
   *  and not from the file. */
  private refuseAfterFailure(): void {
    if (this.refusal !== undefined) {
      throw this.refusal.error;
    }
  }

  /** A failed read empties both windows, so no row gets their old bytes. */
  private guarded(read: () => number): number {
    try {
      return read();
    } catch (error) {
      this.dropWindow();
      this.jobWindow?.dropWindow();
      if (this.jobWindow !== undefined) {
        this.refusal = { error };
      }
      throw error;
    }
  }
}
