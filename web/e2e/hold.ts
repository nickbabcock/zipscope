// Holds the replies of the workers, so a test can act while a request
// waits.
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Holds the messages from all workers to the page while
 *  `window.holdWorkers` is true. `releaseWorkers()` sends them on. */
export async function holdableWorkers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const held: (() => void)[] = [];
    const sent = new WeakSet<Event>();
    const state = window as unknown as {
      holdWorkers: boolean;
      releaseWorkers: (reverse?: boolean) => void;
      heldWorkers: () => number;
    };
    state.holdWorkers = false;
    state.heldWorkers = () => held.length;
    state.releaseWorkers = (reverse = false) => {
      state.holdWorkers = false;
      const sends = held.splice(0);
      if (reverse) sends.reverse();
      for (const send of sends) send();
    };
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        // This listener is the first one, so it can stop the others.
        this.addEventListener("message", (event) => {
          if (!state.holdWorkers || sent.has(event)) return;
          event.stopImmediatePropagation();
          held.push(() => {
            const again = new MessageEvent("message", {
              data: event.data,
              ports: [...event.ports],
            });
            sent.add(again);
            this.dispatchEvent(again);
          });
        });
      }
    };
  });
}

/** Starts to hold the messages from the workers. */
export async function holdWorkers(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { holdWorkers: boolean }).holdWorkers = true;
  });
}

/** Sends the held messages on, in their order, and stops to hold. With
 *  `reverse`, the last message goes first, so that replies arrive in the
 *  opposite order of the requests. */
export async function releaseWorkers(page: Page, reverse = false): Promise<void> {
  await page.evaluate((last) => {
    (window as unknown as { releaseWorkers: (reverse: boolean) => void }).releaseWorkers(last);
  }, reverse);
}

/** The count of the messages that wait. */
export async function heldWorkers(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { heldWorkers: () => number }).heldWorkers());
}

/** Lets a test hold the folder requests to the workers: the worker does not
 *  list the folder, so its listing does not show, until the release. */
export async function holdableLists(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const held: (() => void)[] = [];
    const state = window as unknown as { holdLists: boolean; releaseLists: () => void };
    state.holdLists = false;
    state.releaseLists = () => {
      state.holdLists = false;
      for (const send of held.splice(0)) send();
    };
    const post = Worker.prototype.postMessage as (...args: unknown[]) => void;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      const path = (args[0] as { path?: string[] } | undefined)?.path;
      if (state.holdLists && path?.[0] === "list") held.push(() => post.apply(this, args));
      else post.apply(this, args);
    };
  });
}

/** Starts to hold the folder requests. */
export async function holdLists(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { holdLists: boolean }).holdLists = true;
  });
}

/** Sends the held folder requests on, in their order, and stops to hold. */
export async function releaseLists(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { releaseLists: () => void }).releaseLists();
  });
}

/** The state of `holdableReads` on the page. */
interface ReadHold {
  /** Slot 0: 1 releases the read. Slot 1: 1 when a read waits. */
  holdCell: Int32Array;
  holdPosts: boolean;
  postHoldCell: () => void;
  releasePosts: () => void;
}

/**
 * Lets a test stop a worker in a read of the file. A read is synchronous, so
 * the worker gets no turn of its event loop while it waits, as in a really
 * slow read.
 *
 * Call it before the page loads. Then `blockReads` starts the hold.
 */
export async function holdableReads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const cell = new SharedArrayBuffer(8);
    const workers = new Set<Worker>();
    const held: (() => void)[] = [];
    const state = window as unknown as ReadHold;
    state.holdCell = new Int32Array(cell);
    state.holdPosts = false;
    const post = Worker.prototype.postMessage as (...args: unknown[]) => void;
    state.postHoldCell = () => {
      for (const worker of workers) post.call(worker, { holdCell: cell });
    };
    state.releasePosts = () => {
      state.holdPosts = false;
      for (const send of held.splice(0)) send();
    };
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      if (state.holdPosts) held.push(() => post.apply(this, args));
      else post.apply(this, args);
    };
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        workers.add(this);
      }
    };
  });
}

/** Runs in a worker: the next read waits for the release. */
function blockNextRead() {
  let cell: Int32Array | undefined;
  self.addEventListener("message", (event: MessageEvent<{ holdCell?: SharedArrayBuffer }>) => {
    if (event.data?.holdCell !== undefined) cell = new Int32Array(event.data.holdCell);
  });
  const scope = self as unknown as {
    FileReaderSync: { prototype: { readAsArrayBuffer(blob: Blob): ArrayBuffer } };
  };
  const reader = scope.FileReaderSync.prototype;
  const read = reader.readAsArrayBuffer;
  reader.readAsArrayBuffer = function (blob: Blob) {
    if (cell !== undefined && Atomics.load(cell, 0) === 0) {
      Atomics.store(cell, 1, 1);
      // The limit only ends a test that failed before its release.
      Atomics.wait(cell, 0, 0, 55_000);
    }
    return read.call(this, blob);
  };
}

/** Starts to hold the next read of the workers whose script URL has `name`.
 *  The worker must exist, and it must not read before the hold starts. */
export async function blockReads(page: Page, name: RegExp): Promise<void> {
  const workers = page.workers().filter((worker) => name.test(worker.url()));
  expect(workers.length).toBeGreaterThan(0);
  await Promise.all(workers.map((worker) => worker.evaluate(blockNextRead)));
  await page.evaluate(() => (window as unknown as ReadHold).postHoldCell());
}

/** Holds the messages to all workers. A new worker then does not start its job,
 *  so `blockReads` can reach it first. */
export async function holdWorkerPosts(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as ReadHold).holdPosts = true;
  });
}

/** Sends the messages to the workers that `holdWorkerPosts` held. */
export async function releaseWorkerPosts(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as ReadHold).releasePosts());
}

/** Waits until a worker waits in its read. */
export async function readIsBlocked(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Atomics.load((window as unknown as ReadHold).holdCell, 1)))
    .toBe(1);
}

/** Lets the read that waits go on. */
export async function releaseReads(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { holdCell } = window as unknown as ReadHold;
    Atomics.store(holdCell, 0, 1);
    Atomics.notify(holdCell, 0);
  });
}

/** An init script: holds back the "finished" reply of the parse worker, so that
 *  the app stays in the parsing state after the last row. */
export function holdFinished(): void {
  const scope = globalThis as unknown as { holdFinished: boolean };
  scope.holdFinished = true;
  const add = Worker.prototype.addEventListener;
  Worker.prototype.addEventListener = function (
    this: Worker,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (type !== "message") {
      return add.call(this, type, listener, options);
    }
    const wrapped = (event: Event) => {
      // A Comlink reply with a parse outcome.
      const kind = (event as MessageEvent).data?.value?.kind;
      if (scope.holdFinished && ["complete", "cancelled", "failed"].includes(kind)) {
        return;
      }
      if (typeof listener === "function") {
        listener.call(this, event);
      } else {
        listener.handleEvent(event);
      }
    };
    return add.call(this, type, wrapped, options);
  };
}
