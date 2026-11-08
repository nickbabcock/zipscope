// The read worker after a complete listing near the hard stop. The
// total of the store and the read worker stays
// below the hard stop. Its own file gives it a new wasm instance.
import { afterEach, expect, test, vi } from "vitest";
import { State } from "../contracts";
import { MiB, encoder, header, openWorker, setStore, total, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

test("a preview after a complete listing stays below the hard stop", async () => {
  // A case that failed before: the listing completed close to a 40 MiB
  // hard stop, and the preview passed it.
  const hard = 40 * MiB;
  const text = encoder.encode("x".repeat(6 * MiB));
  const { bytes, page } = zip([{ name: "big.txt", body: text }]);
  const slots = header(State.COMPLETE, 1);
  setStore(slots, hard - 8 * MiB);
  const api = await openWorker(mocks.expose, bytes, slots, page, hard);
  const chunk = await api.read(0, 0, MiB);
  expect(chunk.state).toBe("reading");
  expect(chunk.bytes.length).toBe(MiB);
  expect(total(slots)).toBeLessThanOrEqual(hard);
  // A read that needs more than the room is refused, and the stream stays.
  const large = await api.read(0, MiB, 16 * MiB);
  expect(large.state).toBe("failed");
  expect(large.error).toContain("memory limit");
  expect(total(slots)).toBeLessThanOrEqual(hard);
  const next = await api.read(0, MiB, MiB);
  expect(next.state).toBe("reading");
  expect(next.offset).toBe(MiB);
  expect(total(slots)).toBeLessThanOrEqual(hard);
});
