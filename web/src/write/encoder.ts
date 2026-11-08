// An encoder worker of the remux pool. It gets the rows of
// the lead on its port, verifies each row through the verifying reader
// and sends its new data in parts: Zstandard, stored, or the compressed
// bytes of the archive as they are. The output of a row starts only after
// its data verified, so a row that does not verify sends no bytes and the
// copy leaves it out.
//
// Flow control: the encoder sends at most its credit of bytes that the
// lead did not take yet. The lead takes the rows in order, so the parts of
// a row that waits for an earlier row stay in this bounded credit.
import * as Comlink from "comlink";
import {
  ExtractProgress,
  ExtractSkip,
  PROGRESS_FLAGS_OFFSET,
  REMUX_INFLIGHT_BYTES,
} from "../contracts";
import type {
  EncodeJob,
  EncodePart,
  EncoderMessage,
  EncoderWorkerApi,
  LeadMessage,
} from "../contracts";
import { WindowReaderAt } from "../parse/reader";
import init, { RemuxEncoder } from "../wasm/zipscope_write.js";
import { WriteMemory } from "./memory";

/** The most decoded bytes in one step. */
const STEP_BYTES = 1024 * 1024;
/** The heap of a step in addition to its output: the decoder state and
 *  the Zstandard context. */
const STEP_SLACK_BYTES = 4 * 1024 * 1024;
/** The largest Zstandard window of the source data (32 MiB). */
const MAX_WINDOW_BYTES = 32 * 1024 * 1024;
/** Entries up to this size are decoded one time (`KEEP_BYTES` in
 *  crates/write/src/encode.rs). */
const KEEP_BYTES = 4 * 1024 * 1024;
/** A batch of parts goes to the lead at this size, or at the end of the
 *  jobs that are ready. */
const BATCH_BYTES = 1024 * 1024;
const BATCH_PARTS = 256;
/** A batch also goes to the lead at once when the last message to the
 *  lead is this old (ms). In the verify pass of a large row, a part has
 *  no bytes, so without this a slow source could keep the lead without a
 *  message for 256 steps. The age starts at the last message, not at the
 *  first part of the batch, so the first part that comes after this time
 *  goes at once. Thus the lead hears from a live encoder at least once in
 *  this time and one step that goes forward. */
const BATCH_MS = 1000;
/** The most bytes of one part: the kept data of a small entry, or its
 *  Zstandard form, with room. */
const PART_BYTES = KEEP_BYTES + 256 * 1024;
/** The memory error of the steps that cannot allocate their text. */
const MEMORY_TEXT = "The memory limit leaves no room for this step";
/** Steps between two turns for the messages of the lead. */
const TURN_STEPS = 4;
/** The most steps in a row that go nowhere. */
const MAX_EMPTY_STEPS = 256;

