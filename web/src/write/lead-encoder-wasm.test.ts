// Failures of the lead and the encoders: an encoder that throws fails
// the copy (the lead does not wait for it), and a write worker whose start
// memory does not fit below the hard stop does not start.
import { afterEach, expect, test, vi } from "vitest";
import { HEADER_BYTES, PROGRESS_BYTES, State, WRITE_SLOTS_PER_WORKER } from "../contracts";
import { remuxSummary } from "../remux/text";
import { encoder, header, reserved, setStore, zip } from "../read/wasm-harness";
import { memoryHandle, runRemux, stubReader, workers } from "./harness";
import { BytesFile } from "../read/wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("an encoder that throws fails the copy, and the lead does not wait", async () => {
  const wasm = await import("../wasm/zipscope_write.js");
  vi.spyOn(wasm.RemuxEncoder.prototype, "step").mockImplementation(() => {
    throw new Error("a trap in the test");
  });
  const entries = Array.from({ length: 5 }, (_, index) => ({
    name: `${index}.txt`,
    body: encoder.encode(`row ${index} `.repeat(1000)),
  }));
  const { bytes } = zip(entries);
  const out = memoryHandle();
  const { report } = await runRemux(
    mocks.expose,
    bytes,
    header(State.COMPLETE, entries.length),
    entries.length,
    { kind: "file", handle: out.handle },
    2,
    2 ** 31,
  );
  expect(report.outcome).toBe("failed");
  expect(report.error).toContain("a trap in the test");
  // The trap came before the first output, so no data of the row was
  // written.
  expect(report.error).toMatch(/^Row \d+ failed: The encoder stopped: a trap in the test$/);
  expect(out.state.aborted).toBe(true);
  expect(out.state.closed).toBe(false);
}, 60_000);

test("an encoder that goes away with no error event fails the copy", async () => {
  // The port of the pool has no encoder behind it, as when the browser
  // terminated the worker: no part, no `error` event. The waits of the
  // lead take 0 ms here, so the 240 waits do not take 60 s.
  const timer = globalThis.setTimeout;
  vi.stubGlobal("setTimeout", (callback: () => void) => timer(callback, 0));
  stubReader();
  const { lead } = await workers(mocks.expose);
  const entries = [{ name: "a.txt", body: encoder.encode("a ".repeat(1000)) }];
  const { bytes } = zip(entries);
  const file = new BytesFile(bytes) as unknown as File;
  const channel = new MessageChannel();
  const out = memoryHandle();
  const report = await lead.run(
    file,
    header(State.COMPLETE, entries.length),
    new SharedArrayBuffer(4 * WRITE_SLOTS_PER_WORKER * 2),
    entries.length,
    { kind: "file", handle: out.handle },
    new SharedArrayBuffer(PROGRESS_BYTES),
    [channel.port2],
    { hard: 2 ** 31 },
  );
  channel.port1.close();
  channel.port2.close();
  expect(report.outcome).toBe("failed");
  expect(report.error).toBe(
    "The encoder of row 0 sent nothing for 60 s, so the copy is not complete. Try again.",
  );
  expect(out.state.aborted).toBe(true);
  expect(out.state.closed).toBe(false);
}, 60_000);

test("a write worker does not start when its memory passes the hard stop", async () => {
  const wasm = await import("../wasm/zipscope_write.js");
  const instance = await wasm.default();
  // A path in a variable: the worker modules have their own project.
  const memoryPath = "./memory";
  const { WriteMemory } = (await import(memoryPath)) as {
    WriteMemory: new (
      header: SharedArrayBuffer,
      slots: SharedArrayBuffer,
      index: number,
      memory: () => ArrayBuffer,
      hard: number,
    ) => unknown;
  };
  const hard = 64 * 2 ** 20;
  const slots = new SharedArrayBuffer(HEADER_BYTES);
  // The store leaves less room than the wasm memory of the worker.
  setStore(slots, hard - instance.memory.buffer.byteLength + 2 ** 16);
  const pool = new SharedArrayBuffer(4 * WRITE_SLOTS_PER_WORKER);
  expect(() => new WriteMemory(slots, pool, 0, () => instance.memory.buffer, hard)).toThrow(
    "memory limit",
  );
  const { store, read } = reserved(slots);
  expect(store + read).toBeLessThanOrEqual(hard);
  expect(read).toBe(0);
});

test("the cancel text says what happened to each place", () => {
  const report = {
    outcome: "cancelled" as const,
    written: 0,
    rows: 1,
    zstd: 0,
    kept: 0,
    folders: 0,
    bytes: 0,
    output: 0,
    items: [],
    more: 0,
  };
  expect(remuxSummary("a-zstd.zip", report, "file", 1000)).toContain("the file did not change");
  expect(remuxSummary("a-zstd.zip", report, "file", 1000)).not.toContain("partial");
  expect(remuxSummary("a-zstd.zip", report, "stream", 1000)).toContain("no central directory");
});

