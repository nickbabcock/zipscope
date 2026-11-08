// The pool size of the zstd copy: one encoder for each core but one, at most
// `REMUX_MAX_WORKERS`, and only as many as the memory budget has room for.
import { expect, test } from "vitest";
import { REMUX_ENCODER_BYTES, REMUX_INFLIGHT_BYTES, REMUX_MAX_WORKERS } from "../contracts";
import { poolSize } from "./client";

const PER_ENCODER = REMUX_ENCODER_BYTES + REMUX_INFLIGHT_BYTES;

test("a device with 8 cores and much memory gets the largest pool", () => {
  expect(REMUX_MAX_WORKERS).toBe(4);
  expect(poolSize(Number.POSITIVE_INFINITY, 8)).toBe(REMUX_MAX_WORKERS);
  expect(poolSize(Number.POSITIVE_INFINITY, 2)).toBe(1);
});

test("the memory budget limits the pool", () => {
  // Room for the lead and two encoders, not for three.
  expect(poolSize(3 * PER_ENCODER, 8)).toBe(2);
  expect(poolSize(0, 8)).toBe(0);
});
