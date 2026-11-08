export interface SyncBlobReader {
  readAsArrayBuffer(blob: Blob): ArrayBuffer;
}

export class FileReaderAt {
  private source: { file: Blob; reader: SyncBlobReader } | undefined;

  constructor(file: Blob, reader: SyncBlobReader) {
    this.source = { file, reader };
  }

  protected get file(): Blob {
    if (!this.source) throw new Error("Reader is closed");
    return this.source.file;
  }

  protected get reader(): SyncBlobReader {
    if (!this.source) throw new Error("Reader is closed");
    return this.source.reader;
  }

  readAt(offset: number, buffer: Uint8Array): number {
    const bytes = this.reader.readAsArrayBuffer(this.file.slice(offset, offset + buffer.length));
    buffer.set(new Uint8Array(bytes));
    return bytes.byteLength;
  }

  close(): void {
    this.source = undefined;
  }
}

/** Keeps one window in JS memory. Reads can stop at the window end. */
export class WindowReaderAt extends FileReaderAt {
  protected windowStart = 0;
  protected window = new Uint8Array(0);

  constructor(
    file: Blob,
    reader: SyncBlobReader,
    protected readonly windowBytes: number = 4 * 1024 * 1024,
  ) {
    super(file, reader);
    if (!Number.isSafeInteger(windowBytes) || windowBytes <= 0) {
      throw new RangeError("Invalid reader window size");
    }
  }

  protected fill(offset: number): Uint8Array<ArrayBuffer> {
    return new Uint8Array(
      this.reader.readAsArrayBuffer(this.file.slice(offset, offset + this.windowBytes)),
    );
  }

  readAt(offset: number, buffer: Uint8Array): number {
    const length = Math.min(buffer.length, Math.max(0, this.file.size - offset));
    if (length === 0) {
      return 0;
    }
    if (length >= this.windowBytes) {
      this.window = new Uint8Array(0);
      return super.readAt(offset, buffer);
    }
    if (offset < this.windowStart || offset >= this.windowStart + this.window.length) {
      // Release the old buffer before the next read allocates a buffer.
      this.window = new Uint8Array(0);
      this.window = this.fill(offset);
      this.windowStart = offset;
    }
    const skip = offset - this.windowStart;
    const count = Math.min(length, this.window.length - skip);
    buffer.set(this.window.subarray(skip, skip + count));
    return count;
  }

  /** Copies the bytes at `offset` that the window holds, and does not read
   *  the file. Returns 0 when the window does not hold the first byte. */
  readHeld(offset: number, buffer: Uint8Array): number {
    const skip = offset - this.windowStart;
    if (skip < 0 || skip >= this.window.length) {
      return 0;
    }
    const count = Math.min(buffer.length, this.window.length - skip);
    buffer.set(this.window.subarray(skip, skip + count));
    return count;
  }

  /** Reads from the file, also when the window holds the bytes. The window
   *  stays. */
  readFile(offset: number, buffer: Uint8Array): number {
    if (offset >= this.file.size || buffer.length === 0) {
      return 0;
    }
    return super.readAt(offset, buffer);
  }

  /** Removes the bytes of the window. */
  dropWindow(): void {
    this.window = new Uint8Array(0);
  }

  get retainedBytes(): number {
    return this.window.byteLength;
  }

  close(): void {
    this.window = new Uint8Array(0);
    super.close();
  }
}
