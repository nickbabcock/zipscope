// A race for the last bytes between the two workers, with
// the real core wasm and the real read
// wasm on one header. The core wasm grows in a parse batch while the read
// worker grows a block at the same moment: the read worker asks the
// counter first and takes the last bytes. The core allocation then fails
// cleanly (`memoryFull()`, no trap), the store keeps whole rows, and the
// total stays at or below the hard stop exactly. Its own file gives it new
// wasm instances.
import { afterEach, expect, test, vi } from "vitest";
import { HEADER_BYTES, State } from "../contracts";
import * as readWasm from "../wasm/zipscope_read.js";
import { MiB, header, openCore, openWorker, reserved, zip } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
vi.mock("../wasm/zipscope_read.js", (importOriginal) => importOriginal());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("the read worker takes the last bytes and the core stops cleanly", async () => {
  const hard = 64 * MiB;
  const { bytes, page } = zip([{ name: "a.txt", body: new Uint8Array([0x61]) }], 300_000);
  const slots = header(State.PARSING, 1);
  const api = await openWorker(mocks.expose, bytes, slots, page, hard);
  // The pass reads the one committed row, then stops.
  await api.settled();
  const { parser, reservation, memory, memoryFull } = await openCore(slots, bytes, hard);
  const readMemory = (await readWasm.default()).memory;
  readWasm.setMemoryCap(Number.MAX_SAFE_INTEGER);
  expect(readWasm.reserveHeap(12 * MiB)).toBe(true);
  readWasm.releaseHeap();
  reservation.take(reservation.room() - 3 * MiB);

  const hook = reservation.growth;
  let grabbed: boolean | undefined;
  globalThis.__zipscopeStoreMemory = {
    reserve(bytes) {
      if (grabbed === undefined) {
        // The read worker grows at the same moment, and its reservation
        // comes first. It takes all but 128 KiB of the room.
        grabbed = readWasm.reserveHeap(reservation.room() - 192 * 1024);
      }
      return hook.reserve(bytes);
    },
    release: hook.release,
  };
  let parsed = 0;
  for (let batch = 0; batch < 100 && !memoryFull(); batch++) parsed += parser.parse(65_536);

  expect(grabbed).toBe(true);
  expect(memoryFull()).toBe(true);
  // The batch adds whole rows: the store and the tree agree.
  expect(parser.rows()).toBe(parsed);
  expect(parser.rows()).toBeLessThan(300_001);
  expect(parser.state()).toBe(State.PARSING);
  const { store, read } = reserved(slots);
  expect(store + read).toBeLessThanOrEqual(hard);
  expect(memory().byteLength + HEADER_BYTES).toBeLessThanOrEqual(store);
  expect(readMemory.buffer.byteLength).toBeLessThanOrEqual(read);
  // After the refusal, the calls that can grow do nothing.
  expect(parser.parse(65_536)).toBe(0);
  expect(parser.refreshViews()).toBe(false);
  expect(Array.from(parser.health()).length).toBeGreaterThan(0);
}, 120_000);
