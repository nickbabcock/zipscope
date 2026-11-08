// The messages of `reservation-worker.ts`.

export interface ReserveJob {
  header: SharedArrayBuffer;
  /** Slot 0: the start signal. Slot 1: the workers that wait for it. */
  start: SharedArrayBuffer;
  hardBytes: number;
  reserveBytes: number;
  side: "store" | "read";
  stepBytes: number;
  release: boolean;
}

export interface ReserveResult {
  taken: number;
}
