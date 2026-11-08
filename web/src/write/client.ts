// The UI side of the remux. It starts the lead worker and a
// pool of encoder workers, connects them with message ports, and stops
// them all when the remux ends. The write wasm loads only here, when the
// user saves a zstd copy.
//
// The pool size: one encoder for each spare core, at most
// `REMUX_MAX_WORKERS`, and only as many as the memory budget has room for
// (`REMUX_ENCODER_BYTES` and the credit `REMUX_INFLIGHT_BYTES` for each).
// The UI reserves the credit of all encoders on the shared counter, because
// those parts are JS memory in the same renderer process.
import * as Comlink from "comlink";
import {
  REMUX_ENCODER_BYTES,
  REMUX_INFLIGHT_BYTES,
  REMUX_MAX_WORKERS,
  WRITE_SLOTS_PER_WORKER,
  readReserve,
} from "../contracts";
import type { EncoderWorkerApi, LeadWorkerApi, RemuxReport, RemuxSink } from "../contracts";
import { Reservations } from "../memory";
import { memoryBytes, reservedBytes } from "./slots";

/** The memory of the lead in the pool size: its start memory, its step
 *  buffers and the records of the copy of a small archive. A large
 *  archive needs more; the lead checks its estimate before it starts. */
const LEAD_BYTES = 24 * 2 ** 20;

export interface RemuxStart {
  file: File;
  header: SharedArrayBuffer;
  /** The listed rows: the copy has the same rows. */
  rows: number;
  sink: RemuxSink;
  /** The progress buffer (`ExtractProgress` layout). */
  progress: SharedArrayBuffer;
  /** The hard stop of the session. */
  hard: number;
  /** The `marks` column of each page of the listed rows. */
  marks: Uint8Array[];
  /** The cores of the device. */
  cores?: number;
}

export interface RemuxRun {
  /** The encoders of the pool. */
  workers: number;
  /** Resolves with the report when the remux ends. All workers stop
   *  then, and their memory goes back to the budget. */
  report: Promise<RemuxReport>;
  /** The memory of the write workers, for the status bar. */
  memoryBytes(): number;
  /** Stops all workers at once (the archive closes). */
  stop(): void;
}

/** The pool size for `room` bytes of the budget. 0 when one encoder does
 *  not fit. */
export function poolSize(room: number, cores: number): number {
  const wanted = Math.min(REMUX_MAX_WORKERS, Math.max(1, Math.floor(cores) - 1));
  for (let count = wanted; count > 0; count--) {
    if (count * (REMUX_ENCODER_BYTES + REMUX_INFLIGHT_BYTES) + LEAD_BYTES <= room) return count;
  }
  return 0;
}

/** Starts a remux. Throws when the memory budget has no room for it. */
export function startRemux(start: RemuxStart): RemuxRun {
  const reservations = new Reservations(start.header, start.hard, readReserve(start.hard));
  const workers = poolSize(
    reservations.readRoom(),
    start.cores ?? navigator.hardwareConcurrency ?? 2,
  );
  if (workers === 0) {
    throw new Error("The memory limit leaves no room to save a zstd copy");
  }
  const inflight = workers * REMUX_INFLIGHT_BYTES;
  if (!reservations.reserveRead(inflight)) {
    throw new Error("The memory limit leaves no room to save a zstd copy");
  }
  const slots = new SharedArrayBuffer(4 * WRITE_SLOTS_PER_WORKER * (workers + 1));
  const all: Worker[] = [];
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const worker of all) worker.terminate();
    // The workers are gone: give back what they reserved, and the credit.
    reservations.releaseRead(reservedBytes(slots) + inflight);
    new Int32Array(slots).fill(0);
  };
  const leadWorker = new Worker(new URL("./lead.ts", import.meta.url), { type: "module" });
  all.push(leadWorker);
  const lead = Comlink.wrap<LeadWorkerApi>(leadWorker);
  const ports: MessagePort[] = [];
  const opened: Promise<void>[] = [];
  const options = { hard: start.hard };
  for (let index = 0; index < workers; index++) {
    const worker = new Worker(new URL("./encoder.ts", import.meta.url), { type: "module" });
    all.push(worker);
    const channel = new MessageChannel();
    ports.push(channel.port2);
    const api = Comlink.wrap<EncoderWorkerApi>(worker);
    opened.push(
      api.open(
        start.file,
        start.header,
        slots,
        index + 1,
        start.progress,
        Comlink.transfer(channel.port1, [channel.port1]),
        options,
      ),
    );
  }
  const failed = (error: unknown): RemuxReport => ({
    outcome: "failed",
    error: error instanceof Error ? error.message : String(error),
    written: 0,
    rows: start.rows,
    zstd: 0,
    kept: 0,
    folders: 0,
    bytes: 0,
    output: 0,
    items: [],
    more: 0,
  });
  const transfer: Transferable[] = [...ports];
  if (start.sink.kind === "stream") transfer.push(start.sink.port);
  // A worker that cannot load its module stops the remux.
  const crashed = new Promise<never>((_, reject) => {
    for (const worker of all) {
      worker.addEventListener("error", () => reject(new Error("A remux worker could not start")), {
        once: true,
      });
    }
  });
  const report = Promise.race([
    Promise.all(opened).then(() =>
      lead.run(
        start.file,
        start.header,
        slots,
        start.rows,
        Comlink.transfer(start.sink, transfer),
        start.progress,
        ports,
        { ...options, marks: start.marks },
      ),
    ),
    crashed,
  ])
    .catch(failed)
    .finally(stop);
  return { workers, report, memoryBytes: () => (stopped ? 0 : memoryBytes(slots)), stop };
}
