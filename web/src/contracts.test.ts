// Compares the values of contracts.ts with the values that the core wasm
// gives (`contractValues`, from `crates/core/src/contract.rs`). Thus the
// Rust side and the TypeScript side of the shared layout cannot differ.
import { expect, test } from "vitest";
import {
  CHUNK_BITS,
  CHUNK_BYTES,
  COLUMN_LAYOUT,
  FOLDER_RECORD_BYTES,
  FOLDER_TAG,
  HEALTH_FIELDS,
  HealthField,
  LARGEST_FILES,
  LAYOUT_VERSION,
  NONE,
  PAGE_BYTES,
  PAGE_ROWS,
  ROLLUP_RECORD_BYTES,
  SORT_DESCENDING,
  SortColumn,
  State,
  TREE_RECORD_WORDS,
  TreeOrder,
} from "./contracts";
import { alwaysMarked, isJoiner, isVariation } from "./label";
import init, { contractValues } from "./wasm/zipscope_core.js";

/** Returns the ranges of the code points that match, as the Rust side
 *  writes them: `first-last` in hexadecimal, separated by commas. */
function ranges(matches: (code: number) => boolean): string {
  const list: [number, number][] = [];
  for (let code = 0; code <= 0x10ffff; code++) {
    if (!matches(code)) continue;
    const last = list[list.length - 1];
    if (last !== undefined && last[1] + 1 === code) last[1] = code;
    else list.push([code, code]);
  }
  return list.map(([first, last]) => `${first.toString(16)}-${last.toString(16)}`).join(",");
}

const prefixed = (prefix: string, values: Record<string, number>) =>
  Object.fromEntries(Object.entries(values).map(([name, value]) => [`${prefix}.${name}`, value]));

test("contracts.ts has the values of the core wasm", async () => {
  await init();
  const rust = Object.fromEntries(
    contractValues()
      .trimEnd()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  const web: Record<string, string | number> = {
    LAYOUT_VERSION,
    PAGE_ROWS,
    PAGE_BYTES,
    CHUNK_BITS,
    CHUNK_BYTES,
    NONE,
    FOLDER_TAG,
    FOLDER_RECORD_BYTES,
    ROLLUP_RECORD_BYTES,
    TREE_RECORD_WORDS,
    TREE_ORDER_ARCHIVE: TreeOrder.ARCHIVE,
    TREE_ORDER_NAME: TreeOrder.NAME,
    SORT_DESCENDING,
    LARGEST_FILES,
    ...Object.fromEntries(COLUMN_LAYOUT.map((c) => [`column.${c.id}`, `${c.name}:${c.width}`])),
    ...prefixed("state", State),
    ...prefixed("health", HealthField),
    "health.FIELDS": HEALTH_FIELDS,
    ...prefixed("sort", SortColumn),
    "marks.control": ranges(alwaysMarked),
    "marks.attached": ranges((code) => isJoiner(code) || isVariation(code)),
  };
  expect(rust).toEqual(Object.fromEntries(Object.entries(web).map(([k, v]) => [k, String(v)])));
});
