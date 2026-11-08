// The lead worker of the remux. It reads the central
// directory in order, gives each file to an encoder of the pool, and
// writes the copy in row order with rawzip's writer (the write wasm) to
// the file of the save picker or to a streamed download.
//
// The lead reads the records and the local headers through two windows of
// the read rule of extraction (`RowReaderAt`): the records through the
// window of a job, with a read of the file each `JOB_CHECK_ROWS` rows, and
// the local headers through the first window. With one window, each row
// replaced the window two times.
//
// The rows go to the encoders ahead of the row that the copy writes, up
// to a bounded look-ahead. Each encoder works on its rows in order, so the
// lead can always take the parts of the next row. The output never sits
// in memory: each part goes to the sink when its row is next.
//
// A failed or cancelled remux aborts the output: the writable of the
// picker is aborted (the file keeps its old content), and the download
// stream errors (the browser marks it as failed). The copy then has no
// end records.
import * as Comlink from "comlink";
import {
  ExtractProgress,
  ExtractSkip,
  MAX_REPORT_ITEMS,
  Marks,
  PAGE_ROWS,
  PROGRESS_FLAGS_OFFSET,
  WRAPPED_REASON,
} from "../contracts";
import type {
  EncodeJob,
  EncodePart,
  EncoderMessage,
  LeadMessage,
  LeadWorkerApi,
  RemuxReport,
  RemuxSink,
} from "../contracts";
import { CHUNK_BYTES, PortWriter, Stopped, concat } from "../read/port";
import { RowReaderAt } from "../read/row-reader";
import { integers } from "../format";
import init, { RemuxLead, remuxEstimate } from "../wasm/zipscope_write.js";
import { WriteMemory } from "./memory";

/** The most output bytes that one take gives. */
const TAKE_BYTES = 4 * 1024 * 1024;
/** The rows that the lead reads ahead of the row that it writes, for
 *  each encoder. */
const AHEAD_ROWS = 64;
/** The most record bytes that the jobs ahead hold. */
const AHEAD_BYTES = 8 * 1024 * 1024;
/** Credit goes back to an encoder when it reaches this size, or before
 *  the lead waits. */
const CREDIT_BYTES = 256 * 1024;
/** Why the copy leaves out a row with too many extra fields. */
const ZIP64_TEXT = "The extra fields of the entry leave no room for the zip64 field of the copy";
/** Rows between two turns, so that the parts of the encoders come in. */
const TURN_ROWS = 64;

/** Where the bytes of the copy go. */
interface Out {
  write(bytes: Uint8Array): Promise<void>;
  end(): Promise<void>;
  abort(message: string): Promise<void>;
}

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

/** The time of one wait of the lead for a part (ms). */
const WAIT_MS = 250;
/** The waits in sequence with no message from the encoder of the next row
 *  before the lead fails the copy (60 s). An encoder sends its batch at
 *  once when its last message is 1 s old (`BATCH_MS` in encoder.ts), and
 *  it sends a part after each step of at most 1 MiB that goes forward.
 *  Thus only an encoder that went away, or whose one step takes more than
 *  about 59 s, stays silent this long. The lead counts waits, not the
 *  clock, so a computer that sleeps does not fail a copy. */
const SILENT_WAITS = 240;

/** One encoder of the pool, from the side of the lead. */
class Pool {
  /** Parts by row, as they come. */
  private readonly parts = new Map<number, EncodePart[]>();
  private waiting: { row: number; resolve: () => void } | undefined;
  /** The uncompressed bytes of the rows that each encoder has. */
  private readonly load: number[];
  private readonly credit: number[];
  /** The waits in sequence with no message from each encoder. */
  private readonly silent: number[];
  private readonly owner = new Map<number, number>();

  constructor(private readonly ports: MessagePort[]) {
    this.load = ports.map(() => 0);
    this.credit = ports.map(() => 0);
    this.silent = ports.map(() => 0);
    ports.forEach((port, index) => {
      port.onmessage = (event: MessageEvent<EncoderMessage>) => {
        this.silent[index] = 0;
        for (const part of event.data.parts) {
          const list = this.parts.get(part.row);
          if (list === undefined) this.parts.set(part.row, [part]);
          else list.push(part);
        }
        const waiting = this.waiting;
        if (waiting !== undefined && this.parts.has(waiting.row)) {
          this.waiting = undefined;
          waiting.resolve();
        }
      };
      port.start();
    });
  }

  /** Gives jobs to the encoders: each job to the encoder with the least
   *  work. */
  dispatch(jobs: EncodeJob[]): void {
    const batches = this.ports.map((): EncodeJob[] => []);
    for (const job of jobs) {
      let best = 0;
      for (let index = 1; index < this.load.length; index++) {
        if (this.load[index]! < this.load[best]!) best = index;
      }
      // A row also costs a little when it is empty.
      this.load[best]! += job.uncompressed + 4096;
      this.owner.set(job.row, best);
      batches[best]!.push(job);
    }
    batches.forEach((batch, index) => {
      if (batch.length === 0) return;
      const message: LeadMessage = { type: "jobs", jobs: batch };
      this.ports[index]!.postMessage(
        message,
        batch.map((job) => job.record.buffer as ArrayBuffer),
      );
    });
  }

