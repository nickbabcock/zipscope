// Loads the preview of one entry from the read worker: the first bytes,
// then more on request. This file has no Solid and no DOM code, so the
// unit tests give a fake read worker.
import type { EntryCheck, ReadChunk } from "../contracts";
import { decodeText, imageType, previewKind } from "./sniff";
import type { DecodedText, PreviewKind } from "./sniff";

const MIB = 1024 * 1024;
/** The first read of an entry. */
export const FIRST_BYTES = MIB;
/** The reads again of the first bytes when a read gives no bytes. */
const EMPTY_READS = 4;
/** Each "Load more" of text. */
export const MORE_BYTES = MIB;
/** The most text that the preview decodes. */
export const TEXT_LIMIT = 16 * MIB;
/** The hex view shows this much at first, and this much more each time. */
export const HEX_STEP = 64 * 1024;
/** The most bytes that the hex view shows. */
export const HEX_LIMIT = MIB;
/** The largest image that the preview decodes. */
export const IMAGE_LIMIT = 32 * MIB;
const IMAGE_STEP = 4 * MIB;

/** True when `error` is the CRC-32 failure of the read worker: the data
 *  ended at its declared size, but its CRC-32 does not agree with the
 *  central directory. The text comes from `crates/read/src/stream.rs`. */
export function crcFailed(error: string | undefined): boolean {
  return error?.startsWith("The CRC-32 of the data is ") === true;
}

/** The read state of an entry that shows. */
interface Stream {
  row: number;
  check: EntryCheck;
  /** Bytes decoded so far. */
  loaded: number;
  /** Bytes that the view shows. */
  shown: number;
  /** The stream state of the read worker. */
  state: ReadChunk["state"];
  /** Why decoding stopped. The bytes before the error still show. */
  error: string | undefined;
  /** Why an image shows as hex. */
  note: string | undefined;
  /** True while "Load more" can show more. */
  more: boolean;
  /** True while a read runs. */
  busy: boolean;
}

/** What the preview pane shows: the entry loads, cannot show, or shows as
 *  text, hex or an image. */
export type PreviewView =
  | { status: "loading"; row: number }
  | { status: "error"; row: number; check: EntryCheck | undefined; error: string }
  | (Stream & { status: "ready"; kind: "text"; text: DecodedText })
  /** `bytes` are the bytes that show. The view makes the dump for its width. */
  | (Stream & { status: "ready"; kind: "hex"; bytes: Uint8Array })
  /** `image` is a Blob URL, or undefined until all bytes are verified. */
  | (Stream & { status: "ready"; kind: "image"; image: string | undefined });

export interface LoaderDeps {
  read(row: number, offset: number, bytes: number): Promise<ReadChunk>;
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
  /** Called with the check of each loaded row. */
  onCheck?(row: number, check: EntryCheck): void;
  /** Called when the data of a row does not agree with its CRC-32. */
  onCrcFailure?(row: number): void;
}

function append(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (head.length === 0) return tail;
  const out = new Uint8Array(head.length + tail.length);
  out.set(head);
  out.set(tail, head.length);
  return out;
}

/**
 * Makes one load for each target. Each load has its own state: its bytes,
 * its views and its image URL. Thus a load never checks for a newer load.
 * The owner of a load calls `cancel` when the target changes.
 */
export class EntryLoader {
  constructor(private readonly deps: LoaderDeps) {}

  /** Starts to load a row. The first view goes to `publish` before this
   *  returns. */
  load(
    row: number,
    name: string,
    declared: number,
    publish: (view: PreviewView) => void,
  ): EntryLoad {
    return new EntryLoad(this.deps, row, name, declared, publish);
  }
}

/** The load of one entry: the first bytes, then more on request. */
export class EntryLoad {
  /** Settles when the first view of the entry shows. */
  readonly done: Promise<void>;
  /** True after `cancel`. Then the load publishes nothing more. */
  private stopped = false;
  private bytes: Uint8Array = new Uint8Array(0);
  /** The entry that shows, after its first bytes came. */
  private stream: (Stream & { kind: PreviewKind }) | undefined;
  private view: PreviewView | undefined;
  private url: string | undefined;

  constructor(
    private readonly deps: LoaderDeps,
    private readonly row: number,
    name: string,
    declared: number,
    private readonly publish: (view: PreviewView) => void,
  ) {
    this.set({ status: "loading", row });
    this.done = this.first(name, declared);
  }

  /** Stops the load and releases its image URL. */
  cancel(): void {
    this.stopped = true;
    if (this.url !== undefined) {
      this.deps.revokeUrl(this.url);
      this.url = undefined;
    }
  }