test("the silence count of the lead starts again at each message of the encoder", async () => {
  // This tests the lead, not the encoder: the port of the pool has a fake
  // encoder that sends an empty part each 2 ms for 400 parts, and then
  // the data. The waits of the lead take 0 ms, so the lead waits more
  // than 240 times in all, but never 240 times with no message.
  const timer = globalThis.setTimeout;
  let waits = 0;
  vi.stubGlobal("setTimeout", (callback: () => void) => {
    waits++;
    return timer(callback, 0);
  });
  stubReader();
  const { lead } = await workers(mocks.expose);
  const body = encoder.encode("slow ".repeat(200));
  const entries = [{ name: "a.txt", body }];
  const { bytes } = zip(entries);
  const file = new BytesFile(bytes) as unknown as File;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event: MessageEvent<{ type: string }>) => {
    if (event.data.type !== "jobs") return;
    let sent = 0;
    const tick = () => {
      if (sent++ < 400) {
        channel.port1.postMessage({
          type: "parts",
          parts: [{ row: 0, bytes: new Uint8Array(0), decoded: 1 }],
        });
        timer(tick, 2);
      } else {
        channel.port1.postMessage({
          type: "parts",
          parts: [{ row: 0, bytes: body, decoded: 0, method: 0, end: "done" }],
        });
      }
    };
    tick();
  };
  const out = memoryHandle();
  const report = await lead.run(
    file,
    header(State.COMPLETE, entries.length),
    new SharedArrayBuffer(4 * WRITE_SLOTS_PER_WORKER * 2),
    entries.length,
    { kind: "file", handle: out.handle },
    new SharedArrayBuffer(PROGRESS_BYTES),
    [channel.port2],
    { hard: 2 ** 31 },
  );
  channel.port1.close();
  channel.port2.close();
  expect(report.error).toBeUndefined();
  expect(report.outcome).toBe("complete");
  expect(waits).toBeGreaterThan(240);
  expect(out.state.closed).toBe(true);
}, 60_000);

test("an encoder sends its parts each second, also in the verify pass", async () => {
  // Each read of the clock is 300 ms later. A stored row of 12 MiB has 12
  // verify steps whose parts have no bytes. The row has words from a list
  // of 8 in a pseudo-random sequence, so it has no short cycle, but
  // Zstandard makes its output parts small, because each word has only 3
  // bits of information.
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (now += 300));
  stubReader();
  const { lead, encoder: api } = await workers(mocks.expose);
  const words = ["alpha ", "bravo ", "delta ", "gamma ", "kappa ", "omega ", "sigma ", "theta "];
  const body = new Uint8Array(12 * 2 ** 20);
  let state = 1;
  for (let index = 0; index < body.length; index += 6) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    body.set(encoder.encode(words[state >>> 29]!).subarray(0, body.length - index), index);
  }
  const entries = [{ name: "words.txt", body }];
  const { bytes } = zip(entries);
  const file = new BytesFile(bytes) as unknown as File;
  const slots = new SharedArrayBuffer(4 * WRITE_SLOTS_PER_WORKER * 2);
  const progress = new SharedArrayBuffer(PROGRESS_BYTES);
  const slotsHeader = header(State.COMPLETE, entries.length);
  const channel = new MessageChannel();
  // The messages of the encoder to the lead.
  let messages = 0;
  const post = channel.port1.postMessage.bind(channel.port1);
  channel.port1.postMessage = ((message: unknown, transfer: Transferable[]) => {
    messages++;
    post(message, transfer);
  }) as typeof channel.port1.postMessage;
  await api.open(file, slotsHeader, slots, 1, progress, channel.port1, { hard: 2 ** 31 });
  const out = memoryHandle();
  const report = await lead.run(
    file,
    slotsHeader,
    slots,
    entries.length,
    { kind: "file", handle: out.handle },
    progress,
    [channel.port2],
    { hard: 2 ** 31 },
  );
  channel.port2.close();
  expect(report.outcome).toBe("complete");
  // 24 steps of 1 MiB (verify and output) in batches of at most about
  // 1 s. Before the time rule, the parts had too few bytes for a batch of
  // 1 MiB, so they went in one message at the end.
  expect(messages).toBeGreaterThanOrEqual(4);
}, 120_000);

test("an encoder whose steps take more than 1 s sends each part at once", async () => {
  // The clock moves 1.5 s in each step of the encoder, and stays still
  // between the steps. The age of a batch starts at the last message, so
  // each part goes in its own message, and the lead hears from the
  // encoder after each step. When the age starts at the first part of
  // the batch, the first part waits for the next step, and the lead
  // hears from the encoder only after each second step.
  const wasm = await import("../wasm/zipscope_write.js");
  const step = wasm.RemuxEncoder.prototype.step;
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(wasm.RemuxEncoder.prototype, "step").mockImplementation(function (
    this: typeof wasm.RemuxEncoder.prototype,
    ...args: Parameters<typeof step>
  ) {
    now += 1500;
    return step.apply(this, args);
  });
  stubReader();
  const { lead, encoder: api } = await workers(mocks.expose);
  // A stored row of 6 MiB: 6 verify steps and 6 output steps.
  const body = encoder.encode("slow source ".repeat((6 * 2 ** 20) / 12));
  const entries = [{ name: "slow.txt", body }];
  const { bytes } = zip(entries);
  const file = new BytesFile(bytes) as unknown as File;
  const slots = new SharedArrayBuffer(4 * WRITE_SLOTS_PER_WORKER * 2);
  const progress = new SharedArrayBuffer(PROGRESS_BYTES);
  const slotsHeader = header(State.COMPLETE, entries.length);
  const channel = new MessageChannel();
  // The parts in each message of the encoder to the lead.
  const sizes: number[] = [];
  const post = channel.port1.postMessage.bind(channel.port1);
  channel.port1.postMessage = ((message: { parts: unknown[] }, transfer: Transferable[]) => {
    sizes.push(message.parts.length);
    post(message, transfer);
  }) as typeof channel.port1.postMessage;
  await api.open(file, slotsHeader, slots, 1, progress, channel.port1, { hard: 2 ** 31 });
  const out = memoryHandle();
  const report = await lead.run(
    file,
    slotsHeader,
    slots,
    entries.length,
    { kind: "file", handle: out.handle },
    progress,
    [channel.port2],
    { hard: 2 ** 31 },
  );
  channel.port2.close();
  expect(report.outcome).toBe("complete");
  expect(sizes.length).toBeGreaterThanOrEqual(10);
  expect(Math.max(...sizes)).toBe(1);
}, 120_000);
