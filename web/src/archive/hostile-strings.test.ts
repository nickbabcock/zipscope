// The hostile tests for the comment decoding and the region reads assumed
// Rust calls. The real code is
// `decodeComment` and `regionRange` in strings.ts, so these cases moved
// here from crates/layout/tests/hostile_map.rs, with the same inputs and the
// same expected results.
import { describe, expect, test } from "vitest";
import { decodeComment, regionRange } from "./strings";

const bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

test("comment_decode_uses_utf8_then_cp437_without_entry_flags", () => {
  for (const [comment, expected] of [
    [new Uint8Array(), ""],
    [new TextEncoder().encode("日本語 café"), "日本語 café"],
    [bytes("caf\x82 \x9b\0end"), "café ¢\0end"],
    [new Uint8Array(0xffff).fill(0x82), "é".repeat(0xffff)],
  ] as const) {
    expect(decodeComment(comment).text).toBe(expected);
  }
});

describe("region reads", () => {
  // The assumed `read_region(reader, region, relative, out)` read into a
  // buffer. The hex view and the extract read
  // `file.slice(range.start, range.end)` of the range below, so the checks
  // are on the range: exact steps, the region end, and the errors.
  test("region_reads_are_exact_bounded_and_stop_before_adjacent_zip_bytes", () => {
    const region = { start: 7, end: 15 };
    const parts: [number, number][] = [];
    let relative = 0;
    while (relative < region.end - region.start) {
      const range = regionRange(region, relative, 3);
      const read = range.end - range.start;
      expect(read).toBeGreaterThan(0);
      expect(read).toBeLessThanOrEqual(3);
      expect(range.end).toBeLessThanOrEqual(region.end);
      parts.push([range.start, range.end]);
      relative += read;
    }
    expect(parts).toEqual([
      [7, 10],
      [10, 13],
      [13, 15],
    ]);
    const end = regionRange(region, 8, 3);
    expect(end.end - end.start).toBe(0);
    expect(() => regionRange(region, 9, 3)).toThrow(RangeError);
  });

  test("region_reads_reject_overflowing_ranges_without_io", () => {
    // u64::MAX - 1 is not a file offset in JavaScript: reject it.
    expect(() => regionRange({ start: 2 ** 64 - 2, end: 2 ** 64 + 2 }, 0, 8)).toThrow(RangeError);
    expect(() => regionRange({ start: 10, end: 5 }, 0, 1)).toThrow(RangeError);
    expect(() => regionRange({ start: 0, end: 5 }, -1, 1)).toThrow(RangeError);
  });

  test("huge sparse prelude: the last 3 bytes", () => {
    const base = 2 ** 40 + 7;
    expect(regionRange({ start: 0, end: base }, base - 3, 6)).toEqual({
      start: base - 3,
      end: base,
    });
  });
});