  private async first(name: string, declared: number): Promise<void> {
    const row = this.row;
    let chunk: ReadChunk;
    try {
      chunk = await this.deps.read(row, 0, FIRST_BYTES);
      // The kind comes from the first bytes, so never take it from a chunk
      // with no bytes while the entry has more. Read again a few times.
      for (let tries = 0; chunk.bytes.length === 0 && chunk.state === "reading"; tries++) {
        if (tries === EMPTY_READS || this.stopped) break;
        chunk = await this.deps.read(row, 0, FIRST_BYTES);
      }
    } catch (err) {
      this.fail(undefined, err);
      return;
    }
    if (this.stopped) return;
    this.deps.onCheck?.(row, chunk.check);
    if (chunk.bytes.length === 0 && chunk.state === "reading") {
      this.set({
        status: "error",
        row,
        check: chunk.check,
        error: "The entry gave no data to preview",
      });
      return;
    }
    if (chunk.check.error !== undefined) {
      this.set({ status: "error", row, check: chunk.check, error: chunk.check.error });
      return;
    }
    let kind = previewKind(name, chunk.bytes);
    let note: string | undefined;
    if (kind === "image" && declared > IMAGE_LIMIT) {
      kind = "hex";
      note = "This image is larger than 32\u00a0MiB, so it shows as hex.";
    }
    this.stream = {
      row,
      kind,
      check: chunk.check,
      loaded: 0,
      shown: 0,
      state: "reading",
      error: undefined,
      note,
      more: false,
      busy: true,
    };
    this.take(chunk);
    if (kind === "image") {
      this.set({ ...this.stream, status: "ready", kind: "image", image: undefined });
      await this.loadImage(name);
    } else {
      this.render();
    }
  }

  /** Shows more of the entry. */
  async more(): Promise<void> {
    const view = this.view;
    const stream = this.stream;
    if (view?.status !== "ready" || stream === undefined || !view.more || view.busy) return;
    if (stream.kind === "hex" && view.shown < view.loaded) {
      this.render(view.shown + HEX_STEP);
      return;
    }
    this.set({ ...view, busy: true });
    const step = stream.kind === "hex" ? HEX_STEP * 4 : MORE_BYTES;
    let chunk: ReadChunk;
    try {
      chunk = await this.deps.read(stream.row, this.bytes.length, step);
    } catch (err) {
      this.fail(stream.check, err);
      return;
    }
    if (this.stopped) return;
    this.take(chunk);
    this.render(stream.kind === "hex" ? view.shown + HEX_STEP : undefined);
  }

  private async loadImage(name: string): Promise<void> {
    const stream = this.stream!;
    while (stream.state === "reading" && this.bytes.length <= IMAGE_LIMIT) {
      let chunk: ReadChunk;
      try {
        chunk = await this.deps.read(stream.row, this.bytes.length, IMAGE_STEP);
      } catch (err) {
        this.fail(stream.check, err);
        return;
      }
      if (this.stopped) return;
      this.take(chunk);
    }
    const type = imageType(name, this.bytes);
    if (stream.state !== "verified" || type === undefined) {
      // A bad image shows as hex, with the error.
      stream.kind = "hex";
      stream.note = stream.error === undefined ? "The image data is not complete." : undefined;
      this.render();
      return;
    }
    this.url = this.deps.createUrl(new Blob([this.bytes as Uint8Array<ArrayBuffer>], { type }));
    stream.shown = this.bytes.length;
    stream.busy = false;
    this.set({ ...stream, status: "ready", kind: "image", image: this.url });
  }

  /** Adds the bytes of a chunk to the stream. */
  private take(chunk: ReadChunk): void {
    const stream = this.stream!;
    if (chunk.offset === this.bytes.length) {
      this.bytes = append(this.bytes, chunk.bytes);
    }
    stream.loaded = this.bytes.length;
    stream.state = chunk.state;
    stream.error = chunk.error;
    if (chunk.state === "failed" && crcFailed(chunk.error)) this.deps.onCrcFailure?.(stream.row);
  }

  /** Makes the text or the hex dump from the loaded bytes. */
  private render(hexShown?: number): void {
    const stream = this.stream!;
    const loaded = this.bytes.length;
    const reading = stream.state === "reading";
    stream.busy = false;
    if (stream.kind === "text") {
      stream.shown = loaded;
      stream.more = reading && loaded < TEXT_LIMIT;
      const text = decodeText(this.bytes, stream.state === "verified");
      this.set({ ...stream, status: "ready", kind: "text", text });
      return;
    }
    const shown = Math.min(hexShown ?? HEX_STEP, loaded, HEX_LIMIT);
    stream.shown = shown;
    stream.more = shown < HEX_LIMIT && (shown < loaded || reading);
    this.set({ ...stream, status: "ready", kind: "hex", bytes: this.bytes.subarray(0, shown) });
  }

  private fail(check: EntryCheck | undefined, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.set({ status: "error", row: this.row, check, error: message });
  }

  private set(view: PreviewView): void {
    if (this.stopped) return;
    this.view = view;
    this.publish(view);
  }
}
