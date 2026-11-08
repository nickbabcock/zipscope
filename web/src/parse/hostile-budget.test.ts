/*
ASSUMED API
MirrorWriter.allocatedBytes(): number
parseInBatches(parser, writer, header, now?, budget?): Promise<ParseOutcome>
budget: {
  softBytes: number;
  hardBytes: number;
  confirm: (usage: { rows: number; bytes: number }) => Promise<boolean>;
}

The writer gives the current allocated bytes. Use exact bytes for limits.
The optional limits let tests use small buffers. The worker must connect
confirm to its Comlink prompt. The default limits are 1 GiB and 2 GiB.
Pause at the soft limit before another batch. Publish the rows first.
One approval permits parsing up to the hard limit. A refusal cancels.
Cancel must work while confirm is pending. A late answer cannot restart
parsing. A rejected prompt fails with the committed rows kept.
The hard limit takes priority. It cannot be bypassed by approval.
Do not prompt after a complete parse. Keep terminal parse errors.

The names may change. Record a reason for a change to an expected result.
*/

import { afterEach, expect, test, vi } from "vitest";
import { CHUNK_BYTES, HEADER_BYTES, Header, State } from "../contracts";
import { FakeStore } from "./fake-store";
import { parseInBatches } from "./loop";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const release of cleanup.splice(0)) release();
});

