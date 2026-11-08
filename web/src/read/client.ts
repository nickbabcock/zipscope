// The UI side of the read worker. The worker starts on the first request,
// so the read wasm loads only when the user previews an entry, or when the
// front door preloaded it.
import * as Comlink from "comlink";
import type {
  ArchiveFacts,
  ArchiveLayout,
  ArchiveTotals,
  ExtractPlanInfo,
  ExtractReport,
  ExtractSink,
  ExtractTarget,
  OpenOptions,
  ReadChunk,
  ReadWorkerApi,
} from "../contracts";
import { readWorker } from "../workers";

export class ReadClient {
  private worker: Worker | undefined;
  private api: Comlink.Remote<ReadWorkerApi> | undefined;
  private opened: Promise<void> | undefined;
  private readonly pages: SharedArrayBuffer[] = [];
  private readonly nameChunks: SharedArrayBuffer[] = [];
  private closed = false;
  /** Called when the read worker memory in `READ_KIB` can have changed:
   *  after each read, and when the pass over the central directory stops.
   *  The frame loop can be stopped, so the status bar needs this. */
  onMemory: (() => void) | undefined;

  constructor(
    private readonly file: File,
    /** Resolves with the header of the parse worker. */
    private readonly header: Promise<SharedArrayBuffer>,
    /** The options of the parse worker (only for tests). */
    private readonly options?: OpenOptions,
  ) {}

  /** Takes a column page from the parse worker. */
  page(index: number, buffer: SharedArrayBuffer): void {
    this.pages[index] = buffer;
    if (this.api !== undefined) {
      void this.api.page(index, buffer);
    }
  }

  /** Takes a chunk of the name arena from the parse worker. */
  names(index: number, buffer: SharedArrayBuffer): void {
    this.nameChunks[index] = buffer;
    if (this.api !== undefined) {
      void this.api.names(index, buffer);
    }
  }

  /** True after the first request started the worker. */
  started(): boolean {
    return this.worker !== undefined;
  }

  private start(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("The archive is closed"));
    }
    if (this.opened === undefined) {
      const { worker, api } = readWorker();
      this.worker = worker;
      this.opened = this.header.then((header) => {
        // Pages that arrive from now on go to the worker at once.
        this.api = api;
        const opened = api.open(this.file, header, [...this.pages], this.options);
        // The names go after the open, in order, before any later call.
        this.nameChunks.forEach((buffer, index) => {
          if (buffer !== undefined) void api.names(index, buffer);
        });
        return opened;
      });
    }
    return this.opened;
  }

  /** Decodes up to `bytes` bytes of a row from `offset`. */
  async read(row: number, offset: number, bytes: number): Promise<ReadChunk> {
    await this.start();
    const api = this.api!;
    try {
      return await api.read(row, offset, bytes);
    } finally {
      this.onMemory?.();
      api.settled().then(
        () => this.onMemory?.(),
        () => {},
      );
    }
  }

  private factsCall: Promise<ArchiveFacts> | undefined;
  private layoutCall: Promise<ArchiveLayout> | undefined;
  private totalsCall: Promise<ArchiveTotals> | undefined;

  /** Reads the records at the end of the archive. The answer is kept. */
  facts(): Promise<ArchiveFacts> {
    this.factsCall ??= this.start().then(async () => {
      try {
        return await this.api!.facts();
      } finally {
        this.onMemory?.();
      }
    });
    return this.factsCall;
  }

  /** Counts the totals, with no byte map. Call it after parsing ended. The
   *  answer is kept. */
  totals(): Promise<ArchiveTotals> {
    this.totalsCall ??= this.start().then(async () => {
      try {
        return await this.api!.totals();
      } finally {
        this.onMemory?.();
      }
    });
    // A call that fails can be tried again.
    this.totalsCall.catch(() => (this.totalsCall = undefined));
    return this.totalsCall;
  }

  /** Maps the bytes of the file and counts the totals. Call it after
   *  parsing ended. The answer is kept. */
  layout(): Promise<ArchiveLayout> {
    this.layoutCall ??= this.start().then(async () => {
      try {
        return await this.api!.layout();
      } finally {
        this.onMemory?.();
      }
    });
    // A call that fails can be tried again.
    this.layoutCall.catch(() => (this.layoutCall = undefined));
    return this.layoutCall;
  }

  /** Makes the plan of an extraction. */
  async plan(target: ExtractTarget): Promise<ExtractPlanInfo> {
    await this.start();
    try {
      return await this.api!.plan(target);
    } finally {
      this.onMemory?.();
    }
  }

  /** Writes a plan to a sink. The port of a stream sink is transferred. */
  async extract(
    plan: number,
    sink: ExtractSink,
    progress: SharedArrayBuffer,
  ): Promise<ExtractReport> {
    await this.start();
    const transfer = sink.kind === "stream" ? [sink.port] : [];
    try {
      return await this.api!.extract(plan, Comlink.transfer(sink, transfer), progress);
    } finally {
      this.onMemory?.();
    }
  }

  /** Frees a plan that the user did not extract. */
  dropPlan(plan: number): void {
    void this.api?.dropPlan(plan).catch(() => {});
  }

  /** Refuses new calls. The calls in progress continue until `close`. */
  refuse(): void {
    this.closed = true;
  }

  /** Stops the worker. This frees all its memory. */
  close(): void {
    this.closed = true;
    this.worker?.terminate();
  }
}