/** Waits for the next turn, so that the messages of the lead run. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

const api: EncoderWorkerApi = {
  async open(file, header, slots, index, progress, port, options) {
    const wasm = await init();
    const memory = new WriteMemory(header, slots, index, () => wasm.memory.buffer, options.hard);
    const flags = new Int32Array(progress, PROGRESS_FLAGS_OFFSET, 2);
    const reader = new WindowReaderAt(file, new FileReaderSync());
    memory.arm();
    const encoder = RemuxEncoder.open(reader, file.size);
    memory.publish();
    const worker = new Encoder(encoder, memory, flags, port);
    void worker.run();
  },
};

class Encoder {
  private readonly jobs: EncodeJob[] = [];
  private credit = REMUX_INFLIGHT_BYTES;
  private wake: (() => void) | undefined;
  private batch: EncodePart[] = [];
  private batchBytes = 0;
  /** The time of the last message to the lead (`performance.now()`). */
  private lastFlush = performance.now();

  constructor(
    private readonly encoder: RemuxEncoder,
    private readonly memory: WriteMemory,
    private readonly flags: Int32Array,
    private readonly port: MessagePort,
  ) {
    port.onmessage = (event: MessageEvent<LeadMessage>) => {
      const message = event.data;
      if (message.type === "jobs") this.jobs.push(...message.jobs);
      else this.credit += message.bytes;
      this.wake?.();
    };
    port.start();
  }

  private cancelled(): boolean {
    return Atomics.load(this.flags, ExtractProgress.CANCEL) !== 0;
  }

  /** Waits for a message of the lead, or for a cancel. */
  private async idle(): Promise<void> {
    this.flush();
    await new Promise<void>((resolve) => {
      this.wake = resolve;
      // The cancel flag is a shared value: check it from time to time.
      setTimeout(resolve, 250);
    });
    this.wake = undefined;
  }

  private send(part: EncodePart): void {
    this.batch.push(part);
    this.batchBytes += part.bytes.length;
    if (
      this.batchBytes >= BATCH_BYTES ||
      this.batch.length >= BATCH_PARTS ||
      performance.now() - this.lastFlush >= BATCH_MS
    ) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.batch.length === 0) return;
    const message: EncoderMessage = { type: "parts", parts: this.batch };
    this.port.postMessage(
      message,
      this.batch.map((part) => part.bytes.buffer as ArrayBuffer),
    );
    this.batch = [];
    this.batchBytes = 0;
    this.lastFlush = performance.now();
  }

  /** The Zstandard window of the source data: the free heap less a
   *  step. */
  private window(): number {
    return Math.min(
      MAX_WINDOW_BYTES,
      Math.max(0, this.memory.free() - 3 * STEP_BYTES - STEP_SLACK_BYTES),
    );
  }

  async run(): Promise<void> {
    for (;;) {
      if (this.cancelled()) return;
      const job = this.jobs.shift();
      if (job === undefined) {
        await this.idle();
        continue;
      }
      try {
        await this.encode(job);
      } catch (error) {
        // A JS error or a wasm trap. A trap leaves the wasm instance in an
        // unknown state, so the encoder stops: the row fails, and the
        // lead fails the copy, so the lead never waits for this encoder.
        this.send({
          row: job.row,
          bytes: new Uint8Array(0),
          decoded: 0,
          end: "failed",
          skip: ExtractSkip.VERIFY,
          error: `The encoder stopped: ${error instanceof Error ? error.message : String(error)}`,
        });
        this.flush();
        return;
      }
      if (this.jobs.length === 0) this.flush();
    }
  }

  private async encode(job: EncodeJob): Promise<void> {
    const { encoder, memory } = this;
    memory.arm();
    const start = encoder.start(job.record, job.base, job.offset, job.row, this.window());
    memory.publish();
    const skip = start.skip;
    // A memory skip has no text from the wasm: that path does not
    // allocate.
    const error = start.error ?? (skip === 0 ? undefined : MEMORY_TEXT);
    start.free();
    if (error !== undefined) {
      this.send({
        row: job.row,
        bytes: new Uint8Array(0),
        decoded: job.uncompressed,
        end: "skip",
        skip: (skip === 0 ? ExtractSkip.VERIFY : skip) as ExtractSkip,
        error,
      });
      encoder.end();
      return;
    }
    // The progress counts the decoded bytes of each pass. A large entry
    // has two passes, so each pass counts half.
    const weight = job.uncompressed <= KEEP_BYTES ? 1 : 0.5;
    let counted = 0;
    let lastProduced = 0;
    let lastState = 0;
    let sentBytes = false;
    let empty = 0;
    let steps = 0;
    for (;;) {
      if (this.cancelled()) {
        encoder.end();
        return;
      }
      // One part is at most `PART_BYTES`, so the parts that the lead did
      // not take stay below the credit that the UI reserved.
      while (this.credit < PART_BYTES) {
        await this.idle();
        if (this.cancelled()) {
          encoder.end();
          return;
        }
      }
      memory.arm();
      const bytes = encoder.step(STEP_BYTES, this.window());
      memory.publish();
      const state = encoder.state();
      if (state !== lastState) lastProduced = 0;
      const produced = encoder.produced();
      const pass = state === 0 || (state === 3 && weight < 1) ? weight : 0;
      const decoded = Math.max(0, produced - lastProduced) * pass;
      const went = bytes.length > 0 || produced !== lastProduced || state !== lastState;
      lastProduced = produced;
      lastState = state;
      counted += decoded;
      empty = went ? 0 : empty + 1;
      const part: EncodePart = { row: job.row, bytes, decoded };
      if (bytes.length > 0 || state === 1) {
        if (!sentBytes) part.method = encoder.method();
        sentBytes = true;
      }
      if (state === 1) {
        part.end = "done";
        part.decoded += Math.max(0, job.uncompressed - counted - decoded);
      } else if (state === 2 || empty > MAX_EMPTY_STEPS) {
        const message = encoder.memoryFailed()
          ? MEMORY_TEXT
          : (encoder.error() ?? "Decoding did not go forward");
        part.end = sentBytes ? "failed" : "skip";
        part.skip = /memory limit/.test(message) ? ExtractSkip.MEMORY : ExtractSkip.VERIFY;
        part.error = message;
        if (!sentBytes) part.decoded += Math.max(0, job.uncompressed - counted - decoded);
      }
      if (part.bytes.length > 0 || part.end !== undefined || part.decoded > 0) {
        this.credit -= bytes.length;
        this.send(part);
      }
      if (part.end !== undefined) {
        encoder.end();
        return;
      }
      // Let the messages of the lead (credit, jobs) run from time to time.
      if (++steps % TURN_STEPS === 0) await nextTurn();
    }
  }
}

Comlink.expose(api);
