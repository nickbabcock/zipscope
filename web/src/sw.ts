// The service worker of the app. It has two jobs.
//
// Streamed downloads: the read worker sends the bytes of an entry, or of
// the zip of a folder, through a MessagePort, and this worker answers a
// navigation to the download URL with a stream of them. Thus a large
// download never sits in memory in a browser without the File System
// Access API. The download route is first in `fetch`, and the download
// response has its own headers (see `downloadHeaders`).
//
// The app shell, in a production build only: the install puts each file
// of the build in the cache of its version (see `shellList` in
// `vite.config.ts`). The page itself comes from the network first, so a
// visit always shows the latest deploy. The cache gives the page when the
// device is offline, or when the network does not answer in
// `NETWORK_WAIT_MS`. The other files have a hash in their names, so
// `fetch` answers them from the caches first. A cached response keeps the
// headers of the server (COOP, COEP and the CSP of `_headers`), so a page
// from the cache is cross-origin isolated too.
//
// Updates: a new version activates as soon as its install puts the shell
// in its cache. A tab of the old version stays open under the new worker:
// the cache of the old version stays (see `removeOldCaches`), so the tab
// can still load the files of its build. This worker never reloads a page.
//
// This file has only type imports and `sw-caches.ts`, which only this
// file imports. Thus it builds to one script, `sw.js` at the root, and
// its scope is the whole app.
/// <reference lib="webworker" />
/// <reference types="vite/client" />
import type { DownloadMessage, DownloadPortMessage, DownloadStartMessage } from "./contracts";
import { ACTIVATED, CACHE_PREFIX, staleCaches } from "./sw-caches";

declare const self: ServiceWorkerGlobalScope;

const DOWNLOAD_PATH = "zipscope-download/";
/** How long the page waits for the network before the cache gives it. */
const NETWORK_WAIT_MS = 3000;
/** How long a download URL waits for its message from the page. */
const WAIT_MS = 10_000;

/** The files of the app shell and their version. */
interface Shell {
  version: string;
  files: string[];
}

/** The build puts the shell in place of this text. The development server
 *  has no shell, so there this worker only streams downloads. */
const shell: Shell | undefined = import.meta.env.PROD
  ? (JSON.parse("__ZIPSCOPE_SHELL__") as Shell)
  : undefined;
const CACHE = `${CACHE_PREFIX}${shell?.version ?? "dev"}`;

interface Pending {
  message: DownloadMessage;
  port: MessagePort;
  /** The port to the UI for the start of the stream. A page of an older
   *  version does not send it. */
  start: MessagePort | undefined;
}

const pending = new Map<string, Pending>();
const waiters = new Map<string, (value: Pending) => void>();

