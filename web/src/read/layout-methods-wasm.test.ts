// A map with 65,536 distinct methods under a tight memory cap ends with
// totals or a clear memory error, never with a trap of the read wasm. The
// wasm memory does not shrink, so this test has its own file.
import { afterEach, expect, test, vi } from "vitest";
import { COLUMN_ID, COLUMN_LAYOUT, PAGE_ROWS, State, columnView } from "../contracts";
import { MiB, encoder, header, openWorker, readBytes, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

const ROWS = 65_537;

/** Gives each row its own method in the mirrors. */
function distinctMethods(pages: SharedArrayBuffer[]): void {
  for (let row = 0; row < ROWS; row++) {
    const page = pages[Math.floor(row / PAGE_ROWS)]!;
    const methods = columnView(page, COLUMN_LAYOUT[COLUMN_ID.method]!);
    methods[row % PAGE_ROWS] = row & 0xffff;
  }
}

for (const hard of [6 * MiB, 8 * MiB, 12 * MiB, 64 * MiB]) {
  test(`65,536 methods with a ${hard / MiB} MiB hard stop`, async () => {
    const { bytes, pages } = zip([{ name: "a.txt", body: encoder.encode("a") }], ROWS - 1);
    distinctMethods(pages);
    const slots = header(State.COMPLETE, ROWS);
    const api = await openWorker(mocks.expose, bytes, slots, pages, hard);
    let outcome: string;
    try {
      const layout = await api.layout();
      expect(layout.totals.entries).toBe(ROWS);
      expect(layout.totals.methods).toHaveLength(65_536);
      outcome = layout.map.ok ? "map" : `totals (${layout.map.error})`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A clear memory error, not a trap ("unreachable").
      expect(message).toMatch(/memory limit/);
      expect(message).not.toMatch(/unreachable/);
      outcome = "error";
    }
    expect(outcome).toBeDefined();
    expect(readBytes(slots)).toBeLessThanOrEqual(hard);
    // The read wasm still works after the map.
    expect((await api.facts()).size).toBe(bytes.length);
    if (hard >= 64 * MiB) expect(outcome).toBe("map");
  }, 120_000);
}
