// The memory budget with the real wasm parser (`mise run build:wasm` makes
// it). Short records and then large records must not let one batch pass
// the budget by much.
import { expect, test, vi } from "vitest";
import type { MemoryUsage, ParseWorkerApi } from "../contracts";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose }));
/** A file that the stub `FileReaderSync` reads at once. */
class BytesFile {
  constructor(readonly bytes: Uint8Array) {}
  get size(): number {
    return this.bytes.length;
  }
  slice(start?: number, end?: number): BytesFile {
    return new BytesFile(this.bytes.subarray(start, end));
  }
}

interface ZipEntry {
  name: Uint8Array | string;
  comment?: Uint8Array | string;
  extra?: Uint8Array;
}

const encoder = new TextEncoder();
const bytesOf = (text: Uint8Array | string = "") =>
  typeof text === "string" ? encoder.encode(text) : text;

/** A central directory of empty entries with names, comments and extra
 *  fields. All entries point to one local header, which the parse does not
 *  read. */
function zip(entries: ZipEntry[]): Uint8Array {
  const encoded = entries.map(({ name, comment, extra }) => ({
    name: bytesOf(name),
    comment: bytesOf(comment),
    extra: extra ?? new Uint8Array(),
  }));
  const directory = encoded.reduce(
    (sum, { name, comment, extra }) => sum + 46 + name.length + extra.length + comment.length,
    0,
  );
  const bytes = new Uint8Array(30 + directory + 22);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, 0x04034b50, true);
  let central = 30;
  for (const { name, comment, extra } of encoded) {
    data.setUint32(central, 0x02014b50, true);
    data.setUint16(central + 4, 20, true);
    data.setUint16(central + 6, 20, true);
    data.setUint16(central + 28, name.length, true);
    data.setUint16(central + 30, extra.length, true);
    data.setUint16(central + 32, comment.length, true);
    bytes.set(name, central + 46);
    bytes.set(extra, central + 46 + name.length);
    bytes.set(comment, central + 46 + name.length + extra.length);
    central += 46 + name.length + extra.length + comment.length;
  }
  data.setUint32(central, 0x06054b50, true);
  data.setUint16(central + 8, Math.min(entries.length, 0xffff), true);
  data.setUint16(central + 10, Math.min(entries.length, 0xffff), true);
  data.setUint32(central + 12, directory, true);
  data.setUint32(central + 16, 30, true);
  return bytes;
}

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** A Unicode Path (0x7075) or Unicode Comment (0x6375) extra field. */
function unicodeField(id: number, raw: Uint8Array, text: string): Uint8Array {
  const value = encoder.encode(text);
  const field = new Uint8Array(4 + 5 + value.length);
  const data = new DataView(field.buffer);
  data.setUint16(0, id, true);
  data.setUint16(2, 5 + value.length, true);
  field[4] = 1;
  data.setUint32(5, crc32(raw), true);
  field.set(value, 9);
  return field;
}

const MiB = 2 ** 20;
const soft = 40 * MiB;
// The hard stop keeps one eighth (9 MiB) for the read worker, so the
// store can use about 63 MiB.
const hard = 72 * MiB;
// One arena chunk of names and one of comments, with their mirrors.
const slack = 16 * MiB;

/** Parses with the budget above and answers yes at the soft budget. */
async function parseWithBudget(entries: ZipEntry[]) {
  vi.resetModules();
  mocks.expose.mockClear();
  vi.stubGlobal(
    "FileReaderSync",
    class {
      readAsArrayBuffer(file: BytesFile) {
        return file.bytes.slice().buffer;
      }
    },
  );
  // The batch size follows the time of each batch. With a fixed clock, the
  // batches grow to the largest size on all machines.
  vi.spyOn(performance, "now").mockReturnValue(0);
  const prompts: MemoryUsage[] = [];
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls.at(-1)![0] as ParseWorkerApi;
  await api.open(
    new BytesFile(zip(entries)) as unknown as File,
    {
      mirror() {},
      confirmMemory(usage) {
        prompts.push(usage);
        return Promise.resolve(true);
      },
    },
    { budget: { soft, hard } },
  );
  const outcome = await api.finished();
  const report = await api.health();
  return { prompts, outcome, report };
}

/** The prompt comes near the soft budget, and parsing stops near the hard
 *  stop with a partial listing. */