self.addEventListener("install", (event) => {
  // Each version activates when its shell is in the cache. A failed request
  // fails the install, and the browser keeps the old version. `no-cache`
  // asks the server, so a stale copy in the HTTP cache does not go into the
  // cache.
  if (shell === undefined) return;
  const files = shell.files;
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(files.map((file) => new Request(file, { cache: "no-cache" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  if (shell === undefined) return;
  event.waitUntil(removeOldCaches());
});

/**
 * Marks the cache of this version as activated, and removes the caches of
 * the old versions (see `staleCaches`), except the cache of the version
 * that was active before this one. A tab of that version can stay open
 * under this worker (Reload in another tab activates this worker). It can
 * still load its lazy chunks and its workers from that cache, so the page
 * and its workers stay on one build (one `LAYOUT_VERSION`).
 *
 * Limit: a tab that is two or more versions old loses its cache. Its lazy
 * chunks then come from the HTTP cache (the front door preloads them) or
 * from the network, where a newer deploy can have removed them.
 */
async function removeOldCaches(): Promise<void> {
  await (await caches.open(CACHE)).put(ACTIVATED, new Response(""));
  const names: string[] = [];
  const activated = new Set<string>();
  // `keys()` gives the caches in the order that they were made.
  for (const name of await caches.keys()) {
    if (!name.startsWith(CACHE_PREFIX)) continue;
    names.push(name);
    if ((await (await caches.open(name)).match(ACTIVATED)) !== undefined) activated.add(name);
  }
  await Promise.all(staleCaches(names, CACHE, activated).map((name) => caches.delete(name)));
}

self.addEventListener("message", (event) => {
  const data = event.data as { type?: string } | null;
  if (data?.type === "zipscope-download") {
    const message = data as DownloadMessage;
    const [port, start] = event.ports;
    if (port === undefined) return;
    const entry = { message, port, start };
    const waiter = waiters.get(message.id);
    if (waiter !== undefined) {
      waiters.delete(message.id);
      waiter(entry);
    } else {
      pending.set(message.id, entry);
    }
  }
  // Any message (also `zipscope-keepalive`) keeps the worker alive while
  // a download streams.
});

/** Returns the download with `id`, when its message comes in time. */
function take(id: string): Promise<Pending | undefined> {
  const entry = pending.get(id);
  if (entry !== undefined) {
    pending.delete(id);
    return Promise.resolve(entry);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      resolve(undefined);
    }, WAIT_MS);
    waiters.set(id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/** A `filename*` value (RFC 6266 and RFC 8187) and an ASCII fallback. */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The headers of a download. The page is cross-origin isolated, so the
 *  response of a frame in it needs COEP and CORP. */
function downloadHeaders(message: DownloadMessage): Headers {
  const headers = new Headers({
    "Content-Type": message.mime,
    "Content-Disposition": disposition(message.name),
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  if (message.length !== undefined) headers.set("Content-Length", String(message.length));
  return headers;
}

/** A stream that asks the read worker for one chunk on each pull. The first
 *  pull also goes to the UI on `start`: the worker can be busy, and then it
 *  sees its port only after it made a chunk. */
function body(port: MessagePort, start: MessagePort | undefined): ReadableStream<Uint8Array> {
  let answer: ((message: DownloadPortMessage) => void) | undefined;
  const queue: DownloadPortMessage[] = [];
  port.onmessage = (event: MessageEvent<DownloadPortMessage>) => {
    if (answer !== undefined) {
      const resolve = answer;
      answer = undefined;
      resolve(event.data);
    } else {
      queue.push(event.data);
    }
  };
  const next = () =>
    new Promise<DownloadPortMessage>((resolve) => {
      const queued = queue.shift();
      if (queued !== undefined) resolve(queued);
      else answer = resolve;
    });
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        start?.postMessage({ type: "started" } satisfies DownloadStartMessage);
        start?.close();
        start = undefined;
        port.postMessage({ type: "pull" } satisfies DownloadPortMessage);
        const message = await next();
        if (message.type === "chunk") {
          controller.enqueue(message.bytes);
        } else if (message.type === "end") {
          controller.close();
          port.close();
        } else if (message.type === "error") {
          controller.error(new Error(message.message));
          port.close();
        }
      },
      cancel() {
        start?.close();
        port.postMessage({ type: "cancel" } satisfies DownloadPortMessage);
        port.close();
      },
    },
    // One chunk at a time: the read worker decodes the next chunk only
    // when the browser asks for it.
    { highWaterMark: 0 },
  );
}

/** Answers from the cache of this version, then from the caches of old
 *  versions (a lazy chunk of an older tab), then from the network. A cache
 *  has one response for each path, so the match ignores `Vary`. The server
 *  sends `Vary: Origin`, and a module script or a `crossorigin` stylesheet
 *  of the page did not match the request of the install. */
async function cached(key: string | Request, request: Request): Promise<Response> {
  const own = await caches.open(CACHE);
  const options = { ignoreVary: true };
  const hit = (await own.match(key, options)) ?? (await caches.match(key, options));
  return hit ?? fetch(request);
}

/** The page from the network. The cache gives it when the network fails,
 *  or when it does not answer in `NETWORK_WAIT_MS`. A navigation request
 *  cannot take an abort signal, so a late answer is not used. */
async function networkFirst(request: Request): Promise<Response> {
  const network = fetch(request).catch(() => undefined);
  const late = new Promise<undefined>((resolve) => setTimeout(resolve, NETWORK_WAIT_MS));
  const response = await Promise.race([network, late]);
  return response ?? cached("/", request);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const prefix = new URL(DOWNLOAD_PATH, self.registration.scope).pathname;
  if (url.pathname.startsWith(prefix)) {
    const id = url.pathname.slice(prefix.length);
    event.respondWith(
      take(id).then((entry) =>
        entry === undefined
          ? new Response("This download is not available any more.", {
              status: 404,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            })
          : new Response(body(entry.port, entry.start), {
              headers: downloadHeaders(entry.message),
            }),
      ),
    );
    return;
  }
  if (shell === undefined || request.method !== "GET") return;
  if (request.mode === "navigate") {
    // The app has one page. The query (for example the mark of a file
    // launch) does not change it. Other paths go to the network.
    if (url.pathname === "/") event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cached(request, request));
});
