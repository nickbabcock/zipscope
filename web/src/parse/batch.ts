// Adaptive batch sizing. Wasm never reads the clock; JS times each batch.

export const TARGET_BATCH_MS = 8;
export const INITIAL_BATCH = 512;
export const MIN_BATCH = 64;
export const MAX_BATCH = 1 << 20;

/** Returns the next entry count from the time that the last batch took. */
export function nextBatchSize(current: number, elapsedMs: number): number {
  // A batch faster than the clock resolution doubles.
  const factor = elapsedMs <= 0.1 ? 2 : Math.min(2, Math.max(0.5, TARGET_BATCH_MS / elapsedMs));
  return Math.min(MAX_BATCH, Math.max(MIN_BATCH, Math.round(current * factor)));
}
