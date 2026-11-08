// A race for the last bytes between the two workers, with
// the real core wasm and the real read
// wasm on one header. The read worker grows a block while the core wasm
// grows in a parse batch at the same moment: the core asks the counter
// first and takes the last bytes. The read allocation then fails cleanly
// (no trap), and the total stays at or below the hard stop exactly. Its own
// file gives it new wasm instances.
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

test("the core takes the last bytes and the read allocation fails cleanly", async () => {
  const hard = 64 * MiB;
  const { bytes, page } = zip([{ name: "a.txt", body: new Uint8Array([0x61]) }], 300_000);
  const slots = header(State.PARSING, 1);
  const api = await openWorker(mocks.expose, bytes, slots, page, hard);
  // The pass reads the one committed row, then stops.
  await api.settled();
  const { parser, reservation, memory, memoryFull } = await openCore(slots, bytes, hard);
  const readMemory = (await readWasm.default()).memory;
  // Only the counter limits the read worker in this test.
  readWasm.setMemoryCap(Number.MAX_SAFE_INTEGER);
  // The read worker grows past its reserve, so the rules of both workers
  // share the last bytes. It holds the block, so its next block must grow
  // the memory.
  expect(readWasm.reserveHeap(12 * MiB)).toBe(true);
  // The parse worker reserves all but 12 MiB for its mirrors. The first
  // row of the core needs a name chunk (4 MiB) and a page (4.25 MiB).
  reservation.take(reservation.room() - 12 * MiB);
  expect(reserved(slots).store + reserved(slots).read).toBe(hard - 12 * MiB);

  const hook = globalThis.__zipscopeReadMemory!;
  let parsed = -1;
  globalThis.__zipscopeReadMemory = {
    reserve(bytes) {
      if (parsed < 0) {
        // The core grows at the same moment, and its reservation comes
        // first. It parses until the budget refuses it.
        parsed = 0;
        while (!memoryFull()) parsed += parser.parse(65_536);
      }
      return hook.reserve(bytes);
    },
    release: hook.release,
  };
  const before = readMemory.buffer.byteLength;
  // The block is 11 MiB more than the free heap, so the memory must grow
  // by 11 MiB. That fits in the 12 MiB of room, but not in what the core
  // leaves: the core takes the room in allocations of at most 4 MiB.
  const free = before - readWasm.heapBytes();
  expect(readWasm.reserveHeap(free + 11 * MiB)).toBe(false);
  readWasm.releaseHeap();

  expect(parsed).toBeGreaterThan(0);
  expect(parser.rows()).toBe(parsed);
  expect(memoryFull()).toBe(true);
  expect(readMemory.buffer.byteLength).toBe(before);
  const { store, read } = reserved(slots);
  expect(store + read).toBeLessThanOrEqual(hard);
  expect(memory().byteLength + HEADER_BYTES).toBeLessThanOrEqual(store);
  expect(readMemory.buffer.byteLength).toBeLessThanOrEqual(read);
  // A small allocation of the read worker still fits in its free heap.
  expect(readWasm.reserveHeap(64 * 1024)).toBe(true);
  readWasm.releaseHeap();
}, 120_000);
