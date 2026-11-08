// The rows of a folder job in flight, with the real read wasm. Holds in a fake file
// system keep a row in flight, so that each test sees the steps of the other rows.
// The results must be the same as with one row at a time. Its own file gives it a
// new wasm instance.
import { afterEach, expect, test, vi } from "vitest";
import {
  ExtractProgress,
  ExtractSkip,
  PROGRESS_BYTES,
  PROGRESS_FLAGS_OFFSET,
  Renamed,
  State,
} from "../contracts";
import { isPlainName } from "./extract";
import { concat, encoder, giveNames, header, openWorker, zip } from "./wasm-harness";
import type { Entry } from "./wasm-harness";
import type { EntryReader, ReadArchive } from "../wasm/zipscope_read.js";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const COLLISION = "A file with the same name was written before (a name collision)";
const ONE_MIB = 1024 * 1024;
/** `FLIGHT_ROW_BYTES` in extract.ts. */
const FLIGHT_ROW_BYTES = 512 * 1024;

/** The steps of all folders, in order, and the holds and failures of these steps. */
class Journal {
  readonly steps: string[] = [];
  private readonly holds = new Map<string, Promise<void>>();
  private readonly releases = new Map<string, () => void>();
  private readonly failures = new Map<string, Error>();
  private readonly onceFailures = new Map<string, Error>();
  openWritables = 0;
  peakWritables = 0;
  /** A writable has a swap file in the folder, as in Chromium. */
  swaps = false;

  /** The next step `key` waits until `release(key)`. */
  hold(key: string): void {
    this.holds.set(
      key,
      new Promise((resolve) => {
        this.releases.set(key, resolve);
      }),
    );
  }

  release(key: string): void {
    this.releases.get(key)!();
  }

  /** The step `key` rejects, after its hold. */
  fail(key: string, message: string): void {
    this.failures.set(key, new Error(message));
  }

  /** The next step `key` rejects, and the step after it does not. */
  failOnce(key: string, message: string): void {
    this.onceFailures.set(key, new Error(message));
  }

  async step(key: string): Promise<void> {
    this.steps.push(key);
    await this.holds.get(key);
    this.steps.push(`${key} done`);
    const once = this.onceFailures.get(key);
    if (once !== undefined) {
      this.onceFailures.delete(key);
      throw once;
    }
    const failure = this.failures.get(key);
    if (failure !== undefined) throw failure;
  }

  count(key: string): number {
    return this.steps.filter((step) => step === key).length;
  }

  has(key: string): boolean {
    return this.steps.includes(key);
  }

  /** True when the step `first` came before the step `second`. */
  before(first: string, second: string): boolean {
    const at = this.steps.indexOf(first);
    return at !== -1 && (!this.has(second) || at < this.steps.indexOf(second));
  }
}

/** A folder of a file system that joins names by `key`. */
class HeldFolder {
  readonly files = new Map<string, { name: string; data: Uint8Array }>();
  readonly folders = new Map<string, HeldFolder>();

  constructor(
    readonly journal: Journal,
    readonly key: (name: string) => string = (name) => name,
  ) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let folder = this.folders.get(this.key(name));
    if (folder === undefined) {
      if (options?.create !== true) throw new DOMException("No folder", "NotFoundError");
      folder = new HeldFolder(this.journal, this.key);
      this.folders.set(this.key(name), folder);
    }
    return folder;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const { files, journal } = this;
    const swap = this.key(`${name}.crswap`);
    const key = this.key(name);
    if (options?.create !== true) {
      await journal.step(`check ${name}`);
      if (!this.files.has(key)) throw new DOMException("No file", "NotFoundError");
    } else {
      await journal.step(`create ${name}`);
      if (!this.files.has(key)) this.files.set(key, { name, data: new Uint8Array() });
    }
    const target = this.files.get(key)!;
    return {
      async createWritable() {
        // Chromium makes `<name>.crswap` here, and it is in the folder until the
        // writable ends.
        await journal.step(`writable ${name}`);
        if (journal.swaps) files.set(swap, { name: `${name}.crswap`, data: new Uint8Array() });
        const parts: Uint8Array[] = [];
        journal.openWritables++;
        journal.peakWritables = Math.max(journal.peakWritables, journal.openWritables);
        return {
          async write(bytes: Uint8Array) {
            await journal.step(`write ${name}`);
            parts.push(bytes.slice());
          },
          async close() {
            try {
              await journal.step(`close ${name}`);
              const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
              let at = 0;
              for (const part of parts) {
                data.set(part, at);
                at += part.length;
              }
              target.data = data;
            } finally {
              journal.openWritables--;
              if (journal.swaps) files.delete(swap);
            }
          },
          async abort() {
            journal.steps.push(`abort ${name}`);
            if (journal.swaps) files.delete(swap);
          },
        };
      },
    };
  }

  async removeEntry(name: string) {
    await this.journal.step(`remove ${name}`);
    this.files.delete(this.key(name));
  }

  /** The text of each file, in the order of the file system. */
  texts(): Record<string, string> {
    const decoder = new TextDecoder();
    return Object.fromEntries(
      [...this.files.values()].map(({ name, data }) => [name, decoder.decode(data)]),
    );
  }
}

