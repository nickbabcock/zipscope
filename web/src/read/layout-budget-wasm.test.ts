// The byte map stays below the memory limit of the read worker.
// The wasm memory does not shrink, so this test has its own file.
import { afterEach, expect, test, vi } from "vitest";
import { State } from "../contracts";
import { MiB, encoder, header, openWorker, readBytes, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

test("a map with no room gives an error and still counts the totals", async () => {
  const entries = [{ name: "a.txt", body: encoder.encode("a") }];
  // 600,001 rows need about 9.2 MiB for the map, more than the 8 MiB
  // hard stop leaves.
  const { bytes, pages } = zip(entries, 600_000);
  const slots = header(State.COMPLETE, 600_001);
  const api = await openWorker(mocks.expose, bytes, slots, pages, 8 * MiB);
  const layout = await api.layout();
  expect(layout.map.ok).toBe(false);
  if (layout.map.ok) return;
  expect(layout.map.error).toMatch(/memory limit/);
  expect(layout.totals.entries).toBe(600_001);
  expect(readBytes(slots)).toBeLessThanOrEqual(8 * MiB);
}, 60_000);
