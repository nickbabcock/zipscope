export interface RunOptions {
  /** Batches before the parser reports COMPLETE. */
  batches: number;
  reader?: "sync" | "prefetch";
  /** The batch that waits for the main thread to post its requests. */
  holdBatch: number;
  /** Time that each batch takes, in ms. */
  batchMs: number;
  /** Time that the held batch continues after the requests are posted. */
  settleMs: number;
}

export interface RunResult {
  /** "batch N" and "request N" in the order the worker ran them. */
  log: string[];
  /** Time between the end of a batch and the start of the next, in ms. */
  gaps: number[];
}

export interface YieldWorkerApi {
  run(control: SharedArrayBuffer, options: RunOptions): Promise<RunResult>;
  request(id: number): number;
}
