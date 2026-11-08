import { WindowReaderAt } from "../../src/parse/reader.ts";

/** Starts at most one read between batches. The loop never waits for it. */
export class PrefetchReaderAt extends WindowReaderAt {
  private pending = false;
  private ready: { offset: number; bytes: Uint8Array<ArrayBuffer> } | undefined;
  private pendingBytes = 0;
  private stopped = false;
  peakBytes = 0;
  hits = 0;

  prefetch(): void {
    const offset = this.windowStart + this.window.length;
    if (this.stopped || this.pending || this.ready !== undefined || offset >= this.file.size) {
      return;
    }
    this.pending = true;
    this.pendingBytes = Math.min(this.windowBytes, this.file.size - offset);
    this.peakBytes = Math.max(this.peakBytes, this.retainedBytes);
    void this.file
      .slice(offset, offset + this.windowBytes)
      .arrayBuffer()
      .then(
        (bytes) => {
          this.pending = false;
          this.pendingBytes = 0;
          this.peakBytes = Math.max(this.peakBytes, this.retainedBytes + bytes.byteLength);
          if (!this.stopped && this.windowStart + this.window.length === offset) {
            this.ready = { offset, bytes: new Uint8Array(bytes) };
          }
        },
        () => {
          this.pending = false;
          this.pendingBytes = 0;
        },
      );
  }

  protected fill(offset: number): Uint8Array<ArrayBuffer> {
    const ready = this.ready;
    this.ready = undefined;
    if (ready?.offset === offset) {
      this.hits++;
      return ready.bytes;
    }
    return super.fill(offset);
  }

  get retainedBytes(): number {
    return super.retainedBytes + (this.ready?.bytes.byteLength ?? 0) + this.pendingBytes;
  }

  stop(): void {
    this.stopped = true;
    this.ready = undefined;
    this.pendingBytes = 0;
    this.close();
  }
}
