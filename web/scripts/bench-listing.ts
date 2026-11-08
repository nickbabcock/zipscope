// Measures the listing of a generated archive in headless Chromium and
// reports the results against the budgets of this script: bundle size,
// time to the first rows, time to the full listing, and frame intervals
// while the list scrolls during parsing. It also checks the names. The
// budgets do not gate: only a wrong listing makes the exit status 1.
//
// Usage: node scripts/bench-listing.ts <archive.zip> [--headed] [--json <out.json>]
// The archive needs a `<archive.zip>.names.txt` manifest (see the
// `gen:archive` task). When GITHUB_STEP_SUMMARY is set, the report is also
// appended to it as Markdown.
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { preview } from "vite";
import { collectTree, expectedTree, openArchive, waitForOutcome } from "../e2e/listing.ts";

const args = process.argv.slice(2);
const archive = args.find((arg) => !arg.startsWith("--"));
if (archive === undefined) {
  console.error("usage: bench-listing <archive.zip> [--headed] [--json <out.json>]");
  process.exit(2);
}
const headed = args.includes("--headed");
const jsonIndex = args.indexOf("--json");
const jsonOut = jsonIndex === -1 ? undefined : args[jsonIndex + 1];

interface FrameStats {
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Intervals longer than 25 ms: at least one missed frame at 60 Hz. */
  dropped: number;
}

function stats(intervals: number[]): FrameStats {
  const sorted = [...intervals].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    frames: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? 0,
    dropped: sorted.filter((ms) => ms > 25).length,
  };
}

/** Gzipped size of the JS and wasm in `dist/assets`. */
function bundleBytes(): number {
  const dir = new URL("../dist/assets/", import.meta.url).pathname;
  return readdirSync(dir)
    .filter((file) => /\.(js|wasm)$/.test(file))
    .reduce((sum, file) => sum + gzipSync(readFileSync(path.join(dir, file))).length, 0);
}

