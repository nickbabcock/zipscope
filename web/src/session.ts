// One open archive: its parse worker, the Comlink channel and the mirrors.
import * as Comlink from "comlink";
import { HARD_BUDGET_BYTES, SOFT_BUDGET_BYTES } from "./contracts";
import type {
  HealthReport,
  MemoryBudget,
  MemoryUsage,
  MirrorSink,
  OpenInfo,
  OpenOptions,
  ParseOutcome,
  ParseWorkerApi,
  RefusedView,
  SortColumn,
} from "./contracts";

/** The view requests of the parse worker. */
type ViewKind = "list" | "expand" | "expandInline" | "sort" | "search";
import { ReadClient } from "./read/client";
import type { ArchiveInfo } from "./shell/archive";
import { MirrorReader } from "./store/reader";
import { parseWorker } from "./workers";

/** Only for tests: the e2e tests set this global before the page loads to
 *  use a small memory budget. The app never sets it. */
function testOptions(): OpenOptions | undefined {
  const test = globalThis as {
    __zipscopeTestBudget?: MemoryBudget;
    __zipscopeTestRefuseViews?: boolean | RefusedView;
  };
  const budget = test.__zipscopeTestBudget;
  const refuseViews = test.__zipscopeTestRefuseViews ?? false;
  if (budget === undefined && refuseViews === false) return undefined;
  return {
    ...(budget === undefined ? {} : { budget }),
    ...(refuseViews === false ? {} : { refuseViews }),
  };
}

/**
 * The longest time that `close` waits for a job that writes files (an
 * extraction or a zstd copy) to stop after its cancel. The job then aborts
 * its output itself: a writable of a picker keeps the old content of the
 * file, and a file that the job made in a folder goes. After this time,
 * the workers stop anyway. A writable that does not close does not change
 * the file, so a user file is never removed or truncated.
 */
export const JOB_STOP_MS = 5000;
// After this time, up to 8 files that a folder job made can stay as empty
// files, one for each row in flight: the job removes such a file only when
// it settles. A file of a picker keeps its old content.

/** A job that writes files: an extraction or a zstd copy. */
export interface Job {
  /** Sets the cancel flag of the job. */
  cancel(): void;
  /** Settles when the job stopped and aborted its output. */
  settled: Promise<unknown>;
}

/** The memory-budget prompt while the worker waits for the answer. */
export interface MemoryPrompt {
  usage: MemoryUsage;
  answer(proceed: boolean): void;
}

export class ArchiveSession {
  /** A new id for each session. History entries name their session. */
  readonly id = crypto.randomUUID();
  /** The file name, the file size and the demo flag. */
  readonly info: ArchiveInfo;
  /** The file. The Archive panel reads its bytes for the hex view and
   *  saves parts of it. */
  readonly file: File;
  readonly reader = new MirrorReader();
  readonly opened: Promise<OpenInfo>;
  readonly finished: Promise<ParseOutcome>;
  /** The read worker. It starts on the first preview. */
  readonly read: ReadClient;
  /** The hard stop of the memory budget. */
  readonly hard: number;
  /** The first memory limit: the soft budget, or the hard stop when a
   *  test sets it lower. */
  readonly budget: number;
  /** Called when the memory of the write workers changes. */
  onWriteMemory: (() => void) | undefined;
  /** The write workers of a zstd copy in progress. */
  private remux: { stop(): void; memoryBytes(): number } | undefined;
  /** The jobs that write files. */
  private readonly jobs = new Set<Job>();
  /** True after `close`. */
  private closed = false;
  /** Called when a view request settles. The worker published the views
   *  before it answers, so the screen can draw them. */
  onPublished: (() => void) | undefined;
  /** Called when a view request starts, and when the memory limit refused
   *  one (with its kind). */
  onViewRequest: ((refused?: RefusedView) => void) | undefined;
  private readonly worker: Worker;
  private readonly api: Comlink.Remote<ParseWorkerApi>;
  private ended = false;
  private prompt: MemoryPrompt | undefined;
  private promptListener: ((prompt: MemoryPrompt | undefined) => void) | undefined;
  /** The searches and sorts in progress. */
  private busy = 0;
  private busyListener: ((count: number, searching: boolean) => void) | undefined;

