// A preview after a hard stop where the last parse batch took part of the
// reserve. The last batch can allocate a new column
// page in the core wasm, and then the publish refuses the mirror of that
// page. The page stays in the store memory, so the read worker gets less
// than the reserve. A read must then scan only the room that it needs, and
// not keep the room of the background pass free. Its own file gives it a
// new wasm instance.
import { afterEach, expect, test, vi } from "vitest";
import { PAGE_BYTES, State, readReserve } from "../contracts";
import { MiB, encoder, header, openWorker, setStore, total, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

test("a preview after a hard stop works when the last batch took part of the reserve", async () => {
  // The case of preview.spec.ts: a hard stop of 32 MiB with 100,000
  // entries. The batch that stopped parsing passed row 65,536, so the core
  // allocated a second column page. The e2e test measured the store at up
  // to 29,164,544 bytes, which leaves 4,389,888 bytes for the read worker.
  const hard = 32 * MiB;
  const store = 29_164_544;
  // The new page is the most part of the overrun past the reserve.
  expect(store - (hard - readReserve(hard))).toBeLessThan(PAGE_BYTES);
  const entries = Array.from({ length: 10 }, (_, index) => ({
    name: `f${index}.txt`,
    body: encoder.encode(`body ${index}`),
  }));
  const { bytes, page } = zip(entries, 65_526);
  const slots = header(State.FAILED, 65_536);
  setStore(slots, store);
  const api = await openWorker(mocks.expose, bytes, slots, page, hard);
  await api.settled();
  const chunk = await api.read(1, 0, 1024);
  expect(chunk.error).toBeUndefined();
  expect(new TextDecoder().decode(chunk.bytes)).toBe("body 1");
  expect(chunk.state).toBe("verified");
  expect(total(slots)).toBeLessThanOrEqual(hard);
}, 60_000);
