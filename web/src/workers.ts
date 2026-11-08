// The parse worker and the read worker, and their preload.
//
// The front door preloads one parse worker and one read worker in idle
// time. Each worker loads its module and its wasm. The next archive takes
// these workers, so an open after a disconnect does not need the network.
// The preload also loads the chunk of the Archive panel, the chunk of the
// extraction and the lifecycle chunks (the choice for a second file and the
// reload code).
// The browser also keeps the modules and the wasm in its HTTP cache, so a
// later new worker can load them again without the network.
import * as Comlink from "comlink";
import type { ParseWorkerApi, ReadWorkerApi } from "./contracts";
import { loadHandoff, loadOpenChoice, loadRemember } from "./lifecycle/load";
import { loadExtraction } from "./shell/ExtractSlot";
import { loadArchivePanel } from "./shell/panel";

/** A worker and its Comlink proxy. Only one proxy may exist for each
 *  worker: when Comlink collects a proxy, it releases the endpoint, and
 *  the worker then stops to answer. */
export interface Connected<T> {
  worker: Worker;
  api: Comlink.Remote<T>;
}

interface Warm<T> extends Connected<T> {
  /** Resolves with true when the wasm loaded, and with false when the
   *  module or the wasm could not load. */
  ready: Promise<boolean>;
  /** True after the wasm loaded. Only such a worker goes to an archive. */
  loaded: boolean;
}

let parse: Warm<ParseWorkerApi> | undefined;
let read: Warm<ReadWorkerApi> | undefined;

function startParse(): Connected<ParseWorkerApi> {
  const worker = new Worker(new URL("./parse/worker.ts", import.meta.url), { type: "module" });
  return { worker, api: Comlink.wrap<ParseWorkerApi>(worker) };
}

function startRead(): Connected<ReadWorkerApi> {
  const worker = new Worker(new URL("./read/worker.ts", import.meta.url), { type: "module" });
  return { worker, api: Comlink.wrap<ReadWorkerApi>(worker) };
}

/**
 * Starts the wasm load of a worker. When the load fails, `discard` runs at
 * once: the worker stops and is not given to an archive, also while the
 * other preload continues.
 */
function warm<T>(
  connected: Connected<T>,
  call: (api: Comlink.Remote<T>) => Promise<void>,
  discard: (warm: Warm<T>) => void,
): Warm<T> {
  const failed = new Promise<boolean>((resolve) =>
    connected.worker.addEventListener("error", () => resolve(false), { once: true }),
  );
  const loaded = call(connected.api).then(
    () => true,
    () => false,
  );
  const result: Warm<T> = { ...connected, ready: Promise.race([loaded, failed]), loaded: false };
  void result.ready.then((ok) => {
    result.loaded = ok;
    if (!ok) {
      connected.worker.terminate();
      discard(result);
    }
  });
  return result;
}

/** Returns a parse worker: the preloaded one when its wasm loaded, else a
 *  new one. A preload that has not completed can still fail, so its
 *  worker stays for a later archive. */
export function parseWorker(): Connected<ParseWorkerApi> {
  if (parse?.loaded === true) {
    const { worker, api } = parse;
    parse = undefined;
    return { worker, api };
  }
  return startParse();
}

/** Returns a read worker: the preloaded one when its wasm loaded, else a
 *  new one. */
export function readWorker(): Connected<ReadWorkerApi> {
  if (read?.loaded === true) {
    const { worker, api } = read;
    read = undefined;
    return { worker, api };
  }
  return startRead();
}

/** Runs `task` when the browser is idle. */
function whenIdle(task: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(task, { timeout: 2000 });
  } else {
    setTimeout(task, 200);
  }
}

/**
 * Preloads a parse worker and a read worker in idle time, if none waits,
 * and the chunk of the Archive panel. Resolves with true when both workers
 * loaded their wasm and the chunk loaded, and with false when one of them
 * could not load. When `wanted`
 * returns false at idle time, for example because an archive opened, it
 * starts no worker and resolves with false.
 */
export function preload(wanted: () => boolean = () => true): Promise<boolean> {
  return new Promise((resolve) => {
    whenIdle(() => {
      if (!wanted()) {
        resolve(false);
        return;
      }
      // A worker that did not load is discarded at once. The next archive
      // or preload starts a new one.
      const parsing = (parse ??= warm(
        startParse(),
        (api) => api.warm(),
        (failed) => {
          if (parse === failed) parse = undefined;
        },
      ));
      const reading = (read ??= warm(
        startRead(),
        (api) => api.warm(),
        (failed) => {
          if (read === failed) read = undefined;
        },
      ));
      const panel = Promise.all([
        loadArchivePanel(),
        loadExtraction(),
        loadOpenChoice(),
        loadHandoff(),
        loadRemember(),
      ]).then(
        () => true,
        () => false,
      );
      void Promise.all([parsing.ready, reading.ready, panel]).then((done) =>
        resolve(done.every(Boolean)),
      );
    });
  });
}
