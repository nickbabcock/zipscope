// An encoder worker at the hard stop: the store fills the
// budget, so a growth of the write wasm does not fit. The row stops with
// the memory error, and the reservations stay at or below the hard stop.
// Its own file gives it a new wasm instance. Only the encoder has a
// memory limit here: the lead of a test shares the wasm instance.
import { afterEach, expect, test, vi } from "vitest";
import { PROGRESS_BYTES, State, WRITE_SLOTS_PER_WORKER } from "../contracts";
import type { EncodePart, EncoderMessage, LeadMessage } from "../contracts";
import { WindowReaderAt } from "../parse/reader";
import type { SyncBlobReader } from "../parse/reader";
import { BytesFile, MiB, encoder, header, reserved, setStore, zip } from "../read/wasm-harness";
import { stubReader, workers } from "./harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

test("an encoder at the hard stop gives a memory error, not a trap", async () => {
  stubReader();
  const hard = 48 * MiB;
  // 3 MiB of text: the encoder keeps it and its Zstandard form.
  const body = encoder.encode("abcdefghij".repeat(300_000));
  const { bytes } = zip([{ name: "big.txt", body }]);
  const slots = header(State.COMPLETE, 1);
  const wasm = await import("../wasm/zipscope_write.js");
  const instance = await wasm.default();
  const file = new BytesFile(bytes) as unknown as File;
  const Sync = (globalThis as unknown as { FileReaderSync: new () => SyncBlobReader })
    .FileReaderSync;
  const lead = wasm.RemuxLead.open(
    new WindowReaderAt(file, new Sync()),
    new WindowReaderAt(file, new Sync()),
    bytes.length,
    1,
  );
  const job = lead.job(0);
  const record = job.record;
  // Leave 2 MiB above the wasm memory.
  setStore(slots, hard - instance.memory.buffer.byteLength - 2 * MiB);
  const { encoder: api } = await workers(mocks.expose);
  const pool = new SharedArrayBuffer(4 * WRITE_SLOTS_PER_WORKER * 2);
  const progress = new SharedArrayBuffer(PROGRESS_BYTES);
  const channel = new MessageChannel();
  const parts: EncodePart[] = [];
  const ended = new Promise<void>((resolve) => {
    channel.port2.onmessage = (event: MessageEvent<EncoderMessage>) => {
      parts.push(...event.data.parts);
      if (parts.some((part) => part.end !== undefined)) resolve();
    };
  });
  await api.open(file, slots, pool, 1, progress, channel.port1, { hard });
  const message: LeadMessage = {
    type: "jobs",
    jobs: [{ row: 0, record, base: job.base, offset: job.offset, uncompressed: job.uncompressed }],
  };
  channel.port2.postMessage(message);
  await ended;
  const last = parts.at(-1)!;
  expect(last.end).toBe("skip");
  expect(last.error?.toLowerCase()).toContain("memory");
  const { store, read } = reserved(slots);
  expect(store + read).toBeLessThanOrEqual(hard);
  channel.port1.close();
  channel.port2.close();
}, 60_000);
