// The read worker after a hard stop: it
// uses only the reserve that the hard stop kept. Its own file gives it a
// new wasm instance.
import { afterEach, expect, test, vi } from "vitest";
import { State, readReserve } from "../contracts";
import { MiB, encoder, header, openWorker, setStore, total, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

test("a preview after a hard stop uses only the reserve", async () => {
  const hard = 64 * MiB;
  const entries = Array.from({ length: 10 }, (_, index) => ({
    name: `kept/${index}.txt`,
    body: encoder.encode(`body ${index}`),
  }));
  // The parse worker kept 600,010 rows and stopped with the store at the
  // hard stop less the reserve. The table of all rows does not fit.
  const { bytes, pages } = zip(entries, 600_000);
  const slots = header(State.FAILED, 600_010);
  setStore(slots, hard - readReserve(hard));
  const api = await openWorker(mocks.expose, bytes, slots, pages, hard);
  await api.settled();
  const chunk = await api.read(7, 0, 1024);
  expect(new TextDecoder().decode(chunk.bytes)).toBe("body 7");
  expect(chunk.state).toBe("verified");
  expect(total(slots)).toBeLessThanOrEqual(hard);
  const late = await api.read(600_009, 0, 1024);
  expect(late.state).toBe("failed");
  expect(late.error).toContain("memory limit");
  await api.settled();
  expect(total(slots)).toBeLessThanOrEqual(hard);
}, 60_000);