const row = (name: string, text = name): Entry => ({
  name: `f/${name}`,
  body: encoder.encode(text),
});

/** A stored row whose CRC-32 does not agree with its data. */
const badCrc = (name: string): Entry => ({
  name: `f/${name}`,
  body: encoder.encode("the listed bytes"),
  data: encoder.encode("other bytes here"),
});

/** A stored row of `size` bytes. */
const sized = (name: string, size: number): Entry => ({
  name: `f/${name}`,
  body: new Uint8Array(size).fill(0x61),
});

/** Starts a job of `entries` on the fake folder. `prepare` gets the journal before
 *  the job starts. */
async function startJob(
  entries: Entry[],
  key: (name: string) => string = (name) => name,
  prepare: (journal: Journal) => void = () => {},
) {
  const { bytes, pages } = zip(entries);
  const api = await openWorker(mocks.expose, bytes, header(State.COMPLETE, entries.length), pages);
  await giveNames(
    api,
    pages,
    entries.map((item) => item.name),
  );
  const wasm = await import("../wasm/zipscope_read.js");
  const opened: number[] = [];
  let openStreams = 0;
  let peakStreams = 0;
  const openEntry = wasm.ReadArchive.prototype.openEntry;
  vi.spyOn(wasm.ReadArchive.prototype, "openEntry").mockImplementation(function (
    this: ReadArchive,
    index: number,
    window: number,
  ) {
    opened.push(index);
    peakStreams = Math.max(peakStreams, ++openStreams);
    return openEntry.call(this, index, window);
  });
  const free = wasm.EntryReader.prototype.free;
  vi.spyOn(wasm.EntryReader.prototype, "free").mockImplementation(function (this: EntryReader) {
    openStreams--;
    free.call(this);
  });
  const journal = new Journal();
  prepare(journal);
  const root = new HeldFolder(journal, key);
  const plan = await api.plan({ kind: "folder", path: "f/" });
  const progress = new SharedArrayBuffer(PROGRESS_BYTES);
  let settled = false;
  const report = api
    .extract(
      plan.id,
      { kind: "directory", handle: root as unknown as FileSystemDirectoryHandle, name: "f" },
      progress,
    )
    .finally(() => {
      settled = true;
    });
  return {
    report,
    journal,
    opened,
    root,
    stop: () =>
      Atomics.store(new Int32Array(progress, PROGRESS_FLAGS_OFFSET, 2), ExtractProgress.CANCEL, 1),
    output: () => root.folders.get("f")!,
    settled: () => settled,
    streams: () => peakStreams,
    filesDone: () => new Float64Array(progress, 0, 4)[ExtractProgress.FILES],
  };
}

