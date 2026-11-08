// The UI side of a streamed download. The service worker (src/sw.ts)
// answers the download URL with the bytes that the read worker sends
// through a MessagePort. The UI registers the service worker on the first
// streamed download. A production build also registers it after the first
// work of the page (see `App.tsx`).
import { DOWNLOAD_PATH, ExtractProgress } from "../contracts";
import type { DownloadMessage } from "../contracts";

/** How long the UI waits for the service worker to be active. */
const ACTIVE_MS = 10_000;
/** A message in this interval keeps the service worker alive while a
 *  download streams. */
const KEEPALIVE_MS = 10_000;
/** The download frame stays this long after the stream ends, because
 *  some browsers read the response after the frame load. */
const FRAME_MS = 60_000;
/** How long a streamed download can take to ask for its first bytes. */
const START_MS = 10_000;
/** The interval of the checks for the first bytes. */
const START_CHECK_MS = 100;

export interface DownloadWorker {
  worker: ServiceWorker;
  scope: string;
}

/** Waits until `registration` has an active worker. */
function active(registration: ServiceWorkerRegistration): Promise<ServiceWorker | undefined> {
  if (registration.active !== null) return Promise.resolve(registration.active);
  const next = registration.installing ?? registration.waiting;
  if (next === null) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ACTIVE_MS);
    next.addEventListener("statechange", () => {
      if (next.state === "activated") {
        clearTimeout(timer);
        resolve(next);
      } else if (next.state === "redundant") {
        clearTimeout(timer);
        resolve(registration.active ?? undefined);
      }
    });
  });
}

/** Registers the service worker of the app and returns it when it is
 *  active, or undefined when the browser has no service worker for this
 *  page (a private window in some browsers, or a blocked registration). */
export async function downloadWorker(
  nav: Navigator = navigator,
): Promise<DownloadWorker | undefined> {
  const container = (nav as { serviceWorker?: ServiceWorkerContainer }).serviceWorker;
  if (container === undefined) return undefined;
  try {
    // In development, Vite serves the source. Its scope is then `/src/`,
    // and the download URL is below that scope.
    const registration = import.meta.env.DEV
      ? await container.register("/src/sw.ts", { type: "module" })
      : await container.register("/sw.js");
    const worker = await active(registration);
    return worker === undefined ? undefined : { worker, scope: registration.scope };
  } catch {
    return undefined;
  }
}

export interface Download {
  /** The port of the read worker: give it in a `stream` sink. */
  port: MessagePort;
  /** Resolves when the service worker tells that the browser asked for the
   *  first bytes. */
  started: Promise<void>;
  /** Ends the keepalive and removes the frame later. */
  dispose(): void;
}

/** Starts a streamed download of `name` in a hidden frame of `doc`. */
export function startDownload(
  target: DownloadWorker,
  doc: Document,
  message: Omit<DownloadMessage, "type" | "id">,
): Download {
  const id = crypto.randomUUID();
  const channel = new MessageChannel();
  // The start comes on its own port, directly from the service worker. It
  // does not wait for the job, so a slow job is not a stream that did not
  // start.
  const start = new MessageChannel();
  const started = new Promise<void>((resolve) => {
    start.port1.onmessage = () => {
      resolve();
      start.port1.close();
    };
  });
  const full: DownloadMessage = { type: "zipscope-download", id, ...message };
  target.worker.postMessage(full, [channel.port2, start.port2]);
  const frame = doc.createElement("iframe");
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");
  frame.dataset.download = id;
  frame.src = new URL(`${DOWNLOAD_PATH}${id}`, target.scope).href;
  doc.body.append(frame);
  const keepalive = setInterval(
    () => target.worker.postMessage({ type: "zipscope-keepalive" }),
    KEEPALIVE_MS,
  );
  return {
    port: channel.port1,
    started,
    dispose() {
      start.port1.close();
      clearInterval(keepalive);
      setTimeout(() => frame.remove(), FRAME_MS);
    },
  };
}

export interface StartWatch {
  /** True when the browser asked for the first bytes. */
  started(): boolean;
  /** Ends the checks. */
  stop(): void;
}

/**
 * Checks if a stream starts in time. Only a browser that did not ask for the
 * first bytes in `START_MS` goes to `onLimit`. `onLimit` stops the job, so a
 * start after this time does not count.
 *
 * `flags` are the progress flags of the job. Their `STARTED` is a second
 * source of the start: a service worker of an older version can answer a page
 * of this version, and it does not use the start port.
 */
export function watchStart(
  download: Pick<Download, "started">,
  flags: Int32Array,
  onStart: () => void,
  onLimit: () => void,
): StartWatch {
  const flagged = () => Atomics.load(flags, ExtractProgress.STARTED) !== 0;
  let told = false;
  let late = false;
  let ended = false;
  const stop = () => {
    ended = true;
    clearInterval(timer);
  };
  const begin = () => {
    if (ended) return;
    stop();
    onStart();
  };
  let waited = 0;
  const timer = setInterval(() => {
    waited += START_CHECK_MS;
    if (flagged()) {
      begin();
    } else if (waited >= START_MS) {
      stop();
      late = true;
      onLimit();
    }
  }, START_CHECK_MS);
  void download.started.then(() => {
    told = true;
    begin();
  });
  return { started: () => !late && (told || flagged()), stop };
}
