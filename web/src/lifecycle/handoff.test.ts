import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HANDOFF_HASH, openHandoffTab, takeHandoffId } from "./address";
import {
  CHANNEL_PREFIX,
  readMessage,
  RECEIVE_MS,
  receiveFromOpener,
  SEND_MS,
  sendToNewTab,
} from "./handoff";
import type { ChannelLike, HandoffDeps } from "./handoff";

/** Channels of one origin: a message goes to the other channels with the
 *  same name, in a later task, as with BroadcastChannel. */
function fakeBus() {
  const open = new Map<string, Set<ChannelLike>>();
  const posted: { name: string; data: unknown }[] = [];
  const channel = (name: string): ChannelLike => {
    const made: ChannelLike = {
      onmessage: null,
      postMessage(data) {
        posted.push({ name, data });
        for (const other of open.get(name) ?? []) {
          if (other === made) continue;
          setTimeout(() => other.onmessage?.(new MessageEvent("message", { data })), 0);
        }
      },
      close() {
        open.get(name)?.delete(made);
      },
    };
    if (!open.has(name)) open.set(name, new Set());
    open.get(name)!.add(made);
    return made;
  };
  const deps: HandoffDeps = {
    channel,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  /** Sends `data` on `name` as another tab. */
  const inject = (name: string, data: unknown) => {
    const other = channel(name);
    other.postMessage(data);
    other.close();
  };
  const listeners = (name: string) => open.get(name)?.size ?? 0;
  return { deps, posted, inject, listeners };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const file = new File(["PK"], "next.zip");

test("the new tab gets the file through ready, file and ack", async () => {
  const bus = fakeBus();
  let received: Promise<{ file: File } | undefined> | undefined;
  // The tab opens in the click; the channel of the opener opens later.
  const id = openHandoffTab((url) => {
    expect(url.startsWith(`/${HANDOFF_HASH}`)).toBe(true);
    received = receiveFromOpener(url.slice(`/${HANDOFF_HASH}`.length), bus.deps);
  });
  await vi.advanceTimersByTimeAsync(10);
  const sent = sendToNewTab({ file }, id, bus.deps);
  await vi.advanceTimersByTimeAsync(300);
  expect(await received).toEqual({ file });
  expect(await sent).toBe("acknowledged");
  const kinds = bus.posted.map(({ data }) => (data as { kind: string }).kind);
  // The first ready had no listener; a later ready got the file.
  expect(kinds.slice(-2)).toEqual(["file", "ack"]);
  expect(kinds.slice(0, -2).every((kind) => kind === "ready")).toBe(true);
  // Both tabs closed the channel.
  expect(bus.listeners(bus.posted[0]!.name)).toBe(0);
});

test("the opener sends the file one time, and only after ready", async () => {
  const bus = fakeBus();
  const id = crypto.randomUUID();
  const sent = sendToNewTab({ file }, id, bus.deps);
  const name = `${CHANNEL_PREFIX}${id}`;
  const base = { zipscope: "handoff", version: 1, id };
  // An ack before the file, a ready of another version or of another id,
  // and an unknown kind give nothing.
  bus.inject(name, { ...base, kind: "ack" });
  bus.inject(name, { ...base, kind: "ready", version: 2 });
  bus.inject(name, { ...base, kind: "ready", id: crypto.randomUUID() });
  bus.inject(name, { ...base, kind: "hello" });
  bus.inject(name, "ready");
  await vi.advanceTimersByTimeAsync(10);
  expect(bus.posted.filter(({ data }) => (data as { kind?: string }).kind === "file")).toEqual([]);
  bus.inject(name, { ...base, kind: "ready" });
  bus.inject(name, { ...base, kind: "ready" });
  await vi.advanceTimersByTimeAsync(10);
  const files = bus.posted.filter(({ data }) => (data as { kind?: string }).kind === "file");
  expect(files).toHaveLength(1);
  expect((files[0]!.data as { file: File }).file).toBe(file);
  bus.inject(name, { ...base, kind: "ack" });
  await vi.advanceTimersByTimeAsync(10);
  expect(await sent).toBe("acknowledged");
});

test("the opener forgets the file when no tab acknowledges it", async () => {
  const bus = fakeBus();
  const id = crypto.randomUUID();
  const sent = sendToNewTab({ file }, id, bus.deps);
  await vi.advanceTimersByTimeAsync(SEND_MS);
  expect(await sent).toBe("timeout");
  const name = `${CHANNEL_PREFIX}${id}`;
  expect(bus.listeners(name)).toBe(0);
  // A late ready gets no file.
  bus.inject(name, { zipscope: "handoff", version: 1, kind: "ready", id });
  await vi.advanceTimersByTimeAsync(10);
  expect(bus.posted.some(({ data }) => (data as { kind?: string }).kind === "file")).toBe(false);
});

test("the new tab ignores messages that are not a valid file, then shows its drop zone", async () => {
  const bus = fakeBus();
  const id = crypto.randomUUID();
  const name = `${CHANNEL_PREFIX}${id}`;
  const received = receiveFromOpener(id, bus.deps);
  const base = { zipscope: "handoff", version: 1, id, kind: "file" };
  bus.inject(name, { ...base, file: "not a file" });
  bus.inject(name, { ...base, file: new Blob(["PK"]) });
  bus.inject(name, { ...base, file, version: 0 });
  bus.inject(name, { ...base, file, id: crypto.randomUUID() });
  bus.inject(name, { ...base, file, zipscope: "other" });
  // A handle that is not a file handle makes the message invalid.
  bus.inject(name, { ...base, file, handle: { kind: "file" } });
  bus.inject(name, null);
  await vi.advanceTimersByTimeAsync(RECEIVE_MS);
  expect(await received).toBeUndefined();
  // It sent no ack, and it sent ready again while it waited.
  const kinds = bus.posted.map(({ data }) => (data as { kind?: string } | null)?.kind);
  expect(kinds).not.toContain("ack");
  expect(kinds.filter((kind) => kind === "ready").length).toBeGreaterThan(10);
  expect(bus.listeners(name)).toBe(0);
});

test("the new tab accepts one file only", async () => {
  const bus = fakeBus();
  const id = crypto.randomUUID();
  const name = `${CHANNEL_PREFIX}${id}`;
  const received = receiveFromOpener(id, bus.deps);
  const base = { zipscope: "handoff", version: 1, id, kind: "file" };
  bus.inject(name, { ...base, file });
  bus.inject(name, { ...base, file: new File(["x"], "other.zip") });
  await vi.advanceTimersByTimeAsync(10);
  expect((await received)?.file).toBe(file);
  const acks = bus.posted.filter(({ data }) => (data as { kind?: string }).kind === "ack");
  expect(acks).toHaveLength(1);
});

test("readMessage keeps only the known fields", () => {
  const id = crypto.randomUUID();
  const ready = readMessage({ zipscope: "handoff", version: 1, kind: "ready", id, extra: 1 }, id);
  expect(ready).toEqual({ zipscope: "handoff", version: 1, kind: "ready", id });
  expect(readMessage({ zipscope: "handoff", version: 1, kind: "ready", id: "x" }, "x")).toBe(
    undefined,
  );
});

test("takeHandoffId removes the id from the address", () => {
  const id = crypto.randomUUID();
  const history = { state: { zipscope: 1 }, replaceState: vi.fn() };
  expect(takeHandoffId({ hash: `${HANDOFF_HASH}${id}` }, history)).toBe(id);
  expect(history.replaceState).toHaveBeenCalledWith({ zipscope: 1 }, "", "/");
  history.replaceState.mockClear();
  expect(takeHandoffId({ hash: `${HANDOFF_HASH}not-an-id` }, history)).toBeUndefined();
  expect(history.replaceState).toHaveBeenCalledOnce();
  history.replaceState.mockClear();
  expect(takeHandoffId({ hash: "" }, history)).toBeUndefined();
  expect(history.replaceState).not.toHaveBeenCalled();
});