  /** Gives back the credit of `bytes` that the lead took from the encoder
   *  of `row`. */
  took(row: number, bytes: number, uncompressed: number, last: boolean): void {
    const index = this.owner.get(row);
    if (index === undefined) return;
    this.credit[index]! += bytes;
    if (this.credit[index]! >= CREDIT_BYTES) this.flushCredit(index);
    if (last) {
      this.load[index]! -= uncompressed + 4096;
      this.owner.delete(row);
    }
  }

  private flushCredit(index: number): void {
    const bytes = this.credit[index]!;
    if (bytes === 0) return;
    this.credit[index] = 0;
    const message: LeadMessage = { type: "credit", bytes };
    this.ports[index]!.postMessage(message);
  }

  /** The next part of `row`. */
  async next(row: number, cancelled: () => boolean): Promise<EncodePart> {
    for (;;) {
      const list = this.parts.get(row);
      const part = list?.shift();
      if (part !== undefined) {
        if (list!.length === 0) this.parts.delete(row);
        return part;
      }
      if (cancelled()) throw new Stopped("The remux was cancelled");
      this.credit.forEach((_, index) => this.flushCredit(index));
      await new Promise<void>((resolve) => {
        this.waiting = { row, resolve };
        // The cancel flag is a shared value: check it from time to time.
        setTimeout(resolve, WAIT_MS);
      });
      // A message for the row clears `waiting` before it resolves.
      const timedOut = this.waiting !== undefined;
      this.waiting = undefined;
      const index = this.owner.get(row);
      if (timedOut && index !== undefined && ++this.silent[index]! >= SILENT_WAITS) {
        // A terminated worker sends no `error` event, so without this
        // check the copy would wait at 0% until Cancel.
        throw new Error(
          `The encoder of row ${row} sent nothing for ${(SILENT_WAITS * WAIT_MS) / 1000} s, so the copy is not complete. Try again.`,
        );
      }
    }
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function output(
  sink: RemuxSink,
  onStart: () => void,
  cancelled: () => boolean,
): Promise<Out> {
  if (sink.kind === "file") {
    const writable = await sink.handle.createWritable();
    onStart();
    // Each write of the writable costs about 1.3 ms, also for a small row.
    // Thus the small outputs go to the file
    // in parts of `CHUNK_BYTES`, as in the stream of a download.
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (pendingBytes === 0) return;
      const bytes = concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      await writable.write(bytes);
    };
    return {
      write: async (bytes) => {
        if (bytes.length === 0) return;
        pending.push(bytes);
        pendingBytes += bytes.length;
        if (pendingBytes >= CHUNK_BYTES) await flush();
      },
      end: async () => {
        await flush();
        await writable.close();
      },
      // `abort` drops the written bytes and keeps the file as it was. The
      // picker can give a file that has the data of the user, so the
      // worker never removes it.
      abort: () => writable.abort().catch(() => {}),
    };
  }
  const writer = new PortWriter(sink.port, onStart);
  return {
    write: (bytes) => writer.write(bytes, cancelled),
    end: () => writer.end(cancelled),
    abort: async (text) => writer.fail(text),
  };
}

const api: LeadWorkerApi = {
  async run(file, header, slots, rows, sink, progress, ports, options) {
    const wasm = await init();
    const memory = new WriteMemory(header, slots, 0, () => wasm.memory.buffer, options.hard);
    const values = new Float64Array(progress, 0, 4);
    const flags = new Int32Array(progress, PROGRESS_FLAGS_OFFSET, 2);
    const cancelled = () => Atomics.load(flags, ExtractProgress.CANCEL) !== 0;
    const report: RemuxReport = {
      outcome: "complete",
      written: 0,
      rows,
      zstd: 0,
      kept: 0,
      folders: 0,
      bytes: 0,
      output: 0,
      items: [],
      more: 0,
    };
    const leaveOut = (row: number, skip: ExtractSkip, detail: string) => {
      if (report.items.length < MAX_REPORT_ITEMS) report.items.push({ row, skip, detail });
      else report.more++;
    };
    const pool = new Pool(ports);
    const reader = new RowReaderAt(file, new FileReaderSync());
    let out: Out | undefined;
    let lead: RemuxLead | undefined;
    try {
      const records = reader.startJob();
      memory.arm();
      lead = RemuxLead.open(reader, records, file.size, rows);
      memory.publish();
      const estimate = remuxEstimate(rows, lead.directoryBytes());
      if (!memory.fits(estimate)) {
        throw new Error(
          `The memory limit leaves no room for the central directory of the copy (${integers.format(rows)} entries)`,
        );
      }
      const target = lead;
      out = await output(sink, () => Atomics.store(flags, ExtractProgress.STARTED, 1), cancelled);
      const sinkOut = out;
      const drain = async () => {
        while (target.pending() > 0) {
          const bytes = target.take(TAKE_BYTES);
          report.output += bytes.length;
          await sinkOut.write(bytes);
        }
      };
      /** The kind of each row that the lead read ahead: 0 file, 1 folder,
       *  2 left out (with its skip code and reason). */
      const ahead = new Map<
        number,
        { kind: number; skip: number; reason: string; size: number; recordBytes: number }
      >();
      /** True for a row that no read may use: a preview and an extraction
       *  refuse it too. */
      const wrapped = (row: number) =>
        ((options.marks?.[Math.floor(row / PAGE_ROWS)]?.[row % PAGE_ROWS] ?? 0) &
          Marks.WRAPPED_OFFSET) !==
        0;
      let read = 0;
      let aheadBytes = 0;
      const readAhead = (row: number) => {
        const jobs: EncodeJob[] = [];
        const limit = Math.min(rows, row + AHEAD_ROWS * Math.max(1, ports.length));
        while (read < limit && (read === row || aheadBytes < AHEAD_BYTES)) {
          // A row starts when the lead reads its record.
          reader.startJobRow();
          memory.arm();
          const job = target.job(read);
          memory.publish();
          // A folder row has no data to read, so it stays in the copy.
          const refused = job.kind !== 1 && wrapped(read);
          // The getter copies the record, so read it one time.
          const record = job.kind === 0 && !refused ? job.record : undefined;
          ahead.set(read, {
            kind: refused ? 2 : job.kind,
            skip: refused ? ExtractSkip.LOCAL_HEADER : job.skip,
            reason: refused ? WRAPPED_REASON : (job.reason ?? ""),
            size: job.uncompressed,
            recordBytes: job.held,
          });
          // The lead keeps the record and the local extra fields of each
          // row until it writes the row.
          aheadBytes += job.held;
          if (record !== undefined) {
            jobs.push({
              row: read,
              record,
              base: job.base,
              offset: job.offset,
              uncompressed: job.uncompressed,
            });
          }
          job.free();
          read++;
        }
        pool.dispatch(jobs);
      };
      for (let row = 0; row < rows; row++) {
        if (cancelled()) throw new Stopped("The remux was cancelled");
        readAhead(row);
        const info = ahead.get(row)!;
        ahead.delete(row);
        aheadBytes -= info.recordBytes;
        if (info.kind === 1) {
          memory.arm();
          if (target.folder(row)) {
            report.written++;
            report.folders++;
          } else {
            leaveOut(row, ExtractSkip.WRITE, ZIP64_TEXT);
          }
        } else if (info.kind === 2) {
          target.leaveOut(row, info.reason);
          leaveOut(row, info.skip as ExtractSkip, info.reason);
          values[ExtractProgress.BYTES]! += info.size;
        } else {
          let begun = false;
          let dropped = false;
          let method = 0;
          for (;;) {
            const part = await pool.next(row, cancelled);
            values[ExtractProgress.BYTES]! += part.decoded;
            if (part.end === "skip" && part.skip === ExtractSkip.MEMORY) {
              // The device, not the archive, stopped the row: a copy
              // without it is not a copy of the archive.
              throw new Error(
                `The memory limit left no room for row ${row}, so the copy is not complete. Close other tabs or previews, then try again.`,
              );
            }
            if (part.end === "skip") {
              target.leaveOut(row, part.error ?? "");
              leaveOut(row, part.skip ?? ExtractSkip.VERIFY, part.error ?? "");
              pool.took(row, 0, info.size, true);
              break;
            }
            if (part.end === "failed") {
              // An encoder that throws before its first output also sends
              // "failed", so say "written" only when the copy has a part
              // of the row.
              throw new Error(
                begun
                  ? `Row ${row} stopped after a part of its data was written: ${part.error ?? ""}`
                  : `Row ${row} failed: ${part.error ?? ""}`,
              );
            }
            if (!begun && !dropped && part.method !== undefined) {
              method = part.method;
              memory.arm();
              if (target.begin(row, method)) {
                begun = true;
              } else {
                // The copy left the row out before its data: drop its
                // parts.
                dropped = true;
                leaveOut(row, ExtractSkip.WRITE, ZIP64_TEXT);
              }
            }
            if (dropped) {
              pool.took(row, part.bytes.length, info.size, part.end === "done");
              if (part.end === "done") break;
              continue;
            }
            if (part.bytes.length > 0) {
              memory.arm();
              target.write(part.bytes);
            }
            pool.took(row, part.bytes.length, info.size, part.end === "done");
            memory.publish();
            await drain();
            if (part.end === "done") {
              memory.arm();
              target.end();
              report.written++;
              report.bytes += info.size;
              if (method === 93) report.zstd++;
              else report.kept++;
              break;
            }
          }
        }
        memory.publish();
        await drain();
        values[ExtractProgress.FILES] = row + 1;
        if ((row + 1) % TURN_ROWS === 0) await nextTurn();
      }
      memory.arm();
      target.finish();
      memory.publish();
      await drain();
      await out.end();
    } catch (error) {
      report.outcome = error instanceof Stopped || cancelled() ? "cancelled" : "failed";
      if (report.outcome === "failed") report.error = message(error);
      await out?.abort(report.error ?? "The remux was cancelled");
    } finally {
      memory.publish();
      lead?.free();
      reader.endJob();
    }
    return report;
  },
};

Comlink.expose(api);
