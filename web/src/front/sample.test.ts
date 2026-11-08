// The demo archive with the real wasm parser (`mise run build:wasm` makes
// it): its size, its space hog and its health findings.
import { expect, test, vi } from "vitest";
import type { ParseWorkerApi } from "../contracts";
import { findings, severityCounts } from "../health/findings";
import {
  buildSample,
  SAMPLE_DUPLICATE,
  SAMPLE_HOG,
  SAMPLE_NAME,
  SAMPLE_TRAILER_BYTES,
  sampleEntries,
} from "./sample";
import { door } from "./strings";
import { crc32 } from "./zip";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));
vi.mock("comlink", () => ({ expose: mocks.expose }));

test("the CRC-32 agrees with the standard check value", () => {
  expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
});

test("the sample is the same each time", () => {
  const first = sampleEntries();
  const second = sampleEntries();
  expect(second.map((entry) => entry.name)).toEqual(first.map((entry) => entry.name));
  expect(crc32(second[10]!.data)).toBe(crc32(first[10]!.data));
});

test("the sample is a release build with one space hog", () => {
  const entries = sampleEntries();
  expect(entries.length).toBeGreaterThan(500);
  expect(entries.length).toBeLessThan(3000);
  const total = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  const hog = entries.find((entry) => entry.name === SAMPLE_HOG)!;
  expect(hog.data.length / total).toBeGreaterThan(0.5);
  const others = entries.filter((entry) => entry !== hog);
  expect(Math.max(...others.map((entry) => entry.data.length))).toBeLessThan(hog.data.length / 5);
  expect(entries.filter((entry) => entry.name === SAMPLE_DUPLICATE)).toHaveLength(2);
  expect(new Set(entries.map((entry) => entry.name)).size).toBe(entries.length - 1);
});

test("the parser finds the duplicate name and the data after the end", async () => {
  const file = await buildSample();
  expect(file.name).toBe(SAMPLE_NAME);
  const bytes = new Uint8Array(await file.arrayBuffer());
  class BytesFile {
    constructor(readonly bytes: Uint8Array) {}
    get size(): number {
      return this.bytes.length;
    }
    slice(start?: number, end?: number): BytesFile {
      return new BytesFile(this.bytes.subarray(start, end));
    }
  }
  vi.stubGlobal(
    "FileReaderSync",
    class {
      readAsArrayBuffer(part: BytesFile) {
        return part.bytes.slice().buffer;
      }
    },
  );
  const workerPath = "../parse/worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls[0]![0] as ParseWorkerApi;
  await api.open(new BytesFile(bytes) as unknown as File, { mirror() {} });
  const outcome = await api.finished();
  expect(outcome).toEqual({ kind: "complete", rows: sampleEntries().length });
  const report = await api.health();
  expect(report.epilogueBytes).toBe(SAMPLE_TRAILER_BYTES);
  expect(report.preludeBytes).toBe(0);
  expect(report.duplicates.rows).toBeGreaterThan(0);
  // Only the two mild findings: no errors, no bomb, no overlap.
  const found = findings(report, outcome);
  expect(found.map((finding) => finding.id).sort()).toEqual(["duplicate-names", "epilogue"]);
  expect(found.every((finding) => finding.severity !== "error")).toBe(true);
  // The answer of the first view says the same as the tool.
  expect(`${severityCounts(found)}.`).toBe(door.health.counts);
  vi.unstubAllGlobals();
});
