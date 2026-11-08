// The rule of the marks is on two sides: `label.ts` for the screen, and
// `crates/core/src/text.rs` for the health finding. Here the real wasm
// parser reads names, and each row must get the mark bit when, and only
// when, the label of its name has a mark (`mise run build:wasm` makes it).
import { expect, test } from "vitest";
import { COLUMN_ID, HealthField, Marks, State } from "./contracts";
import { alwaysMarked, countsInFinding, isJoiner, isVariation } from "./label";
import init, { Parser } from "./wasm/zipscope_core.js";

function zip(names: Uint8Array[]): Uint8Array {
  const directory = names.reduce((sum, name) => sum + 46 + name.length, 0);
  const bytes = new Uint8Array(30 + directory + 22);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, 0x04034b50, true);
  let central = 30;
  for (const name of names) {
    data.setUint32(central, 0x02014b50, true);
    data.setUint16(central + 4, 20, true);
    data.setUint16(central + 6, 20, true);
    // The UTF-8 flag, so that each name is decoded as these bytes.
    data.setUint16(central + 8, 0x0800, true);
    data.setUint16(central + 28, name.length, true);
    bytes.set(name, central + 46);
    central += 46 + name.length;
  }
  data.setUint32(central, 0x06054b50, true);
  data.setUint16(central + 8, names.length, true);
  data.setUint16(central + 10, names.length, true);
  data.setUint32(central + 12, directory, true);
  data.setUint32(central + 16, 30, true);
  return bytes;
}

/** Each code point at an edge of a class, and its neighbors. */
function edges(): number[] {
  const codes = new Set<number>();
  const marked = (code: number) => alwaysMarked(code) || isJoiner(code) || isVariation(code);
  for (let code = 0; code <= 0x10ffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    if (marked(code) !== marked(code + 1)) {
      for (const near of [code - 1, code, code + 1, code + 2]) {
        if (near >= 0 && near <= 0x10ffff && (near < 0xd800 || near > 0xdfff)) codes.add(near);
      }
    }
  }
  return [...codes];
}

/** Each pattern gives a name around one character. */
const PATTERNS: ((char: string) => string)[] = [
  (char) => char,
  (char) => `a${char}b`,
  (char) => `م${char}م`,
  (char) => `م${char}`,
  (char) => `${char}م`,
  (char) => `❤${char}`,
  (char) => `م/${char}/م`,
  (char) => `م\u200C${char}`,
  (char) => `${char}\u200Dم`,
];

test("the core and the label agree for each edge of the classes", async () => {
  const wasm = await init();
  const encoder = new TextEncoder();
  const names: string[] = [];
  for (const code of edges()) {
    const char = String.fromCodePoint(code);
    for (const pattern of PATTERNS) names.push(pattern(char));
  }
  // The Mac icon file does not count, and all names near it do.
  names.push(
    "Icon\r",
    "._Icon\r",
    "a/Icon\r",
    "a\\._Icon\r",
    "xIcon\r",
    "a/x._Icon\r",
    "Icon\r\r",
    "Icon\r/",
    "a\u202E/Icon\r",
    "\u0645\u200C/Icon\r",
  );
  // Short mixes of the characters that decide the rule, with a fixed seed.
  const alphabet = [
    "a",
    ".",
    "/",
    "م",
    "א",
    "中",
    "\u{1F468}",
    "\u200C",
    "\u200D",
    "\uFE0F",
    "\u180B",
    "\u{E0100}",
    "\u202E",
    "\u200B",
    "\n",
  ];
  let state = 19;
  const next = (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * limit);
  };
  for (let round = 0; round < 20_000; round++) {
    let name = "";
    for (let at = next(7); at >= 0; at--) name += alphabet[next(alphabet.length)];
    names.push(name);
  }
  expect(names.length).toBeLessThan(65_536);
  const bytes = zip(names.map((name) => encoder.encode(name)));
  const reader = {
    readAt(offset: number, buffer: Uint8Array): number {
      const part = bytes.subarray(offset, offset + buffer.length);
      buffer.set(part);
      return part.length;
    },
  };
  const parser = Parser.open(reader, bytes.length, 1n);
  while (parser.state() === State.PARSING) parser.parse(4_096);
  expect(parser.rows()).toBe(names.length);
  const marks = new Uint8Array(
    wasm.memory.buffer,
    parser.columnPtr(0, COLUMN_ID.marks),
    names.length,
  );
  let marked = 0;
  let first = -1;
  for (const [row, name] of names.entries()) {
    const shown = countsInFinding(name);
    if (shown && first < 0) first = row;
    if (shown) marked++;
    const bit = ((marks[row] ?? 0) & Marks.CONTROL_NAME) !== 0;
    if (bit !== shown) {
      const codes = Array.from(name, (char) => char.codePointAt(0)!.toString(16));
      throw new Error(`row ${row}: core ${bit}, label ${shown}, code points ${codes.join(" ")}`);
    }
  }
  const health = parser.health();
  expect(health[HealthField.CONTROL_NAME_ROWS]).toBe(marked);
  expect(health[HealthField.CONTROL_NAME_EXAMPLE]).toBe(first);
  expect(marked).toBeGreaterThan(1_000);
  expect(marked).toBeLessThan(names.length);
  parser.free();
});
