// A vitest fixture that opens an archive with the real parse worker, the
// real read worker and their wasm, as the app does in a browser. It does the
// setup of the `*-wasm.test.ts` files: a stub `FileReaderSync`, a mock of
// Comlink that catches `expose`, and an import of each worker module.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { test as base, vi } from "vitest";
import type { Mock } from "vitest";
import type {
  ExtractSink,
  MemoryBudget,
  Mirror,
  ParseOutcome,
  ParseWorkerApi,
  ReadWorkerApi,
} from "../src/contracts";
import { BytesFile } from "../src/read/wasm-harness";
import { MirrorReader } from "../src/store/reader";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));

/** The mock of `Comlink.expose`, for the harness of the write workers. */
export const expose: Mock = mocks.expose;

/** A part of a file on the disk. A read gets only the bytes of the part,
 *  so a sparse file of more than 4 GiB does not go into memory. The stub
 *  `FileReaderSync` reads `bytes`, as for `BytesFile`. */
export class DiskFile {
  constructor(
    readonly path: string,
    readonly start = 0,
    readonly end = statSync(path).size,
  ) {}

  get size(): number {
    return this.end - this.start;
  }

  slice(start = 0, end = this.size): DiskFile {
    const clamp = (value: number) =>
      Math.min(Math.max(value < 0 ? this.size + value : value, 0), this.size);
    return new DiskFile(
      this.path,
      this.start + clamp(start),
      this.start + Math.max(clamp(start), clamp(end)),
    );
  }

  get bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    const fd = openSync(this.path, "r");
    try {
      for (let done = 0, read = -1; done < out.length && read !== 0; done += read) {
        read = readSync(fd, out, done, out.length - done, this.start + done);
      }
    } finally {
      closeSync(fd);
    }
    return out;
  }
}

/** An archive after the end of its parse and of its listing. The read
 *  worker has the file, the mirrors and the names, as in the app. */
export interface Archive {
  file: File;
  /** Undefined when the open failed, as `read`. */
  header: SharedArrayBuffer | undefined;
  outcome: ParseOutcome;
  /** The rows that the listing shows. */
  rows: number;
  /** The name of each row, in archive order. */
  names: string[];
  reader: MirrorReader;
  parse: ParseWorkerApi;
  read: ReadWorkerApi | undefined;
}

/** Opens bytes (with the name `archive.zip`, or `options.name`) or the
 *  file at a path. `options.budget` is a memory budget, as the page tests
 *  set it. */
type Open = (
  source: Uint8Array | string,
  options?: { name?: string; budget?: MemoryBudget },
) => Promise<Archive>;

/** Imports a worker module again and returns the API that it exposes. */
async function exposed<T>(path: string): Promise<T> {
  await import(/* @vite-ignore */ path);
  return mocks.expose.mock.calls.at(-1)![0] as T;
}

/** The test of this folder, with the fixture `open`. The stub of
 *  `FileReaderSync` lasts for the test. */
// oxlint-disable-next-line no-empty-pattern -- vitest reads the fixtures that a fixture needs from this pattern.
export const test = base.extend("open", async ({}, { onCleanup }): Promise<Open> => {
  vi.stubGlobal(
    "FileReaderSync",
    class {
      readAsArrayBuffer(file: { bytes: Uint8Array }) {
        return file.bytes.slice().buffer;
      }
    },
  );
  onCleanup(() => {
    vi.unstubAllGlobals();
  });
  return async (source, options = {}) => {
    // New worker modules for each archive, as a new worker in the app.
    vi.resetModules();
    // A copy in a plain Uint8Array: the `slice` of a Node Buffer makes no
    // copy, so the stub reader would read the whole pool of the Buffer.
    const stub =
      typeof source === "string" ? new DiskFile(source) : new BytesFile(new Uint8Array(source));
    // The name of an output folder and of a zstd copy come from it.
    const name = options.name ?? (typeof source === "string" ? basename(source) : "archive.zip");
    const file = Object.assign(stub, { name }) as unknown as File;
    const budget = options.budget === undefined ? undefined : { budget: options.budget };
    const reader = new MirrorReader();
    const pages: SharedArrayBuffer[] = [];
    const names: SharedArrayBuffer[] = [];
    // Paths in variables, so that the type check does not follow the
    // worker modules (they have their own project).
    const parsePath = "../src/parse/worker";
    const readPath = "../src/read/worker";
    const parse = await exposed<ParseWorkerApi>(parsePath);
    const sink = {
      mirror: (mirror: Mirror) => {
        reader.receive(mirror);
        if (mirror.kind === "page") pages[mirror.index] = mirror.buffer;
        if (mirror.kind === "nameChunk") names[mirror.index] = mirror.buffer;
      },
    };
    const opened = await parse.open(file, sink, budget).catch(() => undefined);
    const outcome = await parse.finished();
    if (opened === undefined) {
      reader.openFailed();
      return {
        file,
        header: undefined,
        outcome,
        rows: 0,
        names: [],
        reader,
        parse,
        read: undefined,
      };
    }
    reader.attach(opened.header);
    await parse.settleListing();
    await parse.settleTreeOrder();
    const read = await exposed<ReadWorkerApi>(readPath);
    await read.open(file, opened.header, pages, budget);
    for (const [index, chunk] of names.entries()) await read.names(index, chunk);
    const rows = reader.visibleRows();
    const header = opened.header;
    const rowNames = Array.from({ length: rows }, (_, row) => reader.name(row));
    return { file, header, outcome, rows, names: rowNames, reader, parse, read };
  };
});

