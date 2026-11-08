// The final health checks with the real wasm parser (`mise run build:wasm`
// makes it). The budget of the checks goes through the wasm binding.
// health_findings.rs checks the units of each step.
import { expect, test } from "vitest";
import { HealthField, State } from "../contracts";
import init, { Parser } from "../wasm/zipscope_core.js";

/** A central directory of empty entries, all with the same name. */
function zip(name: Uint8Array, count: number): Uint8Array {
  const directory = count * (46 + name.length);
  const bytes = new Uint8Array(30 + directory + 22);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, 0x04034b50, true);
  let central = 30;
  for (let index = 0; index < count; index++) {
    data.setUint32(central, 0x02014b50, true);
    data.setUint16(central + 4, 20, true);
    data.setUint16(central + 6, 20, true);
    data.setUint16(central + 28, name.length, true);
    bytes.set(name, central + 46);
    central += 46 + name.length;
  }
  data.setUint32(central, 0x06054b50, true);
  data.setUint16(central + 8, count, true);
  data.setUint16(central + 10, count, true);
  data.setUint32(central + 12, directory, true);
  data.setUint32(central + 16, 30, true);
  return bytes;
}

test("long duplicate names are checked in steps after the last parse call", async () => {
  await init();
  // 6,000 copies of a name of 8 KiB: about 770,000 units of comparisons.
  const bytes = zip(new TextEncoder().encode("n".repeat(8192)), 6_000);
  const reader = {
    readAt(offset: number, buffer: Uint8Array): number {
      const part = bytes.subarray(offset, offset + buffer.length);
      buffer.set(part);
      return part.length;
    },
  };
  const parser = Parser.open(reader, bytes.length, 1n);
  while (parser.state() === State.PARSING) {
    parser.parse(1_000);
  }
  // The last parse call runs at most 262,144 units of checks, which is not
  // sufficient for these names.
  expect(parser.health()[HealthField.DUPLICATES_CHECKED]).toBe(0);
  let steps = 1;
  while (!parser.finishChecks(8192)) {
    steps++;
  }
  // About 770,000 units in steps of 8192 units.
  expect(steps).toBeGreaterThan(50);
  expect(parser.health()[HealthField.DUPLICATE_ROWS]).toBe(5_999);
  parser.free();
});