// Runs in the page. It records each animation frame and scrolls the list by
// `step` pixels on each frame, while parsing and for `after` frames more.
function record({ step, after }: { step: number; after: number }) {
  const bench = {
    parse: [] as number[],
    after: [] as number[],
    longTasks: [] as number[],
    nodesAtFirstRows: -1,
    nodesAtEnd: -1,
    done: false,
  };
  (globalThis as { bench?: typeof bench }).bench = bench;
  if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        bench.longTasks.push(entry.duration);
      }
    }).observe({ type: "longtask" });
  }
  let last = 0;
  let remaining = after;
  let direction = 1;
  const tick = (now: number) => {
    const listed = performance.getEntriesByName("zipscope:listed").length > 0;
    const started = performance.getEntriesByName("zipscope:first-rows").length > 0;
    if (last !== 0 && started) {
      (listed ? bench.after : bench.parse).push(now - last);
    }
    const nodes = document.querySelectorAll("#list-viewport *").length;
    if (started && bench.nodesAtFirstRows === -1) {
      bench.nodesAtFirstRows = nodes;
    }
    bench.nodesAtEnd = nodes;
    last = now;
    const viewport = document.getElementById("list-viewport");
    if (viewport !== null) {
      const max = viewport.scrollHeight - viewport.clientHeight;
      if (viewport.scrollTop >= max - step) {
        direction = -1;
      }
      if (viewport.scrollTop <= 0) {
        direction = 1;
      }
      viewport.scrollTop += direction * step;
    }
    if (listed && --remaining <= 0) {
      bench.done = true;
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const port = process.env.ZIPSCOPE_PORT;
const server = await preview({
  configFile: new URL("../vite.config.ts", import.meta.url).pathname,
  preview: { port: Number(port ?? 0), strictPort: port !== undefined, open: false },
  logLevel: "warn",
});
// The "chromium" channel is the full browser in the new headless mode, not
// the headless shell. Its frame timing is closer to a real browser. Set
// BENCH_CHANNEL to use a different channel, for example "chrome".
const browser = await chromium.launch({
  channel: process.env.BENCH_CHANNEL ?? "chromium",
  headless: !headed,
});
let failed = false;
try {
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) {
    throw new Error("the preview server has no local URL");
  }
  const expected = readFileSync(`${archive}.names.txt`, "utf8").split("\n").slice(0, -1);
  // The first run in a new browser can stall while the browser starts its
  // processes. Each run uses a new context, and the report uses the median.
  const runCount = 3;
  const runs: { firstRowsMs: number; listedMs: number }[] = [];
  const parseIntervals: number[] = [];
  const afterIntervals: number[] = [];
  const longTasks: number[] = [];
  const nodes: [number, number] = [0, 0];
  const mismatches: string[] = [];
  for (let run = 0; run < runCount; run++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(record, { step: 240, after: 180 });
    await openArchive(page, archive);
    const outcome = await waitForOutcome(page, 600_000);
    await page.waitForFunction(() => (globalThis as { bench?: { done: boolean } }).bench?.done);
    const marks = await page.evaluate(() =>
      Object.fromEntries(performance.getEntriesByType("mark").map((m) => [m.name, m.startTime])),
    );
    const bench = await page.evaluate(
      () =>
        (
          globalThis as {
            bench?: {
              parse: number[];
              after: number[];
              longTasks: number[];
              nodesAtFirstRows: number;
              nodesAtEnd: number;
            };
          }
        ).bench!,
    );
    const open = marks["zipscope:open"] ?? NaN;
    runs.push({
      firstRowsMs: (marks["zipscope:first-rows"] ?? NaN) - open,
      listedMs: (marks["zipscope:listed"] ?? NaN) - open,
    });
    parseIntervals.push(...bench.parse);
    afterIntervals.push(...bench.after);
    longTasks.push(...bench.longTasks);
    nodes[0] = Math.max(nodes[0], bench.nodesAtFirstRows);
    nodes[1] = Math.max(nodes[1], bench.nodesAtEnd);
    if (outcome.outcome !== "complete") {
      mismatches.push(`run ${run + 1}: parsing did not complete: ${outcome.status}`);
    }
    if (outcome.rows !== expected.length) {
      mismatches.push(`run ${run + 1}: listed ${outcome.rows} rows, expected ${expected.length}`);
    }
    if (run === runCount - 1) {
      // Check the entries of the first 40 folders in the tree.
      const listed = await collectTree(page, 40);
      const want = expectedTree(expected);
      for (const [folder, names] of Object.entries(listed.folders)) {
        if (JSON.stringify(names) !== JSON.stringify(want[folder])) {
          mismatches.push(`folder ${JSON.stringify(folder)} lists other entries`);
        }
      }
    }
    await context.close();
  }

  const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? NaN;
  const firstRowsMs = median(runs.map((r) => r.firstRowsMs));
  const listedMs = median(runs.map((r) => r.listedMs));
  const parseFrames = stats(parseIntervals);
  const afterFrames = stats(afterIntervals);
  const gzip = bundleBytes();
  const smooth = (s: FrameStats) => s.p50 <= 17.5 && s.dropped <= Math.ceil(s.frames / 100);
  const ms = (value: number) => `${value.toFixed(1)} ms`;
  const frames = (s: FrameStats) =>
    `${s.frames} frames, p50 ${ms(s.p50)}, p95 ${ms(s.p95)}, max ${ms(s.max)}, ${s.dropped} over 25 ms`;
  const rows: [string, string, string, boolean | undefined][] = [
    [
      "Core JS + wasm, gzipped",
      "under ~200 KB",
      `${(gzip / 1024).toFixed(1)} KB`,
      gzip < 200 * 1024,
    ],
    ["First rows visible", "~100 ms", ms(firstRowsMs), firstRowsMs <= 100],
    [
      `Full listing (${expected.length.toLocaleString("en")} entries)`,
      expected.length === 100_000 ? "~1 s" : "none (100k: ~1 s)",
      ms(listedMs),
      expected.length === 100_000 ? listedMs <= 1000 : undefined,
    ],
    ["Scrolling while parsing", "60 fps", frames(parseFrames), smooth(parseFrames)],
    ["Scrolling after parsing", "60 fps", frames(afterFrames), smooth(afterFrames)],
  ];
  const verdict = (ok: boolean | undefined) =>
    ok === undefined ? "reported" : ok ? "within budget" : "over budget";

  const version = browser.version();
  console.log(`archive: ${archive} (${headed ? "headed" : "headless"} Chromium ${version})`);
  for (const [name, budget, value, ok] of rows) {
    console.log(`${name}: ${value} (budget ${budget}, ${verdict(ok)})`);
  }
  console.log(
    `runs: ${runs.map((r) => `first rows ${ms(r.firstRowsMs)}, listed ${ms(r.listedMs)}`).join("; ")}`,
  );
  console.log(
    `main-thread long tasks: ${longTasks.length}${longTasks.length ? ` (max ${ms(Math.max(...longTasks))})` : ""}`,
  );
  console.log(`list DOM nodes: ${nodes[0]} at first rows, ${nodes[1]} at the end`);
  if (mismatches.length > 0) {
    failed = true;
    console.error(`name check failed:\n  ${mismatches.join("\n  ")}`);
  } else {
    console.log("name check: the entries of the first 40 tree folders are correct");
  }

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined) {
    const lines = [
      `### Listing benchmark: ${path.basename(archive)} (Chromium ${version})`,
      "",
      "| Budget | Target | Result | |",
      "| --- | --- | --- | --- |",
      ...rows.map(
        ([name, budget, value, ok]) => `| ${name} | ${budget} | ${value} | ${verdict(ok)} |`,
      ),
      "",
      `Median of ${runCount} runs. Long tasks: ${longTasks.length}. Name check: ${mismatches.length === 0 ? "correct" : "FAILED"}.`,
      "",
    ];
    appendFileSync(summary, lines.join("\n"));
  }
  if (jsonOut !== undefined) {
    writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          archive,
          chromium: version,
          gzip,
          firstRowsMs,
          listedMs,
          parseFrames,
          afterFrames,
          runs,
          longTasks,
          mismatches,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
