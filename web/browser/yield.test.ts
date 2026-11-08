// The parse loop yields with a MessageChannel self-ping. The ping must
// queue behind messages that are already waiting, so that a Comlink
// request runs between two batches and not after the parse ends.
import * as Comlink from "comlink";
import { expect, test } from "vitest";
import type { RunOptions, RunResult, YieldWorkerApi } from "./yield-types";

const options = { batches: 200, holdBatch: 5, batchMs: 1, settleMs: 100 };
const requests = 3;

/** Starts the yield worker and posts requests while it holds a batch. */
async function runYieldTest(runOptions: RunOptions): Promise<RunResult> {
  const worker = new Worker(new URL("./yield-worker.ts", import.meta.url), { type: "module" });
  try {
    const api = Comlink.wrap<YieldWorkerApi>(worker);
    const control = new SharedArrayBuffer(8);
    const shared = new Int32Array(control);
    const done = api.run(control, runOptions);
    while (Atomics.load(shared, 0) !== runOptions.holdBatch) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const replies = Array.from({ length: requests }, (_, id) => api.request(id + 1));
    Atomics.store(shared, 1, 1);
    Atomics.notify(shared, 1);
    await Promise.all(replies);
    return await done;
  } finally {
    worker.terminate();
  }
}

for (const reader of [undefined, "sync", "prefetch"] as const) {
  test(`queued requests run before the next batch (${reader ?? "direct"})`, async ({
    annotate,
  }) => {
    expect(globalThis.crossOriginIsolated).toBe(true);
    const { log, gaps } = await runYieldTest({ ...options, reader });

    const held = log.indexOf(`batch ${options.holdBatch}`);
    expect(log.slice(held, held + requests + 2)).toEqual([
      `batch ${options.holdBatch}`,
      ...Array.from({ length: requests }, (_, i) => `request ${i + 1}`),
      `batch ${options.holdBatch + 1}`,
    ]);
    expect(log.filter((line) => line.startsWith("batch"))).toHaveLength(options.batches);

    // The ping is not a nested timer, so there is no 4 ms clamp between
    // batches.
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? Infinity;
    await annotate(
      `median ${median.toFixed(3)} ms, max ${sorted.at(-1)?.toFixed(3)} ms`,
      "gap between batches",
    );
    expect(median).toBeLessThan(2);
  });
}
