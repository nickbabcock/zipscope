import { HEADER_BYTES } from "../../src/contracts.ts";
import { parseInBatches } from "../../src/parse/loop.ts";
import type { BatchParser } from "../../src/parse/loop.ts";
import { FileReaderAt, WindowReaderAt } from "../../src/parse/reader.ts";
import { PrefetchReaderAt } from "./strategies.ts";
interface BenchParser {
  parse(count: number): number;
  rows(): number;
  state(): number;
  error(): string | undefined;
  readAtMs(): number;
}

interface BenchModule {
  default(): Promise<{ memory: WebAssembly.Memory }>;
  BenchParser: {
    pdx(file: Blob): BenchParser;
    direct(source: FileReaderAt, size: number): BenchParser;
  };
}

self.onmessage = async ({ data: { strategy, windowMiB, file } }) => {
  try {
    // The benchmark build supplies this module. Type checks need no pdx checkout.
    const modulePath = "./pkg/reader_bench.js";
    const { default: init, BenchParser } = (await import(
      /* @vite-ignore */ modulePath
    )) as BenchModule;
    const wasm = await init();
    let blobReads = 0;
    let asyncReads = 0;
    let jsPeakBytes = 0;
    let source: FileReaderAt | undefined;
    const retained = () => (source instanceof WindowReaderAt ? source.retainedBytes : 0);
    const original = FileReaderSync.prototype.readAsArrayBuffer;
    FileReaderSync.prototype.readAsArrayBuffer = function (blob) {
      const bytes = original.call(this, blob);
      blobReads++;
      jsPeakBytes = Math.max(jsPeakBytes, retained() + bytes.byteLength);
      return bytes;
    };
    const originalAsync = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      asyncReads++;
      return originalAsync.call(this);
    };
    const reader = new FileReaderSync();
    const windowBytes = windowMiB * 1024 * 1024;
    if (strategy === "direct") {
      source = new FileReaderAt(file, reader);
    } else if (strategy === "sync") {
      source = new WindowReaderAt(file, reader, windowBytes);
    } else if (strategy === "prefetch") {
      source = new PrefetchReaderAt(file, reader, windowBytes);
    }
    const start = performance.now();
    const parser =
      source === undefined ? BenchParser.pdx(file) : BenchParser.direct(source, file.size);
    let maxBatchMs = 0;
    let batches = 0;
    const batchParser: BatchParser = {
      parse(count) {
        const start = performance.now();
        const parsed = parser.parse(count);
        maxBatchMs = Math.max(maxBatchMs, performance.now() - start);
        batches++;
        return parsed;
      },
      rows: () => parser.rows(),
      state: () => parser.state(),
      error: () => parser.error(),
      progress: () => 0,
      columnPtr: () => 0,
      nameChunkCount: () => 0,
      nameChunkPtr: () => 0,
      nameChunkLength: () => 0,
      commentChunkCount: () => 0,
      commentChunkPtr: () => 0,
      commentChunkLength: () => 0,
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
    const outcome = await parseInBatches(
      batchParser,
      {
        publish() {
          if (source instanceof PrefetchReaderAt) source.prefetch();
        },
      },
      new SharedArrayBuffer(HEADER_BYTES),
    );
    const totalMs = performance.now() - start;
    if (source instanceof PrefetchReaderAt) {
      jsPeakBytes = Math.max(jsPeakBytes, source.peakBytes);
      source.stop();
    }
    source?.close();
    self.postMessage({
      strategy,
      windowMiB,
      totalMs,
      readAtMs: parser.readAtMs(),
      blobReads,
      asyncReads,
      jsPeakBytes,
      jsRetainedBytes: retained(),
      wasmBytes: wasm.memory.buffer.byteLength,
      maxBatchMs,
      batches,
      prefetchHits: source instanceof PrefetchReaderAt ? source.hits : 0,
      ...outcome,
    });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