function expectNearTheBudget(
  { prompts, outcome, report }: Awaited<ReturnType<typeof parseWithBudget>>,
  shortRows: number,
  total: number,
) {
  expect(prompts).toHaveLength(1);
  expect(prompts[0]!.bytes).toBeGreaterThanOrEqual(soft);
  expect(prompts[0]!.bytes).toBeLessThan(soft + slack);
  expect(outcome.kind).toBe("failed");
  expect(outcome.rows).toBeGreaterThan(shortRows);
  expect(outcome.rows).toBeLessThan(total);
  expect(report.budget.hardReached).toBe(true);
  expect(report.budget.storeBytes).toBeLessThan(hard + slack);
}

test("large records after short records stop a batch near the budget", async () => {
  const entries: ZipEntry[] = [];
  for (let index = 0; index < 30_000; index++) {
    entries.push({ name: `s/${index}` });
  }
  const text = "x".repeat(30_000);
  for (let index = 0; index < 1_000; index++) {
    entries.push({ name: `large/${index}-${text}`, comment: text });
  }
  expectNearTheBudget(await parseWithBudget(entries), 30_000, entries.length);
});

test.for(["path", "comment"] as const)(
  "large Unicode %s fields after short records stop a batch near the budget",
  async (kind) => {
    const entries: ZipEntry[] = [];
    for (let index = 0; index < 30_000; index++) {
      entries.push({ name: `s/${index}` });
    }
    // One-byte raw text, and about 60 KB in the extra field.
    const raw = encoder.encode("r");
    const text = "u".repeat(60_000);
    for (let index = 0; index < 2_000; index++) {
      const unicode = `${String(index).padStart(5, "0")}${text}`;
      entries.push(
        kind === "path"
          ? { name: raw, extra: unicodeField(0x7075, raw, unicode) }
          : {
              name: `c/${index}`,
              comment: raw,
              extra: unicodeField(0x6375, raw, unicode),
            },
      );
    }
    expectNearTheBudget(await parseWithBudget(entries), 30_000, entries.length);
  },
);

/** Parses with only a hard stop and returns the committed rows. */
async function rowsAtHardStop(entries: ZipEntry[], hardBytes: number): Promise<number> {
  vi.resetModules();
  mocks.expose.mockClear();
  vi.stubGlobal(
    "FileReaderSync",
    class {
      readAsArrayBuffer(file: BytesFile) {
        return file.bytes.slice().buffer;
      }
    },
  );
  vi.spyOn(performance, "now").mockReturnValue(0);
  const workerPath = "./worker";
  await import(workerPath);
  const api = mocks.expose.mock.calls.at(-1)![0] as ParseWorkerApi;
  await api.open(
    new BytesFile(zip(entries)) as unknown as File,
    { mirror() {}, confirmMemory: () => Promise.resolve(true) },
    { budget: { soft: hardBytes, hard: hardBytes } },
  );
  const outcome = await api.finished();
  expect(outcome.kind).toBe("failed");
  return outcome.rows;
}

/** 20,000 CP437 names of high bytes (2 or 3 UTF-8 bytes for each byte).
 *  One name in 97 is 30 to 65 KB long. */
function cp437Entries(comments: (row: number) => boolean): ZipEntry[] {
  return Array.from({ length: 20_000 }, (_, row) => {
    const length = row % 97 === 0 ? 30_000 + (row % 35_000) : 40 + (row % 200);
    const name = new Uint8Array(length);
    for (let index = 0; index < length; index++) name[index] = 0x80 + ((index * 7 + row) % 128);
    return { name, comment: comments(row) ? new Uint8Array(20_000).fill(0xb0) : undefined };
  });
}

// Near a small hard stop, the first page and arena chunks with their
// mirrors take most of the room. The batch estimate counts each page and
// chunk, so a batch stops before one that does not fit, and its rows are
// not lost to the refusal.
test("a small hard stop keeps the rows before a chunk that does not fit", async () => {
  const none = cp437Entries(() => false);
  const low = await rowsAtHardStop(none, 31 * MiB + 12_345);
  const high = await rowsAtHardStop(none, 35 * MiB + 12_345);
  // Both stops keep all rows of the first name chunk.
  expect(low).toBeGreaterThan(3_000);
  expect(high).toBe(low);
  // The first comment (row 1) needs a chunk and its mirror that do not
  // fit. The batch stops before it, so row 0 stays.
  expect(
    await rowsAtHardStop(
      cp437Entries((row) => row % 89 === 1),
      32 * MiB + 12_345,
    ),
  ).toBe(1);
}, 60_000);