/** One file that an extraction made. */
export interface OutputFile {
  /** The path below the folder of the picker. */
  path: string;
  bytes: Uint8Array;
  /** The count of `createWritable` calls. */
  opens: number;
  closed: boolean;
  aborted: boolean;
  removed: boolean;
}

const notFound = () => new DOMException("Not found", "NotFoundError");

/**
 * A folder of the folder picker and a file of the save picker, as plain
 * objects. They record each file that a job makes, also when the job aborts
 * or removes it. `failWrite` makes each write fail, as a full disk.
 */
export function outputFolder(options: { failWrite?: boolean } = {}) {
  const files: OutputFile[] = [];
  const fileHandle = (path: string) => ({
    kind: "file",
    name: path.split("/").at(-1)!,
    async createWritable() {
      let target = files.find((file) => file.path === path && !file.removed);
      if (target === undefined) {
        target = {
          path,
          bytes: new Uint8Array(0),
          opens: 0,
          closed: false,
          aborted: false,
          removed: false,
        };
        files.push(target);
      }
      const record = target;
      record.opens++;
      record.bytes = new Uint8Array(0);
      return {
        async write(bytes: Uint8Array) {
          if (options.failWrite === true) throw new Error("Test disk is full");
          const next = new Uint8Array(record.bytes.length + bytes.length);
          next.set(record.bytes);
          next.set(bytes, record.bytes.length);
          record.bytes = next;
        },
        async close() {
          record.closed = true;
        },
        async abort() {
          record.aborted = true;
        },
      };
    },
  });
  const folders = new Map<string, unknown>();
  const folder = (path: string): unknown => {
    // One name is a file or a folder, as in a file system.
    const children = new Map<string, "file" | "directory">();
    const join = (name: string) => (path === "" ? name : `${path}/${name}`);
    const child = (name: string, kind: "file" | "directory", create = false) => {
      const found = children.get(name);
      if (found === undefined && !create) throw notFound();
      if (found !== undefined && found !== kind) {
        throw new DOMException("The name is used", "TypeMismatchError");
      }
      children.set(name, kind);
    };
    return {
      kind: "directory",
      name: path.split("/").at(-1) ?? "",
      async getDirectoryHandle(name: string, open?: { create?: boolean }) {
        child(name, "directory", open?.create);
        if (!folders.has(join(name))) folders.set(join(name), folder(join(name)));
        return folders.get(join(name));
      },
      async getFileHandle(name: string, open?: { create?: boolean }) {
        child(name, "file", open?.create);
        return fileHandle(join(name));
      },
      async removeEntry(name: string) {
        children.delete(name);
        for (const file of files) if (file.path === join(name)) file.removed = true;
      },
    };
  };
  const root = folder("") as FileSystemDirectoryHandle;
  return {
    files,
    directory: (name: string): ExtractSink => ({ kind: "directory", handle: root, name }),
    file: (name: string): ExtractSink => ({
      kind: "file",
      handle: fileHandle(name) as unknown as FileSystemFileHandle,
    }),
  };
}