  /**
   * Opens `file`. `demo` is true for the demo archive. With `after`, the
   * parse starts only when `after` settles: App gives the close of an
   * archive whose job wrote files, so that the old read and write workers
   * stop before the new parse grows (at most `JOB_STOP_MS`). The UI of the
   * new archive shows at once, with the opening state.
   */
  constructor(file: File, demo = false, after?: Promise<unknown>) {
    this.info = { name: file.name, bytes: file.size, demo };
    this.hard = testOptions()?.budget?.hard ?? HARD_BUDGET_BYTES;
    this.budget = Math.min(testOptions()?.budget?.soft ?? SOFT_BUDGET_BYTES, this.hard);
    this.file = file;
    const { worker, api } = parseWorker();
    this.worker = worker;
    this.api = api;
    const sink: MirrorSink = {
      mirror: (mirror) => {
        this.reader.receive(mirror);
        if (mirror.kind === "page") this.read.page(mirror.index, mirror.buffer);
        if (mirror.kind === "nameChunk") this.read.names(mirror.index, mirror.buffer);
      },
      confirmMemory: (usage) => this.ask(usage),
    };
    const start = () => {
      if (this.closed) return Promise.reject(new Error("The archive is closed"));
      return api.open(file, Comlink.proxy(sink), testOptions());
    };
    if (after !== undefined) {
      this.waiting = after;
      const clear = () => {
        this.waiting = undefined;
      };
      void after.then(clear, clear);
    }
    const opening = after === undefined ? start() : after.then(start, start);
    this.opened = opening.then((info) => {
      this.reader.attach(info.header);
      return info;
    });
    this.opened.catch(() => this.reader.openFailed());
    const header = this.opened.then((info) => info.header);
    // A preview cannot start before the open; its own call reports this.
    header.catch(() => {});
    this.read = new ReadClient(file, header, testOptions());
    this.finished = api.finished().then((outcome) => {
      this.ended = true;
      this.prompt?.answer(false);
      return outcome;
    });
  }

  /** The query that waits for the search in progress. */
  private nextQuery: string | undefined;
  private searching: Promise<void> | undefined;
  /** The query of the last search that the worker published. */
  private published = "";

  /** The query of the listing that shows: of the last search that the
   *  worker published, or "" before the first search. */
  shownQuery(): string {
    return this.published;
  }

  /** Lists a folder. Resolves when the views are published. */
  list(folder: number): Promise<void> {
    return this.timed("list", this.api.list(folder));
  }

  /** Expands or collapses a tree row. Resolves when the views are
   *  published. */
  expand(folder: number, open: boolean): Promise<void> {
    return this.timed("expand", this.api.expand(folder, open));
  }

  /** Returns the folder that lists a row, or the folder of an explicit
   *  row with FOLDER_TAG. */
  entryFolder(row: number): Promise<number> {
    return this.api.entryFolder(row);
  }

  /** Opens or closes a table row in place. With `deep`, all folders
   *  below it change too. Resolves when the views are published. */
  expandInline(folder: number, open: boolean, deep: boolean): Promise<void> {
    return this.timed("expandInline", this.api.expandInline(folder, open, deep));
  }

  /** Sorts the listing. Resolves when the sorted listing is published. */
  sort(column: SortColumn, descending: boolean): Promise<void> {
    return this.counted(this.timed("sort", this.api.sort(column, descending)));
  }

  /** Ends a listing that is still in steps after the parse, if any. It is
   *  one more sort for the status text. */
  settleListing(): Promise<void> {
    return this.counted(this.timed("sort", this.api.settleListing()));
  }

  /** Resolves when the job of the tree order ended. After the parse no frame
   *  runs, so this draws one for the tree that the job published. It is no
   *  view request and no sort: no status text shows for it. */
  settleTreeOrder(): Promise<void> {
    return this.api.settleTreeOrder().then(() => this.onPublished?.());
  }

  /**
   * Searches the names. While a search runs, only the last new query
   * waits, so fast typing does not queue a search for each key. Resolves
   * when the results of the last query are published.
   */
  search(query: string): Promise<void> {
    this.nextQuery = query;
    this.searching ??= (async () => {
      try {
        while (this.nextQuery !== undefined) {
          const next = this.nextQuery;
          this.nextQuery = undefined;
          await this.timed("search", this.api.search(next));
          this.published = next;
        }
      } finally {
        this.searching = undefined;
      }
    })();
    return this.counted(this.searching);
  }

  /** True when no search or sort is in progress. */
  idle(): boolean {
    return this.busy === 0;
  }

  /** Calls `listener` with the count of the searches and sorts in
   *  progress, and true when a search is one of them: at once, and after
   *  each change. */
  onBusy(listener: (count: number, searching: boolean) => void): () => void {
    this.busyListener = listener;
    listener(this.busy, this.searching !== undefined);
    return () => {
      if (this.busyListener === listener) this.busyListener = undefined;
    };
  }

  /** Counts a search or a sort until it settles. */
  private counted(request: Promise<void>): Promise<void> {
    const change = (step: number) => {
      this.busy += step;
      this.busyListener?.(this.busy, this.searching !== undefined);
    };
    change(1);
    request.then(
      () => change(-1),
      () => change(-1),
    );
    return request;
  }

  /** Calls `listener` with the memory-budget prompt when the worker asks,
   *  and with undefined when it is answered. A prompt that came before
   *  goes to the listener at once. */
  onPrompt(listener: (prompt: MemoryPrompt | undefined) => void): () => void {
    this.promptListener = listener;
    listener(this.prompt);
    return () => {
      if (this.promptListener === listener) this.promptListener = undefined;
    };
  }

