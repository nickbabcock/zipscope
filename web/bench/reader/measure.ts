// Measures disk-backed files in fresh workers. One round warms the file cache.
// Run it with `mise run bench:reader`, which uses vitest.config.ts here.
import { expect, inject, test } from "vitest";
import { commands, page } from "vitest/browser";

interface Sample {
  strategy: string;
  windowMiB: number;
  totalMs: number;
  readAtMs: number;
  blobReads: number;
  asyncReads: number;
  jsPeakBytes: number;
  jsRetainedBytes: number;
  wasmBytes: number;
  maxBatchMs: number;
  batches: number;
  prefetchHits: number;
  kind: string;
  rows: number;
  error?: string;
}

const strategies = [
  { strategy: "direct", windowMiB: 0 },
  ...[1, 4, 8].flatMap((windowMiB) => [
    { strategy: "sync", windowMiB },
    { strategy: "prefetch", windowMiB },
  ]),
  { strategy: "pdx", windowMiB: 8 },
];
const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Parses the selected file in a new worker with one strategy. */
function measure(file: File, strategy: (typeof strategies)[number]): Promise<Sample> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return new Promise<Sample>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Reader benchmark timeout")), 120_000);
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(event.message));
    };
    worker.onmessage = ({ data }) => {
      clearTimeout(timer);
      resolve(data);
    };
    worker.postMessage({ ...strategy, file });
  }).finally(() => worker.terminate());
}

test("reader benchmark", async () => {
  const repeats = inject("repeats");
  const samples: (Sample & { entries: number; round: number })[] = [];
  const input = document.createElement("input");
  input.type = "file";
  document.body.append(input);
  for (const entries of [100_000, 1_000_000]) {
    // The path is relative to the web directory.
    await page.elementLocator(input).upload(`../target/archives/${entries}.zip`);
    const file = input.files![0]!;
    for (let round = -1; round < repeats; round++) {
      const shift = (round + 1) % strategies.length;
      const order = [...strategies.slice(shift), ...strategies.slice(0, shift)];
      for (const strategy of order) {
        const sample = await measure(file, strategy);
        expect(sample.error, JSON.stringify(sample)).toBeUndefined();
        expect(sample.kind).toBe("complete");
        expect(sample.rows).toBe(entries);
        if (round >= 0) samples.push({ entries, round, ...sample });
      }
      console.info(`${entries}: round ${round + 1}/${repeats}`);
    }
  }
  const summary = [100_000, 1_000_000].flatMap((entries) =>
    strategies.map((strategy) => {
      const rows = samples.filter(
        (s) =>
          s.entries === entries &&
          s.strategy === strategy.strategy &&
          s.windowMiB === strategy.windowMiB,
      );
      const totals = rows.map((s) => s.totalMs);
      const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
      const speedups = rows.map((row) => {
        const direct = samples.find(
          (s) => s.entries === entries && s.round === row.round && s.strategy === "direct",
        )!;
        return 100 * (1 - row.totalMs / direct.totalMs);
      });
      const meanSpeedup = speedups.reduce((a, b) => a + b, 0) / speedups.length;
      return {
        entries,
        ...strategy,
        totalMs: median(totals),
        minMs: Math.min(...totals),
        maxMs: Math.max(...totals),
        sdMs: Math.sqrt(totals.reduce((sum, x) => sum + (x - mean) ** 2, 0) / totals.length),
        speedupPct: median(speedups),
        speedupSdPct: Math.sqrt(
          speedups.reduce((sum, x) => sum + (x - meanSpeedup) ** 2, 0) / speedups.length,
        ),
        readAtMs: median(rows.map((s) => s.readAtMs)),
        blobReads: median(rows.map((s) => s.blobReads)),
        asyncReads: median(rows.map((s) => s.asyncReads)),
        wasmMiB: median(rows.map((s) => s.wasmBytes)) / 2 ** 20,
        jsPeakMiB: Math.max(...rows.map((s) => s.jsPeakBytes)) / 2 ** 20,
        prefetchHits: median(rows.map((s) => s.prefetchHits)),
        maxBatchMs: Math.max(...rows.map((s) => s.maxBatchMs)),
      };
    }),
  );
  const report = {
    browser: navigator.userAgent,
    repeats,
    pdxSourceSha256: inject("pdxSourceSha256"),
    summary,
    samples,
  };
  await commands.writeFile("../target/reader-results.json", JSON.stringify(report, null, 2) + "\n");
  const table = [
    "| Entries | Reader | Window MiB | Total ms (median ± SD) | Range ms | readAt ms | Blob reads (sync + async) | Wasm MiB | JS peak MiB | Faster than direct % (paired median ± SD) |",
    "| ---: | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ...summary.map(
      (s) =>
        `| ${s.entries} | ${s.strategy} | ${s.windowMiB} | ${s.totalMs.toFixed(2)} ± ${s.sdMs.toFixed(2)} | ${s.minMs.toFixed(2)}–${s.maxMs.toFixed(2)} | ${s.readAtMs.toFixed(2)} | ${s.blobReads} + ${s.asyncReads} | ${s.wasmMiB.toFixed(2)} | ${s.jsPeakMiB.toFixed(2)} | ${s.speedupPct.toFixed(1)} ± ${s.speedupSdPct.toFixed(1)} |`,
    ),
    "",
  ].join("\n");
  await commands.writeFile("../target/reader-results.md", table);
  console.info(table);
});
