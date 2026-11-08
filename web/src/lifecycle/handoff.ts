// The new-tab handoff. One tab has one
// archive. "Open in new tab" opens a new tab and gives it the File through
// a BroadcastChannel. A BroadcastChannel does not keep messages for a tab
// that does not listen yet, so the handoff is a handshake:
//
//   1. The opener makes a one-time id, listens on the channel of that id,
//      and opens `/#handoff=<id>` in a new tab.
//   2. The new tab removes the id from the address bar, listens on the
//      channel of the id, and sends `ready` until it gets the file.
//   3. On the first `ready`, the opener sends `file` one time.
//   4. The new tab sends `ack`. Both tabs close the channel.
//
// With no file in RECEIVE_MS, the new tab shows its drop zone. With no
// ack in SEND_MS, the opener forgets the file.
//
// Each message comes from another tab of the same origin, but that tab can
// run another version of Zipscope or can be a stale tab, so a message is
// untrusted input. Each side checks the shape and the id of a message and
// ignores all other messages. The channel name has the one-time id, so
// only the tab that has the id in its address listens. The opener sends
// the file only after a `ready` on that channel, and only one time.
//
// This module has no Solid code, so the unit tests run it with fake
// channels and timers. App loads it only for a handoff: the small
// `address.ts` opens the tab in the click and reads the id of a new tab.

import { isHandoffId } from "./address";

/** The version of the messages. A message of another version is ignored. */
export const HANDOFF_VERSION = 1;
/** The prefix of the channel name. The one-time id follows it. */
export const CHANNEL_PREFIX = "zipscope-handoff:";
/** The new tab sends `ready` again after this time, until the file comes. */
export const READY_INTERVAL_MS = 250;
/** The new tab waits this long for the file. Then it shows its drop zone. */
export const RECEIVE_MS = 5000;
/** The opener keeps the file this long for the new tab. The new tab must
 *  load and start in this time. */
export const SEND_MS = 20_000;

export type HandoffMessage =
  | { zipscope: "handoff"; version: 1; kind: "ready"; id: string }
  | {
      zipscope: "handoff";
      version: 1;
      kind: "file";
      id: string;
      file: File;
      /** The file handle (Chromium), so that a reload of the new tab can
       *  reopen the file with a permission prompt. */
      handle?: FileSystemFileHandle;
    }
  | { zipscope: "handoff"; version: 1; kind: "ack"; id: string };

/** The parts of a BroadcastChannel that the handoff uses. */
export interface ChannelLike {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export interface HandoffDeps {
  channel: (name: string) => ChannelLike;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const browserDeps: HandoffDeps = {
  channel: (name) => new BroadcastChannel(name),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Returns the message when `data` is a valid handoff message for `id`,
 * else undefined. A message with other fields, another version, another
 * id, a `file` that is not a File, or a `handle` that is not a file
 * handle is not valid.
 */
export function readMessage(data: unknown, id: string): HandoffMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as Record<string, unknown>;
  if (
    message.zipscope !== "handoff" ||
    message.version !== HANDOFF_VERSION ||
    message.id !== id ||
    !isHandoffId(message.id)
  ) {
    return undefined;
  }
  if (message.kind === "ready" || message.kind === "ack") {
    return { zipscope: "handoff", version: 1, kind: message.kind, id };
  }
  if (message.kind === "file" && message.file instanceof File) {
    const handle = message.handle;
    if (handle === undefined) {
      return { zipscope: "handoff", version: 1, kind: "file", id, file: message.file };
    }
    if (typeof FileSystemFileHandle === "function" && handle instanceof FileSystemFileHandle) {
      return { zipscope: "handoff", version: 1, kind: "file", id, file: message.file, handle };
    }
  }
  return undefined;
}

function message(kind: "ready" | "ack", id: string): HandoffMessage {
  return { zipscope: "handoff", version: HANDOFF_VERSION, kind, id };
}

/** A file that the new tab got, with its handle when the opener had one. */
export interface Received {
  file: File;
  handle?: FileSystemFileHandle;
}

/** The result of a handoff for the opener. */
export type SendResult = "acknowledged" | "timeout";

/**
 * Gives `file` to the new tab of the handoff `id`, which the caller opened
 * in the click (`openHandoffTab`). The new tab sends `ready` again until
 * it gets the file, so this channel can open after the tab. Resolves when
 * the new tab acknowledged the file, or when it did not in SEND_MS. Then
 * the opener has no reference to the file.
 */
export function sendToNewTab(
  { file, handle }: Received,
  id: string,
  deps: HandoffDeps = browserDeps,
): Promise<SendResult> {
  const channel = deps.channel(`${CHANNEL_PREFIX}${id}`);
  const { promise, resolve } = Promise.withResolvers<SendResult>();
  let sent = false;
  const end = (result: SendResult) => {
    deps.clearTimeout(timer);
    channel.onmessage = null;
    channel.close();
    resolve(result);
  };
  const timer = deps.setTimeout(() => end("timeout"), SEND_MS);
  channel.onmessage = (event) => {
    const got = readMessage(event.data, id);
    if (got?.kind === "ready" && !sent) {
      sent = true;
      const base = { zipscope: "handoff", version: HANDOFF_VERSION, kind: "file", id, file };
      try {
        channel.postMessage(handle === undefined ? base : { ...base, handle });
      } catch {
        // A browser that cannot send the handle sends the file only.
        channel.postMessage(base);
      }
    } else if (got?.kind === "ack" && sent) {
      end("acknowledged");
    }
  };
  return promise;
}

/**
 * Waits for the file of the handoff `id`. Resolves with the file, or with
 * undefined when it did not come in RECEIVE_MS. It accepts one file only.
 */
export function receiveFromOpener(
  id: string,
  deps: HandoffDeps = browserDeps,
): Promise<Received | undefined> {
  const channel = deps.channel(`${CHANNEL_PREFIX}${id}`);
  const { promise, resolve } = Promise.withResolvers<Received | undefined>();
  const end = (file: Received | undefined) => {
    deps.clearTimeout(timer);
    deps.clearInterval(ready);
    channel.onmessage = null;
    channel.close();
    resolve(file);
  };
  channel.onmessage = (event) => {
    const got = readMessage(event.data, id);
    if (got?.kind === "file") {
      channel.postMessage(message("ack", id));
      end(got.handle === undefined ? { file: got.file } : { file: got.file, handle: got.handle });
    }
  };
  const announce = () => channel.postMessage(message("ready", id));
  const timer = deps.setTimeout(() => end(undefined), RECEIVE_MS);
  const ready = deps.setInterval(announce, READY_INTERVAL_MS);
  announce();
  return promise;
}