function turn() {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

function setup(usage: number[], softBytes = 1001, hardBytes = 3001) {
  const store = new FakeStore(CHUNK_BYTES + 2 ** 20);
  store.queue(Array.from({ length: 10 }, (_, row) => `f${row}`));
  const parse = store.parse.bind(store);
  const calls = vi.spyOn(store, "parse").mockImplementation((limit) => parse(Math.min(limit, 2)));
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const slots = new Int32Array(header);
  let bytes = usage[0]!;
  let batches = 0;
  const writer = {
    allocatedBytes: () => bytes,
    publish: () => {
      batches++;
      bytes = usage[Math.min(batches, usage.length - 1)]!;
      Atomics.store(slots, Header.STORE_KIB, Math.ceil(bytes / 1024));
      Atomics.store(slots, Header.COMMITTED_ROWS, store.rows());
    },
  };
  const answer = Promise.withResolvers<boolean>();
  const confirm = vi.fn(() => answer.promise);
  const start = () =>
    parseInBatches(store, writer, header, () => 0, { softBytes, hardBytes, confirm });
  cleanup.push(() => {
    Atomics.store(slots, Header.CANCEL, 1);
    answer.resolve(false);
  });
  return { store, calls, slots, writer, answer, confirm, start };
}

test("the soft limit pauses after publishing and waits for an explicit answer", async () => {
  const h = setup([0, 1001]);
  const result = h.start();
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  await expect.poll(() => h.confirm.mock.calls.length, { timeout: 1000 }).toBe(1);
  expect(Atomics.load(h.slots, Header.STATE)).toBe(State.PAUSED);
  expect(Atomics.load(h.slots, Header.COMMITTED_ROWS)).toBe(2);
  expect(h.confirm).toHaveBeenCalledWith({ rows: 2, bytes: 1001 });
  const calls = h.calls.mock.calls.length;
  await turn();
  await turn();
  expect(h.calls).toHaveBeenCalledTimes(calls);
  expect(settled).toBe(false);
  h.answer.resolve(true);
  await expect(result).resolves.toEqual({ kind: "complete", rows: 10 });
  expect(h.confirm).toHaveBeenCalledTimes(1);
  expect(Atomics.load(h.slots, Header.STATE)).toBe(State.COMPLETE);
});

test("refusing the soft budget keeps the committed prefix", async () => {
  const h = setup([0, 1001]);
  const result = h.start();
  await expect.poll(() => h.confirm.mock.calls.length, { timeout: 1000 }).toBe(1);
  h.answer.resolve(false);
  await expect(result).resolves.toEqual({ kind: "cancelled", rows: 2 });
  expect(h.calls).toHaveBeenCalledTimes(1);
  expect(Atomics.load(h.slots, Header.COMMITTED_ROWS)).toBe(2);
  expect(Atomics.load(h.slots, Header.STATE)).toBe(State.CANCELLED);
});

test("cancel works with an unanswered prompt and a late approval cannot resume", async () => {
  const h = setup([0, 1001]);
  const result = h.start();
  await expect.poll(() => h.confirm.mock.calls.length, { timeout: 1000 }).toBe(1);
  Atomics.store(h.slots, Header.CANCEL, 1);
  await expect(result).resolves.toEqual({ kind: "cancelled", rows: 2 });
  h.answer.resolve(true);
  await turn();
  await turn();
  expect(h.calls).toHaveBeenCalledTimes(1);
  expect(Atomics.load(h.slots, Header.COMMITTED_ROWS)).toBe(2);
  expect(Atomics.load(h.slots, Header.STATE)).toBe(State.CANCELLED);
});

test("the hard limit takes priority when a batch reaches both limits", async () => {
  const h = setup([0, 3001]);
  await expect(h.start()).resolves.toMatchObject({
    kind: "failed",
    rows: 2,
    message: expect.stringMatching(/memory|budget|limit/i),
  });
  expect(h.confirm).not.toHaveBeenCalled();
  expect(h.calls).toHaveBeenCalledTimes(1);
  expect(Atomics.load(h.slots, Header.COMMITTED_ROWS)).toBe(2);
  expect(Atomics.load(h.slots, Header.STATE)).toBe(State.FAILED);
});

test("approval of the soft budget cannot bypass the hard stop", async () => {
  const h = setup([0, 1001, 3001]);
  const result = h.start();
  await expect.poll(() => h.confirm.mock.calls.length, { timeout: 1000 }).toBe(1);
  h.answer.resolve(true);
  await expect(result).resolves.toMatchObject({ kind: "failed", rows: 4 });
  expect(h.confirm).toHaveBeenCalledTimes(1);
  expect(h.calls).toHaveBeenCalledTimes(2);
  expect(Atomics.load(h.slots, Header.COMMITTED_ROWS)).toBe(4);
});

test("memory that is already at the hard limit prevents the first batch", async () => {
  const h = setup([3001]);
  await expect(h.start()).resolves.toMatchObject({ kind: "failed", rows: 0 });
  expect(h.calls).not.toHaveBeenCalled();
  expect(h.confirm).not.toHaveBeenCalled();
  expect(Atomics.load(h.slots, Header.COMMITTED_ROWS)).toBe(0);
});

test("memory that is already at the soft limit needs approval before the first batch", async () => {
  const h = setup([1001]);
  const result = h.start();
  await expect.poll(() => h.confirm.mock.calls.length, { timeout: 1000 }).toBe(1);
  expect(h.confirm).toHaveBeenCalledWith({ rows: 0, bytes: 1001 });
  expect(h.calls).not.toHaveBeenCalled();
  expect(Atomics.load(h.slots, Header.STATE)).toBe(State.PAUSED);
  h.answer.resolve(true);
  await expect(result).resolves.toEqual({ kind: "complete", rows: 10 });
  expect(h.confirm).toHaveBeenCalledTimes(1);
});

test("a rejected prompt ends parsing and keeps the prefix", async () => {
  const h = setup([0, 1001]);
  const result = h.start();
  await expect.poll(() => h.confirm.mock.calls.length, { timeout: 1000 }).toBe(1);
  h.answer.reject(new Error("Prompt disconnected"));
  await expect(result).resolves.toMatchObject({
    kind: "failed",
    rows: 2,
    message: expect.stringMatching(/prompt|disconnect/i),
  });
  expect(h.calls).toHaveBeenCalledTimes(1);
  expect(Atomics.load(h.slots, Header.STATE)).toBe(State.FAILED);
});

test("KiB rounding cannot cause an early budget prompt", async () => {
  const h = setup([0, 1000]);
  await expect(h.start()).resolves.toEqual({ kind: "complete", rows: 10 });
  expect(Atomics.load(h.slots, Header.STORE_KIB)).toBe(1);
  expect(h.confirm).not.toHaveBeenCalled();
});

test("completion at the soft limit does not ask to parse more", async () => {
  const h = setup([0, 0, 0, 0, 0, 1001]);
  await expect(h.start()).resolves.toEqual({ kind: "complete", rows: 10 });
  expect(h.confirm).not.toHaveBeenCalled();
  expect(Atomics.load(h.slots, Header.STATE)).toBe(State.COMPLETE);
});

test("a terminal parse error at the soft limit is not hidden by a prompt", async () => {
  const h = setup([0, 0, 0, 0, 0, 1001]);
  h.store.failAfterQueue("Bad central directory");
  await expect(h.start()).resolves.toEqual({
    kind: "failed",
    rows: 10,
    message: "Bad central directory",
  });
  expect(h.confirm).not.toHaveBeenCalled();
  expect(Atomics.load(h.slots, Header.STATE)).toBe(State.FAILED);
});
