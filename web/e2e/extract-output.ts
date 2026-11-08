// The read worker writes the files, on the handles
// that the pickers give, so a handle must be a real handle that can go to
// a worker (a plain object with methods cannot be cloned). The pickers now
// give handles of the origin private file system, and each worker records
// its writes in place of the stub streams: `createWritable`, `write`,
// `close` and `abort` of the real classes are wrapped in the workers
// (Playwright `worker.evaluate`). The recorded values and the hooks
// (`failWrite`, `holdWrites`, `pendingWrites`, the release) are the same as
// before. The folder picker gives the folder `picked`; Zipscope makes one
// new output folder in it (it never writes into a folder that has files),
// so a recorded path is the path below that output folder. The save picker
// gives files in the folder `saved`.
import type { Page, Worker } from "@playwright/test";

export type OutputRoute = "directory" | "download";
export interface OutputFile {
  path: string;
  bytes: number[];
  byteLength: number;
  maxWrite: number;
  writes: number;
  opens: number;
  closed: boolean;
  aborted: boolean;
}
export interface OutputState {
  saveCalls: number;
  directoryCalls: number;
  files: OutputFile[];
  failWrite: boolean;
  holdWrites: boolean;
  pendingWrites: number;
}

/** The part of the state that a worker records. */
interface WorkerState {
  files: OutputFile[];
  failWrite: boolean;
  holdWrites: boolean;
  pendingWrites: number;
  release?: () => void;
}

/** Wraps the file classes of a worker to record its writes. */
function recordWrites(): void {
  const scope = self as unknown as { __output?: WorkerState };
  if (scope.__output !== undefined || typeof FileSystemWritableFileStream === "undefined") return;
  const state: WorkerState = { files: [], failWrite: false, holdWrites: false, pendingWrites: 0 };
  scope.__output = state;
  const records = new WeakMap<object, OutputFile>();
  const create = FileSystemFileHandle.prototype.createWritable;
  FileSystemFileHandle.prototype.createWritable = async function (options) {
    const root = await navigator.storage.getDirectory();
    const parts = (await root.resolve(this)) ?? [this.name];
    // `picked/<output folder>/…` or `saved/<file>`.
    const path = parts.slice(parts[0] === "picked" ? 2 : 1).join("/");
    let record = state.files.find((candidate) => candidate.path === path);
    if (record === undefined) {
      record = {
        path,
        bytes: [],
        byteLength: 0,
        maxWrite: 0,
        writes: 0,
        opens: 0,
        closed: false,
        aborted: false,
      };
      state.files.push(record);
    }
    record.opens++;
    record.bytes = [];
    record.byteLength = 0;
    const stream = await create.call(this, options);
    records.set(stream, record);
    return stream;
  };
  const proto = FileSystemWritableFileStream.prototype;
  const write = proto.write;
  const close = proto.close;
  const abort = proto.abort;
  proto.write = async function (data) {
    const target = records.get(this);
    if (target !== undefined) {
      target.writes++;
      if (state.failWrite) throw new Error("Test disk is full");
      if (state.holdWrites) {
        state.pendingWrites++;
        await new Promise<void>((resolve) => (state.release = resolve));
        state.pendingWrites--;
      }
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : undefined;
      if (bytes === undefined) throw new Error("Bad write data");
      target.byteLength += bytes.length;
      target.maxWrite = Math.max(target.maxWrite, bytes.length);
      for (const byte of bytes.subarray(0, Math.max(0, 65536 - target.bytes.length))) {
        target.bytes.push(byte);
      }
    }
    return write.call(this, data);
  };
  proto.close = async function () {
    const result = await close.call(this);
    const target = records.get(this);
    if (target !== undefined) target.closed = true;
    return result;
  };
  proto.abort = async function (reason) {
    const target = records.get(this);
    if (target !== undefined) target.aborted = true;
    return abort.call(this, reason);
  };
}

const patch = (worker: Worker) => worker.evaluate(recordWrites).catch(() => {});

/** Records the writes of all workers of the page. Later workers record
 *  from the `worker` event of `outputRoute`. */
export async function recordWorkers(page: Page): Promise<void> {
  await Promise.all(page.workers().map(patch));
}

export async function outputRoute(page: Page, route: OutputRoute): Promise<void> {
  page.on("worker", (worker) => void patch(worker));
  await page.addInitScript((selected) => {
    const state = { saveCalls: 0, directoryCalls: 0 };
    Object.assign(window, { __output: state });
    if (selected === "download") {
      Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
      Object.defineProperty(window, "showDirectoryPicker", {
        configurable: true,
        value: undefined,
      });
      return;
    }
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async (options?: { suggestedName?: string }) => {
        state.saveCalls++;
        const root = await navigator.storage.getDirectory();
        const saved = await root.getDirectoryHandle("saved", { create: true });
        return saved.getFileHandle(options?.suggestedName ?? "entry", { create: true });
      },
    });
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => {
        state.directoryCalls++;
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle("picked", { create: true });
      },
    });
  }, route);
}

/** Sets the hooks in all workers. */
export async function setOutput(
  page: Page,
  values: Partial<Pick<WorkerState, "failWrite" | "holdWrites">>,
): Promise<void> {
  await recordWorkers(page);
  await Promise.all(
    page.workers().map((worker) =>
      worker
        .evaluate((next) => {
          const state = (self as unknown as { __output?: WorkerState }).__output;
          if (state !== undefined) Object.assign(state, next);
        }, values)
        .catch(() => {}),
    ),
  );
}

/** Lets a held write go on. */
export async function releaseWrites(page: Page): Promise<void> {
  await Promise.all(
    page.workers().map((worker) =>
      worker
        .evaluate(() => {
          const state = (self as unknown as { __output?: WorkerState }).__output;
          if (state !== undefined) {
            state.holdWrites = false;
            state.release?.();
          }
        })
        .catch(() => {}),
    ),
  );
}

export async function outputState(page: Page): Promise<OutputState> {
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __output: { saveCalls: number; directoryCalls: number } }).__output,
  );
  const states = await Promise.all(
    page.workers().map((worker) =>
      worker
        .evaluate(() => {
          const state = (self as unknown as { __output?: WorkerState }).__output;
          if (state === undefined) return undefined;
          const { files, failWrite, holdWrites, pendingWrites } = state;
          return { files, failWrite, holdWrites, pendingWrites };
        })
        .catch(() => undefined),
    ),
  );
  const found = states.filter((state) => state !== undefined);
  return {
    saveCalls: calls.saveCalls,
    directoryCalls: calls.directoryCalls,
    files: found.flatMap((state) => state.files),
    failWrite: found.some((state) => state.failWrite),
    holdWrites: found.some((state) => state.holdWrites),
    pendingWrites: found.reduce((sum, state) => sum + state.pendingWrites, 0),
  };
}
