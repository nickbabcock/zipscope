// The folder sink of the extraction with the real read wasm: a
// name collision that the plan does not see
// gives a failed row, never a replaced or removed file; and a plan whose
// items fail is freed. Its own file gives it a new wasm instance.
import { afterEach, expect, test, vi } from "vitest";
import { ExtractSkip, PROGRESS_BYTES, State } from "../contracts";
import { encoder, giveNames, header, openWorker, zip } from "./wasm-harness";
import type { Entry } from "./wasm-harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const notFound = () => new DOMException("Not found", "NotFoundError");

/** A folder of a file system that joins names by `key`, as a file system
 *  that ignores a difference that the plan sees. */
class FakeFolder {
  readonly files = new Map<string, { name: string; text: string }>();
  readonly folders = new Map<string, FakeFolder>();
  readonly removed: string[] = [];
  /** `lock.busy` is the number of removals that fail as the lock of an
   *  aborted writable in Chromium. All folders share it. */
  constructor(
    private readonly key: (name: string) => string,
    private readonly lock = { busy: 0 },
  ) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const key = this.key(name);
    let folder = this.folders.get(key);
    if (folder === undefined) {
      if (options?.create !== true) throw notFound();
      folder = new FakeFolder(this.key, this.lock);
      this.folders.set(key, folder);
    }
    return folder;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const key = this.key(name);
    let file = this.files.get(key);
    if (file === undefined) {
      if (options?.create !== true) throw notFound();
      file = { name, text: "" };
      this.files.set(key, file);
    }
    const target = file;
    return {
      async createWritable() {
        const parts: Uint8Array[] = [];
        return {
          async write(bytes: Uint8Array) {
            parts.push(bytes.slice());
          },
          async close() {
            target.text = new TextDecoder().decode(
              new Uint8Array(parts.flatMap((part) => [...part])),
            );
          },
          async abort() {},
        };
      },
    };
  }

  async removeEntry(name: string) {
    if (this.lock.busy > 0) {
      this.lock.busy--;
      throw new DOMException("The file is locked", "NoModificationAllowedError");
    }
    this.removed.push(name);
    this.files.delete(this.key(name));
  }
}

const entry = (name: string, text: string): Entry => ({ name, body: encoder.encode(text) });

test("a collision that the plan does not see fails the row and keeps the first file", async () => {
  const entries = [entry("f/x1.txt", "one"), entry("f/x2.txt", "two"), entry("f/y.txt", "why")];
  const { bytes, pages } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 3), pages);
  await giveNames(
    api,
    pages,
    entries.map((item) => item.name),
  );
  // This file system joins all digits, so x1.txt and x2.txt are one file.
  const root = new FakeFolder((name) => name.replace(/[0-9]/g, "#"));
  const plan = await api.plan({ kind: "folder", path: "f/" });
  const report = await api.extract(
    plan.id,
    { kind: "directory", handle: root as unknown as FileSystemDirectoryHandle, name: "f" },
    new SharedArrayBuffer(PROGRESS_BYTES),
  );
  const output = root.folders.get("f")!;
  expect([...output.files.values()]).toEqual([
    { name: "x1.txt", text: "one" },
    { name: "y.txt", text: "why" },
  ]);
  expect(output.removed).toEqual([]);
  expect(report.written).toBe(2);
  expect(report.items).toEqual([
    {
      row: 1,
      name: "f/x2.txt",
      path: "x2.txt",
      skip: ExtractSkip.WRITE,
      detail: "A file with the same name was written before (a name collision)",
    },
  ]);
}, 60_000);

test("a plan whose items fail is freed", async () => {
  const entries = [entry("f/CON", "device"), entry("f/a", "a")];
  const { bytes, pages } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 2), pages);
  await giveNames(
    api,
    pages,
    entries.map((item) => item.name),
  );
  // The worker module and this import share one wasm module after the
  // reset in `openWorker`.
  const wasm = await import("../wasm/zipscope_read.js");
  vi.spyOn(wasm.ExtractPlan.prototype, "fileName").mockImplementation(() => {
    throw new Error("The memory limit leaves no room for this step");
  });
  const free = vi.spyOn(wasm.ExtractPlan.prototype, "free");
  await expect(api.plan({ kind: "folder", path: "f/" })).rejects.toThrow("memory limit");
  expect(free).toHaveBeenCalledTimes(1);
}, 60_000);

test("a folder collision that the plan does not see fails the folder, not its files' paths", async () => {
  const entries = [entry("f/d1/a.txt", "one"), entry("f/d2/b.txt", "two")];
  const { bytes, pages } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 2), pages);
  await giveNames(
    api,
    pages,
    entries.map((item) => item.name),
  );
  // This file system joins all digits, so the folders d1 and d2 are one.
  const root = new FakeFolder((name) => name.replace(/[0-9]/g, "#"));
  const plan = await api.plan({ kind: "folder", path: "f/" });
  const report = await api.extract(
    plan.id,
    { kind: "directory", handle: root as unknown as FileSystemDirectoryHandle, name: "f" },
    new SharedArrayBuffer(PROGRESS_BYTES),
  );
  const output = root.folders.get("f")!;
  // The second folder is not joined into the first: d1 has only a.txt.
  expect([...output.folders.get("d#")!.files.values()]).toEqual([{ name: "a.txt", text: "one" }]);
  expect(report.written).toBe(1);
  expect(report.items).toEqual([
    {
      // The archive path, as for its files.
      row: -1,
      name: "f/d2/",
      path: "d2/",
      skip: ExtractSkip.WRITE,
      detail: "A folder with the same name was made before (a name collision)",
    },
    {
      row: 1,
      name: "f/d2/b.txt",
      path: "d2/b.txt",
      skip: ExtractSkip.WRITE,
      detail: "Its folder could not be made",
    },
  ]);
}, 60_000);

