// The two format rules with the real wasm parser, as the worker reads them
// (`mise run build:wasm` makes it): an entry count that wrapped at 65,536, and
// the ranges of the overlap check and of data into the central directory. The
// boundaries have their tests in `crates/core/tests/format_corrections.rs`.
import { expect, test } from "vitest";
import { HEALTH_FIELDS, HealthField, Marks, State } from "../contracts";
import init, { Parser } from "../wasm/zipscope_core.js";

interface Row {
  at: number;
  size?: number;
}

/** A central directory after `body` bytes of zeros. The name of a row is its
 *  index. `declared` is the count of the end record. */
function zip(rows: Row[], body: number, declared = rows.length): Uint8Array {
  const names = rows.map((_row, index) => new TextEncoder().encode(String(index)));
  const directory = names.reduce((sum, name) => sum + 46 + name.length, 0);
  const bytes = new Uint8Array(body + directory + 22);
  const data = new DataView(bytes.buffer);
  let central = body;
  rows.forEach((row, index) => {
    const name = names[index]!;
    data.setUint32(central, 0x02014b50, true);
    data.setUint16(central + 4, 20, true);
    data.setUint16(central + 6, 20, true);
    data.setUint32(central + 20, row.size ?? 0, true);
    data.setUint32(central + 24, row.size ?? 0, true);
    data.setUint16(central + 28, name.length, true);
    data.setUint32(central + 42, row.at, true);
    bytes.set(name, central + 46);
    central += 46 + name.length;
  });
  data.setUint32(central, 0x06054b50, true);
  data.setUint16(central + 8, declared & 0xffff, true);
  data.setUint16(central + 10, declared & 0xffff, true);
  data.setUint32(central + 12, directory, true);
  data.setUint32(central + 16, body, true);
  return bytes;
}

async function health(bytes: Uint8Array): Promise<{ vector: Float64Array; parser: Parser }> {
  await init();
  const reader = {
    readAt(offset: number, buffer: Uint8Array): number {
      const part = bytes.subarray(offset, offset + buffer.length);
      buffer.set(part);
      return part.length;
    },
  };
  const parser = Parser.open(reader, bytes.length, 1n);
  while (parser.state() === State.PARSING) {
    parser.parse(10_000);
  }
  while (!parser.finishChecks(1 << 18));
  const vector = Float64Array.from(parser.health());
  expect(vector.length).toBe(HEALTH_FIELDS);
  return { vector, parser };
}

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_row, index) => ({ at: index * 30 }));
}

test("a count that wrapped at 65,536 sets only its own value", async () => {
  const { vector, parser } = await health(zip(rows(65_539), 65_539 * 30, 3));
  expect(vector[HealthField.DECLARED_ENTRIES]).toBe(3);
  expect(vector[HealthField.COUNT_WRAPPED]).toBe(1);
  expect(vector[HealthField.COUNT_MISMATCH]).toBe(0);
  expect(vector[HealthField.OVERLAP_ROWS]).toBe(0);
  parser.free();
});

test("another count stays a mismatch", async () => {
  const { vector, parser } = await health(zip(rows(65_540), 65_540 * 30, 3));
  expect(vector[HealthField.COUNT_WRAPPED]).toBe(0);
  expect(vector[HealthField.COUNT_MISMATCH]).toBe(1);
  parser.free();
});

test("the 30 bytes of a local header count in the overlap check", async () => {
  const past = await health(
    zip(
      [
        { at: 0, size: 40 },
        { at: 40 + 29, size: 1 },
      ],
      200,
    ),
  );
  expect(past.vector[HealthField.OVERLAP_ROWS]).toBe(2);
  expect(past.vector[HealthField.OVERLAP_EXAMPLE]).toBe(0);
  expect(past.parser.markedFrom(0, Marks.OVERLAP)).toBe(2);
  past.parser.free();
  const touch = await health(
    zip(
      [
        { at: 0, size: 40 },
        { at: 40 + 30, size: 1 },
      ],
      200,
    ),
  );
  expect(touch.vector[HealthField.OVERLAP_ROWS]).toBe(0);
  touch.parser.free();
  const shared = await health(zip([{ at: 0 }, { at: 0 }], 200));
  expect(shared.vector[HealthField.OVERLAP_ROWS]).toBe(2);
  shared.parser.free();
});

test("data into the central directory has its count and its first row", async () => {
  const { vector, parser } = await health(
    zip(
      [
        { at: 0, size: 10 },
        { at: 40, size: 31 },
        { at: 70, size: 100 },
      ],
      100,
    ),
  );
  expect(vector[HealthField.INTO_DIRECTORY_ROWS]).toBe(2);
  expect(vector[HealthField.INTO_DIRECTORY_EXAMPLE]).toBe(1);
  expect(parser.intoDirectoryFrom(0)).toBe(2);
  expect(parser.intoDirectoryFrom(2)).toBe(1);
  expect(parser.intoDirectoryFrom(3)).toBe(0);
  parser.free();
  const touch = await health(zip([{ at: 40, size: 30 }], 100));
  expect(touch.vector[HealthField.INTO_DIRECTORY_ROWS]).toBe(0);
  expect(touch.vector[HealthField.INTO_DIRECTORY_EXAMPLE]).toBe(-1);
  touch.parser.free();
});