  private ask(usage: MemoryUsage): Promise<boolean> {
    if (this.ended) return Promise.resolve(false);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this.prompt = {
      usage,
      answer: (proceed) => {
        if (this.prompt?.usage === usage) {
          this.prompt = undefined;
          this.promptListener?.(undefined);
          resolve(proceed);
        }
      },
    };
    this.promptListener?.(this.prompt);
    return promise;
  }

  /** Returns the health report. */
  health(): Promise<HealthReport> {
    return this.api.health();
  }

  /** Requests the worker to stop at its next batch. The worker also sees
   *  the flag while the memory-budget prompt waits. */
  cancel(): void {
    this.reader.cancel();
    this.prompt?.answer(false);
  }

  /** Keeps a job that writes files, so that `close` cancels it and waits
   *  for it. Returns the function that forgets it when the job ends. */
  trackJob(job: Job): () => void {
    this.jobs.add(job);
    return () => this.jobs.delete(job);
  }

  /** True while a job writes files. */
  writing(): boolean {
    return this.jobs.size > 0;
  }

  /** Keeps the write workers of a zstd copy, so that `close` stops them,
   *  and the copy as a job. Returns the function that forgets them when
   *  the copy ends. */
  trackRemux(
    run: { stop(): void; memoryBytes(): number; report: Promise<unknown> },
    cancel: () => void,
  ): () => void {
    this.remux = run;
    const forget = this.trackJob({ cancel, settled: run.report });
    return () => {
      forget();
      if (this.remux === run) this.remux = undefined;
      this.onWriteMemory?.();
    };
  }

  /** The memory of the write workers. */
  writeBytes(): number {
    return this.remux?.memoryBytes() ?? 0;
  }

  /**
   * Closes the archive: the archive is replaced, or its owner goes. The
   * parse worker stops at once. A job that writes files gets its cancel,
   * and its workers stop when it aborted its output, or after
   * `JOB_STOP_MS`. The read worker and the write workers then stop. Each
   * wasm instance goes with its worker, so all the memory of the archive
   * goes back to the browser. Resolves when all workers stopped.
   *
   * Until then (at most `JOB_STOP_MS`), the old read and write workers can
   * hold memory that the budget of the next archive does not count. Thus
   * App starts the parse of the next archive after this promise when a job
   * wrote files (`closeForNext`).
   */
  close(): Promise<void> {
    if (this.closed) return this.stopped;
    this.closed = true;
    this.ended = true;
    this.cancel();
    this.worker.terminate();
    const jobs = [...this.jobs];
    for (const job of jobs) job.cancel();
    const stop = () => {
      this.read.close();
      this.remux?.stop();
    };
    if (jobs.length === 0) {
      stop();
      return this.stopped;
    }
    // No new read call starts while the jobs stop.
    this.read.refuse();
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, JOB_STOP_MS);
    void Promise.allSettled(jobs.map((job) => job.settled)).then(() => {
      clearTimeout(timer);
      resolve();
    });
    this.stopped = promise.then(stop);
    return this.stopped;
  }

  /** Resolves when `close` stopped all workers. */
  private stopped: Promise<void> = Promise.resolve();

  /** The `after` of the constructor until it settles: the workers of the
   *  archives before this one that can still hold memory. */
  private waiting: Promise<unknown> | undefined;

  /**
   * Closes the archive because the next archive replaces it. Returns the
   * promise that the parse of the next archive waits for (`after` of the
   * constructor), or undefined when no old worker can hold memory. The
   * promise includes the close when a job wrote files, and the wait of
   * this archive for the archives before it. Thus a third archive also
   * waits for the workers of the first archive (A to B to C during a job
   * of A).
   */
  closeForNext(): Promise<unknown> | undefined {
    const writing = this.writing();
    const closing = this.close();
    const waits = [writing ? closing : undefined, this.waiting].filter(
      (wait) => wait !== undefined,
    );
    return waits.length === 0 ? undefined : Promise.allSettled(waits);
  }

  /** Records the time of a view request as a `zipscope:view-request`
   *  measure, which the benchmarks read, and calls `onPublished` when the
   *  request settles. */
  private timed(kind: ViewKind, request: Promise<void>): Promise<void> {
    const start = performance.now();
    this.onViewRequest?.();
    request.catch((error: unknown) => {
      // Comlink keeps the name of the error.
      if (error instanceof Error && error.name === "MemoryLimitError") {
        this.onViewRequest?.(kind === "sort" || kind === "search" ? kind : "folder");
      }
    });
    const measured = request.then((value) => {
      performance.measure("zipscope:view-request", { start, detail: kind });
      return value;
    });
    const published = () => this.onPublished?.();
    measured.then(published, published);
    return measured;
  }
}
