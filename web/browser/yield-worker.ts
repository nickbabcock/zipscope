// A worker that runs the real parse loop (src/parse/loop.ts) with a fake
// parser, and records the order of batches and Comlink requests.
import { WindowReaderAt } from "../src/parse/reader";
import { PrefetchReaderAt } from "../bench/reader/strategies";
import * as Comlink from "comlink";
import { HEADER_BYTES, State } from "../src/contracts";
import { parseInBatches } from "../src/parse/loop";
import type { BatchParser } from "../src/parse/loop";

import type { RunOptions, RunResult, YieldWorkerApi } from "./yield-types";

const spin = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Busy wait, as a real batch does.
  }
};

let log: string[] = [];

const api: YieldWorkerApi = {
  /**
   * Runs the loop. Slot 0 of `control` is the held batch number, which the
   * worker stores when the held batch starts. The main thread stores 1 in
   * slot 1 after it posts its requests.
   */
  async run(control: SharedArrayBuffer, options: RunOptions): Promise<RunResult> {
    const shared = new Int32Array(control);
    log = [];
    const gaps: number[] = [];
    let batch = 0;
    let lastEnd = 0;
    const file = new Blob([new Uint8Array((options.batches + 2) * 16)]);
    const reader =
      options.reader === "prefetch"
        ? new PrefetchReaderAt(file, new FileReaderSync(), 16)
        : options.reader === "sync"
          ? new WindowReaderAt(file, new FileReaderSync(), 16)
          : undefined;
    const parser: BatchParser = {
      parse(maxEntries) {
        const start = performance.now();
        if (lastEnd !== 0) {
          gaps.push(start - lastEnd);
        }
        batch++;
        reader?.readAt(batch * 16, new Uint8Array(4));
        log.push(`batch ${batch}`);
        if (batch === options.holdBatch) {
          Atomics.store(shared, 0, batch);
          Atomics.wait(shared, 1, 0, 10_000);
          // The requests are posted. Give them time to arrive in the queue.
          spin(options.settleMs);
        } else {
          spin(options.batchMs);
        }
        lastEnd = performance.now();
        return maxEntries;
      },
      state: () => (batch >= options.batches ? State.COMPLETE : State.PARSING),
      error: () => undefined,
      rows: () => batch,
      progress: () => batch / options.batches,
      columnPtr: () => 0,
      nameChunkCount: () => 0,
      nameChunkPtr: () => 0,
      nameChunkLength: () => 0,
      commentChunkCount: () => 0,
      commentChunkPtr: () => 0,
      commentChunkLength: () => 0,
      // No folders and empty views.
      refreshViews: () => false,
      mergeViews: () => false,
      mergePending: () => false,
      viewsBuilding: () => false,
      folderCount: () => 0,
      folderPtr: () => 0,
      rollupPtr: () => 0,
      folderUpdateCount: () => 0,
      folderUpdatesPtr: () => 0,
      clearFolderUpdates: () => {},
      permutationFolder: () => 0,
      permutationPtr: () => 0,
      permutationInfoPtr: () => 0,
      permutationLength: () => 0,
      treePtr: () => 0,
      treeLength: () => 0,
      rollupVersion: () => 0,
      permutationVersion: () => 0,
      treeVersion: () => 0,
      permutationLargest: () => 0,
    };
    await parseInBatches(
      parser,
      {
        publish() {
          if (reader instanceof PrefetchReaderAt) reader.prefetch();
        },
      },
      new SharedArrayBuffer(HEADER_BYTES),
    );
    if (reader instanceof PrefetchReaderAt) reader.stop();
    else reader?.close();
    return { log, gaps };
  },

  /** A view request. It records when it runs. */
  request(id: number): number {
    log.push(`request ${id}`);
    return id;
  },
};

Comlink.expose(api);
