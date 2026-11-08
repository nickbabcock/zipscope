// The stream of a service-worker download: the worker side.
// The read worker (extraction) and the lead worker of the remux
// write their output through it.
import type { DownloadPortMessage } from "../contracts";

/** A stream chunk collects small outputs up to this size. The file of the
 *  save picker of the remux gets its writes in parts of this size too. */
export const CHUNK_BYTES = 1024 * 1024;

/** The job stops: the user cancelled, or the download stopped. */
export class Stopped extends Error {}

/** Writes the stream of a download: one chunk for each `pull` of the
 *  service worker. */
export class PortWriter {
  private pulls = 0;
  private waiting: (() => void) | undefined;
  private stopped = false;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;

  constructor(
    private readonly port: MessagePort,
    private readonly onStart: () => void,
  ) {
    port.onmessage = (event: MessageEvent<DownloadPortMessage>) => {
      if (event.data.type === "pull") {
        if (this.pulls === 0 && !this.stopped) this.onStart();
        this.pulls++;
      } else if (event.data.type === "cancel") {
        this.stopped = true;
      }
      this.waiting?.();
    };
    port.start();
  }

  /** True when the download stopped. */
  get cancelled(): boolean {
    return this.stopped;
  }

  /** Waits for a pull, or for the cancel of the download or of the UI. */
  private async pull(cancelled: () => boolean): Promise<void> {
    while (this.pulls === 0) {
      if (this.stopped || cancelled()) throw new Stopped("The download stopped");
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
        // The UI flag is a shared value, so check it again from time to
        // time.
        setTimeout(resolve, 250);
      });
      this.waiting = undefined;
    }
    this.pulls--;
  }

  /** Adds bytes, and sends a chunk when enough collected. */
  async write(bytes: Uint8Array, cancelled: () => boolean): Promise<void> {
    if (bytes.length === 0) return;
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    if (this.pendingBytes >= CHUNK_BYTES) await this.flush(cancelled);
  }

  async flush(cancelled: () => boolean): Promise<void> {
    if (this.pendingBytes === 0) return;
    const bytes = concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    await this.pull(cancelled);
    this.post({ type: "chunk", bytes }, [bytes.buffer]);
  }

  async end(cancelled: () => boolean): Promise<void> {
    await this.flush(cancelled);
    this.post({ type: "end" });
    this.port.close();
  }

  fail(message: string): void {
    this.post({ type: "error", message });
    this.port.close();
  }

  private post(message: DownloadPortMessage, transfer: Transferable[] = []): void {
    this.port.postMessage(message, transfer);
  }
}

/** The parts, in one buffer of `length` bytes. */
export function concat(parts: Uint8Array[], length: number): Uint8Array<ArrayBuffer> {
  if (parts.length === 1 && parts[0]!.buffer instanceof ArrayBuffer) {
    return parts[0] as Uint8Array<ArrayBuffer>;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