test("a failed folder below another folder shows its archive path", async () => {
  // The second name has a `.` segment and `\\` separators: the archive
  // path keeps the raw segments without the `.`, as the planner does.
  const entries = [entry("f/x/d1/a.txt", "one"), entry("f\\x\\.\\d2\\b.txt", "two")];
  const { bytes, pages } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 2), pages);
  await giveNames(
    api,
    pages,
    entries.map((item) => item.name),
  );
  const root = new FakeFolder((name) => name.replace(/[0-9]/g, "#"));
  const plan = await api.plan({ kind: "folder", path: "f/" });
  const report = await api.extract(
    plan.id,
    { kind: "directory", handle: root as unknown as FileSystemDirectoryHandle, name: "f" },
    new SharedArrayBuffer(PROGRESS_BYTES),
  );
  expect(report.written).toBe(1);
  expect(report.items.map((item) => [item.name, item.path])).toEqual([
    ["f/x/d2/", "x/d2/"],
    ["f\\x\\.\\d2\\b.txt", "x/d2/b.txt"],
  ]);
}, 60_000);

test("a failed folder at depth 2 or more shows its archive path", async () => {
  // The failed folder d2 is below x and y. The second name also has `.`
  // segments and `\\` separators, and a folder below d2 that the job does
  // not try. If `folderSource()` and the `source` closure of
  // `Planner::add` do not agree on the depth, this path is wrong.
  const entries = [entry("f/x/y/d1/a.txt", "one"), entry("f\\x\\.\\y\\.\\d2\\z\\b.txt", "two")];
  const { bytes, pages } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 2), pages);
  await giveNames(
    api,
    pages,
    entries.map((item) => item.name),
  );
  const root = new FakeFolder((name) => name.replace(/[0-9]/g, "#"));
  const plan = await api.plan({ kind: "folder", path: "f/" });
  const report = await api.extract(
    plan.id,
    { kind: "directory", handle: root as unknown as FileSystemDirectoryHandle, name: "f" },
    new SharedArrayBuffer(PROGRESS_BYTES),
  );
  expect(report.written).toBe(1);
  expect(report.items.map((item) => [item.name, item.path])).toEqual([
    ["f/x/y/d2/", "x/y/d2/"],
    ["f\\x\\.\\y\\.\\d2\\z\\b.txt", "x/y/d2/z/b.txt"],
  ]);
}, 60_000);

/** A deflate entry whose data fails on the first read, before its first
 *  byte: block type 3 does not exist. */
const broken = (name: string): Entry => ({
  name,
  body: encoder.encode("lost"),
  data: new Uint8Array([0xff, 0xff, 0xff, 0xff]),
  method: 8,
});

test("a row that fails before its first byte leaves no file, also when the lock frees late", async () => {
  // In Chromium, the lock of an aborted writable can stay for a short time,
  // most often when no byte was written. A user then found an empty file
  // of a failed row in the output folder (CI failures of
  // e2e/extract.spec.ts on 2026-11-03).
  const entries = [entry("f/good.txt", "good"), broken("f/bad.txt")];
  const { bytes, pages } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 2), pages);
  await giveNames(
    api,
    pages,
    entries.map((item) => item.name),
  );
  const root = new FakeFolder((name) => name, { busy: 2 });
  const plan = await api.plan({ kind: "folder", path: "f/" });
  const report = await api.extract(
    plan.id,
    { kind: "directory", handle: root as unknown as FileSystemDirectoryHandle, name: "f" },
    new SharedArrayBuffer(PROGRESS_BYTES),
  );
  const output = root.folders.get("f")!;
  expect([...output.files.values()]).toEqual([{ name: "good.txt", text: "good" }]);
  expect(output.removed).toEqual(["bad.txt"]);
  expect(report.written).toBe(1);
  expect(report.items).toHaveLength(1);
  expect(report.items[0]!.name).toBe("f/bad.txt");
  expect(report.items[0]!.detail).not.toContain("could not be removed");
}, 60_000);

test("the report says so when the file of a failed row stays", async () => {
  const entries = [broken("f/bad.txt"), entry("f/good.txt", "good")];
  const { bytes, pages } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, 2), pages);
  await giveNames(
    api,
    pages,
    entries.map((item) => item.name),
  );
  // The lock never frees.
  const root = new FakeFolder((name) => name, { busy: Infinity });
  const plan = await api.plan({ kind: "folder", path: "f/" });
  const report = await api.extract(
    plan.id,
    { kind: "directory", handle: root as unknown as FileSystemDirectoryHandle, name: "f" },
    new SharedArrayBuffer(PROGRESS_BYTES),
  );
  expect(report.written).toBe(1);
  expect(report.items).toHaveLength(1);
  expect(report.items[0]!.name).toBe("f/bad.txt");
  expect(report.items[0]!.detail).toMatch(/\. The file that was made for it could not be removed$/);
}, 60_000);