/** Gives the job many turns of the event loop. */
async function turns(count = 50): Promise<void> {
  for (let turn = 0; turn < count; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Waits for a step of the job. The timeout of the test ends a wait that never ends. */
async function until(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Two rows that a file system joins, and the plan does not join: all digits are one. */
const digits = (name: string) => name.replace(/[0-9]/g, "#");

test("two rows with one name in flight give one file and one failed row", async () => {
  const job = await startJob([row("x1.txt"), row("x2.txt"), row("y.txt")], digits, (journal) =>
    journal.hold("close x1.txt"),
  );
  // The second row checks its name while the first row is in flight. The file
  // system says that the name is there, so the row must not open it.
  await until(() => job.journal.has("check x2.txt done"));
  await turns();
  expect(job.journal.has("close x1.txt done")).toBe(false);
  expect(job.journal.has("create x2.txt")).toBe(false);
  job.journal.release("close x1.txt");
  const report = await job.report;
  expect(job.output().texts()).toEqual({ "x1.txt": "x1.txt", "y.txt": "y.txt" });
  expect(job.journal.has("create x2.txt")).toBe(false);
  expect(job.journal.has("writable x2.txt")).toBe(false);
  expect(job.journal.has("remove x2.txt")).toBe(false);
  expect(job.journal.has("remove x1.txt")).toBe(false);
  expect(report.outcome).toBe("complete");
  expect(report.written).toBe(2);
  expect(report.bytes).toBe(11);
  expect(report.more).toBe(0);
  expect(report.items).toEqual([
    {
      row: 1,
      name: "f/x2.txt",
      path: "x2.txt",
      skip: ExtractSkip.WRITE,
      detail: COLLISION,
    },
  ]);
}, 60_000);

test("a row whose name is in flight waits, and it writes when the first row fails", async () => {
  const job = await startJob([row("x1.txt"), row("x2.txt")], digits, (journal) => {
    journal.hold("close x1.txt");
    journal.fail("close x1.txt", "The disk is full");
  });
  await until(() => job.journal.has("check x2.txt done"));
  await turns();
  expect(job.journal.has("create x2.txt")).toBe(false);
  job.journal.release("close x1.txt");
  const report = await job.report;
  // With one row at a time, the first file is gone when the second row checks.
  expect(job.journal.before("remove x1.txt done", "create x2.txt")).toBe(true);
  expect(job.output().texts()).toEqual({ "x2.txt": "x2.txt" });
  expect(report.written).toBe(1);
  expect(report.items).toEqual([
    {
      row: 0,
      name: "f/x1.txt",
      path: "x1.txt",
      skip: ExtractSkip.WRITE,
      detail: "The disk is full",
    },
  ]);
}, 60_000);

test("a row whose name is in flight waits for each row before it", async () => {
  // The row with the name is not the first row in flight.
  const job = await startJob([row("a.txt"), row("x1.txt"), row("x2.txt")], digits, (journal) => {
    journal.hold("close x1.txt");
    journal.fail("close x1.txt", "The disk is full");
  });
  await until(() => job.journal.has("check x2.txt done") && job.journal.has("close a.txt done"));
  await turns();
  expect(job.journal.has("create x2.txt")).toBe(false);
  job.journal.release("close x1.txt");
  const report = await job.report;
  expect(job.output().texts()).toEqual({ "a.txt": "a.txt", "x2.txt": "x2.txt" });
  expect(report.items.map((item) => [item.row, item.detail])).toEqual([[1, "The disk is full"]]);
}, 60_000);

test("a row whose name is in flight waits for an earlier row that is not the last", async () => {
  // The order is x1, a, x2. The row a ends, and x1 is in flight. A wait for the last
  // row only would see the file of x1, and it would fail x2.
  const job = await startJob([row("x1.txt"), row("a.txt"), row("x2.txt")], digits, (journal) => {
    journal.hold("close x1.txt");
    journal.fail("close x1.txt", "The disk is full");
  });
  await until(() => job.journal.has("check x2.txt done") && job.journal.has("close a.txt done"));
  await turns();
  expect(job.journal.count("check x2.txt")).toBe(1);
  expect(job.journal.has("create x2.txt")).toBe(false);
  job.journal.release("close x1.txt");
  const report = await job.report;
  expect(job.journal.before("remove x1.txt done", "create x2.txt")).toBe(true);
  expect(job.output().texts()).toEqual({ "a.txt": "a.txt", "x2.txt": "x2.txt" });
  expect(report.items.map((item) => [item.row, item.detail])).toEqual([[0, "The disk is full"]]);
}, 60_000);

test("a row with a swap name waits for an earlier row that is not the last", async () => {
  // The order is x.txt, a.txt, x.txt.crswap. The row a.txt ends, and x.txt is in
  // flight with its swap file. A wait for the last row only would check here.
  const job = await startJob(
    [row("x.txt"), row("a.txt"), row("x.txt.crswap")],
    undefined,
    (journal) => {
      journal.swaps = true;
      journal.hold("close x.txt");
      journal.fail("close x.txt", "The disk is full");
    },
  );
  await until(() => job.journal.has("writable x.txt done") && job.journal.has("close a.txt done"));
  await turns();
  expect(job.journal.has("check x.txt.crswap")).toBe(false);
  job.journal.release("close x.txt");
  const report = await job.report;
  expect(job.journal.before("remove x.txt done", "check x.txt.crswap")).toBe(true);
  expect(job.output().texts()).toEqual({ "a.txt": "a.txt", "x.txt.crswap": "x.txt.crswap" });
  expect(report.items.map((item) => [item.row, item.detail])).toEqual([[0, "The disk is full"]]);
}, 60_000);

test("a name check that fails one time is done again, and the row writes", async () => {
  // With one row at a time, this row fails with the collision text. With rows in
  // flight, the row checks again after the wait, and its second check finds no file.
  const job = await startJob([row("a.txt"), row("b.txt"), row("c.txt")], undefined, (journal) =>
    journal.failOnce("check b.txt", "A short failure of the browser"),
  );
  const report = await job.report;
  expect(job.journal.count("check b.txt")).toBe(2);
  expect(job.output().texts()).toEqual({ "a.txt": "a.txt", "b.txt": "b.txt", "c.txt": "c.txt" });
  expect(report.written).toBe(3);
  expect(report.items).toEqual([]);
}, 60_000);

test("a name check that fails two times gives the collision, and no other row changes", async () => {
  const job = await startJob([row("a.txt"), row("b.txt"), row("c.txt")], undefined, (journal) =>
    journal.fail("check b.txt", "A long failure of the browser"),
  );
  const report = await job.report;
  expect(job.journal.count("check b.txt")).toBe(2);
  expect(job.journal.has("create b.txt")).toBe(false);
  expect(job.output().texts()).toEqual({ "a.txt": "a.txt", "c.txt": "c.txt" });
  expect(report.items.map((item) => [item.row, item.skip, item.detail])).toEqual([
    [1, ExtractSkip.WRITE, COLLISION],
  ]);
}, 60_000);

test("a row with the name of a failed row in flight never loses its file", async () => {
  // The row with the bad data fails in its decode, and its name is the name of the
  // next row. The removal of the first file must come before the second file.
  const job = await startJob([badCrc("x1.txt"), row("x2.txt")], digits, (journal) =>
    journal.hold("remove x1.txt"),
  );
  await until(() => job.journal.has("remove x1.txt"));
  await turns();
  expect(job.journal.has("create x2.txt")).toBe(false);
  job.journal.release("remove x1.txt");
  const report = await job.report;
  expect(job.journal.before("remove x1.txt done", "create x2.txt")).toBe(true);
  expect(job.output().texts()).toEqual({ "x2.txt": "x2.txt" });
  expect(report.written).toBe(1);
  expect(report.items.map((item) => item.row)).toEqual([0]);
  expect(report.items[0]!.skip).toBe(ExtractSkip.VERIFY);
}, 60_000);

test("a name that collides and data that fails give the collision, as before", async () => {
  // The name check comes before the decode of a row that decodes as it writes.
  const job = await startJob([row("x1.txt"), badCrc("x2.txt")], digits);
  const report = await job.report;
  expect(job.output().texts()).toEqual({ "x1.txt": "x1.txt" });
  expect(report.items.map((item) => [item.row, item.skip, item.detail])).toEqual([
    [1, ExtractSkip.WRITE, COLLISION],
  ]);
}, 60_000);

test("three rows with one name in flight give one file", async () => {
  const job = await startJob(
    [row("x1.txt"), row("x2.txt"), row("x3.txt"), row("y.txt")],
    digits,
    (journal) => journal.hold("close x1.txt"),
  );
  await until(() => job.journal.has("check x2.txt done"));
  await turns();
  job.journal.release("close x1.txt");
  const report = await job.report;
  expect(job.output().texts()).toEqual({ "x1.txt": "x1.txt", "y.txt": "y.txt" });
  expect(report.written).toBe(2);
  expect(report.items.map((item) => [item.row, item.detail])).toEqual([
    [1, COLLISION],
    [2, COLLISION],
  ]);
}, 60_000);

/** Removes each space, as a layer that removes them. */
const noSpaces = (name: string) => name.replaceAll(" ", "");
/** Removes the parentheses, as a layer that removes them. */
const noPunctuation = (name: string) => name.replace(/[()]/g, "");

test.each([
  ["a.txt.crswap", undefined],
  ["A.TXT.CRSWAP", undefined],
  ["a.txt.1.crswap", undefined],
  ["a.txt.cr\u017fwap", undefined],
  ["a.txt.crswap.txt", undefined],
  ["AAAAAA~1.CRS", undefined],
  // The plan replaces a variation selector after ASCII, and the output name still has
  // the swap name.
  ["a.txt.crswap\ufe0f", undefined, "a.txt.crswap_"],
  ["a.txt.c rswap", noSpaces],
  ["a.txt.c r swap", noSpaces],
  ["a.txt.c(r)swap", noPunctuation],
])(
  "a row with the name %s waits for the rows before it, and it writes",
  async (name, fold, output = name) => {
    const job = await startJob(
      [row("a.txt", "the row"), row(name, "the other row"), row("b.txt")],
      fold ?? ((entry) => entry.normalize("NFKC").toLowerCase()),
      (journal) => {
        journal.swaps = true;
        journal.hold("close a.txt");
      },
    );
    // The swap file of the first row is there, and the second row must not see a free
    // name before the swap file comes. So it waits before its check.
    await until(() => job.journal.has("writable a.txt done"));
    await turns();
    expect(job.journal.steps.filter((step) => step.endsWith(output))).toEqual([]);
    expect(job.journal.has("check b.txt")).toBe(false);
    job.journal.release("close a.txt");
    const report = await job.report;
    expect(Object.values(job.output().texts()).sort()).toEqual([
      "b.txt",
      "the other row",
      "the row",
    ]);
    expect(report.written).toBe(3);
    expect(report.items).toEqual(
      output === name
        ? []
        : [{ row: 1, name: `f/${name}`, path: output, renamed: Renamed.CHARACTERS }],
    );
  },
  60_000,
);

test("the name that goes to the browser decides if a row waits, not the name in the archive", async () => {
  // The plan changes the colon to `_`, so the second row is plain and it overlaps. The
  // plan adds `_` after the last dot, and the third row still has the swap name.
  const job = await startJob(
    [row("a.txt"), row("bb:c.txt"), row("a.txt.crswap.")],
    undefined,
    (journal) => journal.hold("close a.txt"),
  );
  await until(() => job.journal.has("close bb_c.txt done"));
  await turns();
  expect(job.journal.has("close a.txt done")).toBe(false);
  expect(job.journal.steps.some((step) => step.includes("crswap"))).toBe(false);
  job.journal.release("close a.txt");
  const report = await job.report;
  expect(job.journal.has("check a.txt.crswap._")).toBe(true);
  expect(report.written).toBe(3);
}, 60_000);

test.each([
  ["a.txt"],
  ["A-1_b.tar.gz"],
  ["__init__.py"],
  ["-x"],
  ["0"],
  ["a..b"],
  ["x".repeat(128)],
  ["a b.txt"],
  ["My Report 12 (copy).txt"],
  ["README (2).txt"],
  ["a$b"],
  ["(a)"],
  ["cars.txt"],
  ["c1r2s.txt"],
  ...[..."()[]+,=@#&'!$;^{}`"].flatMap((mark) => [[`a${mark}b`], [`${mark}a`], [`a${mark}`]]),
])("the name %s is plain, and it overlaps", (name) => {
  expect(isPlainName(name)).toBe(true);
});

test.each([
  ["a last dot", "a.txt.crswap."],
  ["a last dot on a usual name", "a.txt."],
  ["a last space", "a.txt.crswap "],
  ["a last space on a usual name", "a.txt "],
  ["a first space", " a.txt"],
  ["only a space", " "],
  ["only a dot", "."],
  ["a swap name", "a.txt.crswap"],
  ["a swap name in capitals", "A.TXT.CRSWAP"],
  ["a swap name in mixed case", "a.txt.CrSwAp"],
  ["a numbered swap name", "a.txt.1.crswap"],
  ["a swap name inside", "a.crswap.txt"],
  ["a swap name at the start", ".crswap"],
  ["a swap name with no dot", "a.txtcrswap"],
  ["a space in a swap name", "a.c rswap"],
  ["a space in a swap name of a usual file", "a.bin.c rswap"],
  ["two spaces in a swap name", "a.bin.c r s"],
  ["parentheses in a swap name", "a.c(r)swap"],
  ["parentheses in a swap name of a usual file", "a.bin.c(r)swap"],
  ["other marks in a swap name", "a.C_R-S,wap"],
  ["many marks in a swap name", "a.c ( r ) swap"],
  ["a code of a letter in a swap name", "a.bin.c%72swap"],
  ["a cut swap name", "abcdefgh.crs"],
  ["a cut swap name in capitals", "ABCDEFGH.CRSW"],
  ["a short name", "AAAAAA~1.CRS"],
  ["a short name with another extension", "ABCDEF~1.TXT"],
  ["a tilde at the end", "a.txt~"],
  ["a tilde at the start", "~a.txt"],
  ["a first dot", ".a.txt"],
  ["a sidecar of macOS", "._a.txt"],
  ["a colon", "a:b"],
  ["an NTFS stream", "a.txt::$DATA"],
  ["a backslash", "a\\b"],
  ["a slash", "a/b"],
  ["a star", "a*b"],
  ["a question mark", "a?b"],
  ["a quote", 'a"b'],
  ["less than", "a<b"],
  ["greater than", "a>b"],
  ["a vertical bar", "a|b"],
  ["a percent", "a%2fb"],
  ["a percent at the start", "%a"],
  ["a percent with no digits", "a%b"],
  ["a control character", "a\tb"],
  ["delete", "a\u007fb"],
  ["a NUL", "a\u0000b"],
  ["a line feed at the end", "a.txt\n"],
  ["an accent", "caf\u00e9.txt"],
  ["a combined accent", "cafe\u0301.txt"],
  ["a variation selector", "a.txt.crswap\ufe0f"],
  ["a joiner", "a\u200db"],
  ["a long s", "a.txt.cr\u017fwap"],
  ["a fullwidth dot", "a\uff0etxt"],
  ["a kelvin sign", "\u212a.txt"],
  ["a surrogate pair", "a\u{1f600}.txt"],
  ["a lone surrogate", "a\ud800.txt"],
  ["a name above the limit", "x".repeat(129)],
  ["the empty name", ""],
])("a name with %s is not plain, and it waits", (_, name) => {
  expect(isPlainName(name)).toBe(false);
});

test("a row does not wait for the writable of the row before it", async () => {
  const job = await startJob([row("a.txt"), row("b.txt")], undefined, (journal) =>
    journal.hold("writable a.txt"),
  );
  await until(() => job.journal.has("close b.txt done"));
  expect(job.journal.has("writable a.txt done")).toBe(false);
  job.journal.release("writable a.txt");
  const report = await job.report;
  expect(report.written).toBe(2);
}, 60_000);

test("names that one case fold joins get the renames of the plan, with rows in flight", async () => {
  const job = await startJob(
    [row("Readme.txt", "first"), row("README.txt", "second"), row("readme.TXT", "third")],
    (name) => name.toLowerCase(),
    (journal) => journal.hold("close Readme.txt"),
  );
  // The plan renames the second row, and its new name is plain, so it does not wait: it
  // ends while the first row is in flight.
  const planned = () => job.journal.steps.filter((step) => step.startsWith("close "));
  await until(() => planned().filter((step) => step.endsWith(" done")).length === 2);
  expect(job.journal.has("close Readme.txt done")).toBe(false);
  job.journal.release("close Readme.txt");
  const report = await job.report;
  const texts = Object.values(job.output().texts()).sort();
  expect(texts).toEqual(["first", "second", "third"]);
  expect(report.written).toBe(3);
  expect(report.items.map((item) => [item.row, item.name, item.skip])).toEqual([
    [1, "f/README.txt", undefined],
    [2, "f/readme.TXT", undefined],
  ]);
  expect(report.items.every((item) => item.renamed !== undefined)).toBe(true);
}, 60_000);

test("a failed row in flight is removed before its row goes into the report", async () => {
  const names = ["c", "d", "e", "f", "g", "h", "i", "j"].map((letter) => `${letter}.txt`);
  const job = await startJob(
    [row("a.txt"), badCrc("b.txt"), ...names.map((name) => row(name))],
    undefined,
    (journal) => {
      journal.hold("close a.txt");
      journal.hold("remove b.txt");
    },
  );
  // The rows after the failed row end while the first row and the removal wait.
  await until(() => job.journal.has("close h.txt done"));
  expect(job.journal.has("close a.txt done")).toBe(false);
  expect(job.journal.has("abort b.txt")).toBe(true);
  expect(job.journal.before("abort b.txt", "remove b.txt")).toBe(true);
  job.journal.release("close a.txt");
  await until(() => job.journal.has("close i.txt done"));
  await turns();
  expect(job.settled()).toBe(false);
  // The row stays out of the report and the counts until its file is gone, and the
  // job waits for it to start the last row.
  expect(job.filesDone()).toBe(1);
  expect(job.journal.has("check j.txt")).toBe(false);
  job.journal.release("remove b.txt");
  const report = await job.report;
  expect(job.output().texts()).toEqual(
    Object.fromEntries(["a.txt", ...names].map((name) => [name, name])),
  );
  expect(report.written).toBe(9);
  expect(job.filesDone()).toBe(10);
  expect(report.items).toHaveLength(1);
  expect(report.items[0]).toMatchObject({
    row: 1,
    name: "f/b.txt",
    path: "b.txt",
    skip: ExtractSkip.VERIFY,
  });
  expect(report.items[0]!.detail).not.toContain("could not be removed");
}, 60_000);

test("the report keeps row order when rows end in another order", async () => {
  const job = await startJob(
    [row("a.txt"), row("b.txt"), row("c.txt"), row("d.txt")],
    undefined,
    (journal) => {
      journal.hold("close a.txt");
      journal.fail("close a.txt", "first failure");
      journal.fail("close c.txt", "second failure");
      journal.fail("writable d.txt", "third failure");
    },
  );
  await until(() => job.journal.has("abort c.txt") && job.journal.has("writable d.txt done"));
  await turns();
  expect(job.journal.has("close a.txt done")).toBe(false);
  job.journal.release("close a.txt");
  const report = await job.report;
  expect(job.journal.before("abort c.txt", "abort a.txt")).toBe(true);
  expect(report.items.map((item) => [item.row, item.detail])).toEqual([
    [0, "first failure"],
    [2, "second failure"],
    [3, "third failure"],
  ]);
  expect(report.written).toBe(1);
  expect(job.output().texts()).toEqual({ "b.txt": "b.txt" });
}, 60_000);

test("a stop with rows in flight starts no row, and it leaves only complete files", async () => {
  const names = Array.from({ length: 20 }, (_, index) => `r${String(index).padStart(2, "0")}.txt`);
  const job = await startJob(
    names.map((name) => row(name, `the bytes of ${name}`)),
    undefined,
    (journal) => {
      journal.hold("close r00.txt");
      journal.fail("close r02.txt", "A failure in flight");
    },
  );
  await until(() => job.journal.has("close r07.txt done"));
  await turns();
  job.stop();
  job.journal.release("close r00.txt");
  const report = await job.report;
  expect(report.outcome).toBe("cancelled");
  // Each row in flight ended: seven files, and one failed row with no file.
  const kept = names.slice(0, 8).filter((name) => name !== "r02.txt");
  expect(job.output().texts()).toEqual(
    Object.fromEntries(kept.map((name) => [name, `the bytes of ${name}`])),
  );
  expect(report.written).toBe(7);
  expect(report.items.map((item) => [item.row, item.detail])).toEqual([[2, "A failure in flight"]]);
  expect(job.journal.has("remove r02.txt done")).toBe(true);
  expect(job.journal.openWritables).toBe(0);
  // No later row made a file or read its data.
  expect(job.opened).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(job.journal.has("check r08.txt")).toBe(false);
}, 60_000);

test("a stop in a large row removes its file and keeps the rows before it", async () => {
  const job = await startJob(
    [row("a.txt"), row("b.txt"), sized("big.bin", 2 * ONE_MIB), row("c.txt")],
    undefined,
    (journal) => journal.hold("writable big.bin"),
  );
  await until(() => job.journal.has("writable big.bin"));
  job.stop();
  job.journal.release("writable big.bin");
  const report = await job.report;
  expect(report.outcome).toBe("cancelled");
  expect(job.journal.has("remove big.bin done")).toBe(true);
  expect(job.output().texts()).toEqual({ "a.txt": "a.txt", "b.txt": "b.txt" });
  expect(report.written).toBe(2);
  expect(report.items).toEqual([]);
  expect(job.opened).toEqual([0, 1, 2]);
}, 60_000);

test("at most eight rows are in flight, and one row decodes at a time", async () => {
  const names = Array.from({ length: 16 }, (_, index) => `r${String(index).padStart(2, "0")}.txt`);
  const job = await startJob(
    names.map((name) => row(name)),
    undefined,
    (journal) => journal.hold("close r00.txt"),
  );
  await until(() => job.journal.has("close r07.txt done"));
  await turns();
  // The job waits for the first row, with no more reads and no more file steps.
  expect(job.opened).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(job.journal.has("check r08.txt")).toBe(false);
  job.journal.release("close r00.txt");
  const report = await job.report;
  expect(report.written).toBe(16);
  expect(job.opened).toEqual(names.map((_, index) => index));
  expect(job.streams()).toBe(1);
  expect(job.journal.peakWritables).toBeLessThanOrEqual(8);
  expect(job.journal.peakWritables).toBeGreaterThan(1);
}, 60_000);

test("a row above the limit does not overlap, and a row at the limit overlaps", async () => {
  const job = await startJob(
    [
      sized("exact.bin", FLIGHT_ROW_BYTES),
      row("near.txt"),
      sized("big.bin", FLIGHT_ROW_BYTES + 1),
      row("after.txt"),
    ],
    undefined,
    (journal) => {
      journal.hold("close exact.bin");
      journal.hold("close big.bin");
    },
  );
  await until(() => job.journal.has("close near.txt done"));
  await turns();
  // The large row waits for all rows before it, also for its reads.
  expect(job.opened).toEqual([0, 1]);
  expect(job.journal.has("check big.bin")).toBe(false);
  job.journal.release("close exact.bin");
  await until(() => job.journal.has("close big.bin"));
  await turns();
  // The row after the large row waits for it.
  expect(job.opened).toEqual([0, 1, 2]);
  expect(job.journal.openWritables).toBe(1);
  job.journal.release("close big.bin");
  const report = await job.report;
  expect(report.written).toBe(4);
  expect(job.output().files.get("big.bin")!.data.length).toBe(FLIGHT_ROW_BYTES + 1);
  expect(job.output().files.get("exact.bin")!.data.length).toBe(FLIGHT_ROW_BYTES);
}, 60_000);

test("a row that declares a small size holds at most this size", async () => {
  // The limit of the memory of the rows in flight comes from this: no row holds
  // more than it declares. These rows have 60,000 bytes of data and declare 16 bytes.
  const big = new Uint8Array(60_000).fill(0x61);
  // One deflate block with stored data.
  const deflated = concat(new Uint8Array([1, 0x60, 0xea, 0x9f, 0x15]), big);
  const job = await startJob([
    { name: "f/stored.bin", body: big, size: 16 },
    { name: "f/deflated.bin", body: big, data: deflated, method: 8, size: 16 },
    row("r.txt"),
  ]);
  const wasm = await import("../wasm/zipscope_read.js");
  const read = wasm.EntryReader.prototype.read;
  const sizes: number[] = [];
  vi.spyOn(wasm.EntryReader.prototype, "read").mockImplementation(function (
    this: EntryReader,
    max: number,
    window: number,
  ) {
    const part = read.call(this, max, window);
    sizes.push(part.length);
    return part;
  });
  const report = await job.report;
  expect(Math.max(...sizes)).toBeLessThanOrEqual(16);
  expect(report.items.map((item) => item.row)).toEqual([0, 1]);
  expect(job.output().texts()).toEqual({ "r.txt": "r.txt" });
}, 60_000);
