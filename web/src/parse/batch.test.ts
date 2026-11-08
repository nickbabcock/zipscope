import { describe, expect, test } from "vitest";
import { MAX_BATCH, MIN_BATCH, nextBatchSize, TARGET_BATCH_MS } from "./batch";

describe("nextBatchSize", () => {
  test("scales toward the target time", () => {
    expect(nextBatchSize(1000, TARGET_BATCH_MS)).toBe(1000);
    expect(nextBatchSize(1000, TARGET_BATCH_MS / 1.6)).toBe(1600);
    expect(nextBatchSize(1000, TARGET_BATCH_MS * 1.25)).toBe(800);
  });

  test("changes by at most two times in one step", () => {
    expect(nextBatchSize(1000, 0.5)).toBe(2000);
    expect(nextBatchSize(1000, 0)).toBe(2000);
    expect(nextBatchSize(1000, 100)).toBe(500);
  });

  test("stays inside its limits", () => {
    expect(nextBatchSize(MIN_BATCH, 1000)).toBe(MIN_BATCH);
    expect(nextBatchSize(MAX_BATCH, 0)).toBe(MAX_BATCH);
  });
});
