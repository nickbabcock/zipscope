// Runs the reader benchmark (measure.ts) in Chromium. It is separate from the
// test projects, so a plain `vitest` run does not start it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

declare module "vitest" {
  interface ProvidedContext {
    repeats: number;
    pdxSourceSha256: string;
  }
}

const repeats = Number(process.env.BENCH_RUNS ?? 9);
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("Invalid BENCH_RUNS");
const pdxSource = process.env.PDX_BLOB_SOURCE;
if (pdxSource === undefined) throw new Error("PDX_BLOB_SOURCE is required");

export default defineConfig({
  root: path.resolve(import.meta.dirname, "../.."),
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: {
    include: ["bench/reader/measure.ts"],
    testTimeout: 0,
    provide: {
      repeats,
      pdxSourceSha256: createHash("sha256").update(readFileSync(pdxSource)).digest("hex"),
    },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: { channel: process.env.BENCH_CHANNEL ?? "chromium" },
      }),
      instances: [{ browser: "chromium" }],
    },
  },
});
