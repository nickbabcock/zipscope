// The lead and two encoders with the real write wasm: the
// copy keeps the row order, and it reserves its memory on the shared
// counter.
import { afterEach, expect, test, vi } from "vitest";
import {
  COLUMN_ID,
  COLUMN_LAYOUT,
  ExtractSkip,
  Marks,
  State,
  WRAPPED_REASON,
  columnView,
} from "../contracts";
import { MiB, encoder, header, reserved, zip } from "../read/wasm-harness";
import { memoryHandle, records, runRemux } from "./harness";

const mocks = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("comlink", () => ({ expose: mocks.expose, transfer: (value: unknown) => value }));
afterEach(() => {
  vi.unstubAllGlobals();
});

test("two encoders write the rows of the copy in order", async () => {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    name: `rows/${String(index).padStart(2, "0")}.txt`,
    body: encoder.encode(`row ${index} `.repeat(index % 3 === 0 ? 40_000 : 20)),
  }));
  const { bytes } = zip(entries);
  const slots = header(State.COMPLETE, entries.length);
  const out = memoryHandle();
  const hard = 2 ** 31;
  const { report } = await runRemux(
    mocks.expose,
    bytes,
    slots,
    entries.length,
    { kind: "file", handle: out.handle },
    2,
    hard,
  );
  expect(report.outcome, report.error).toBe("complete");
  expect(report.written).toBe(40);
  expect(out.state.closed).toBe(true);
  const copy = records(out.bytes());
  expect(copy.map((record) => record.name)).toEqual(entries.map((entry) => entry.name));
  expect(copy.every((record) => record.method === 93)).toBe(true);
  const offsets = copy.map((record) => record.offset);
  expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  // The workers reserved their memory in the half of the lazy modules.
  expect(reserved(slots).read).toBeGreaterThan(0);
  expect(reserved(slots).read).toBeLessThanOrEqual(hard);
}, 60_000);

test("a row that does not verify is left out before its first byte", async () => {
  const good = encoder.encode("good ".repeat(1000));
  const entries = [
    { name: "a.txt", body: good },
    { name: "b.txt", body: good, size: good.length + 10 },
    { name: "c.txt", body: good },
  ];
  const { bytes } = zip(entries);
  const out = memoryHandle();
  const { report } = await runRemux(
    mocks.expose,
    bytes,
    header(State.COMPLETE, 3),
    3,
    { kind: "file", handle: out.handle },
    1,
    2 ** 31,
  );
  expect(report.outcome, report.error).toBe("complete");
  expect(report.items.map((item) => item.row)).toEqual([1]);
  expect(report.items[0]!.detail).toContain("ended");
  expect(records(out.bytes()).map((record) => record.name)).toEqual(["a.txt", "c.txt"]);
}, 60_000);

test("the copy leaves out a row with an offset that wrapped, with the reason", async () => {
  const entries = [
    { name: "a.txt", body: encoder.encode("a") },
    { name: "marked.txt", body: encoder.encode("marked") },
    { name: "c.txt", body: encoder.encode("c") },
  ];
  const { bytes, page } = zip(entries);
  const marks = columnView(page, COLUMN_LAYOUT[COLUMN_ID.marks]!) as Uint8Array;
  marks[1] = Marks.WRAPPED_OFFSET;
  const out = memoryHandle();
  const { report } = await runRemux(
    mocks.expose,
    bytes,
    header(State.COMPLETE, 3),
    3,
    { kind: "file", handle: out.handle },
    1,
    2 ** 31,
    [marks],
  );
  expect(report.outcome, report.error).toBe("complete");
  expect(report.items).toEqual([
    { row: 1, skip: ExtractSkip.LOCAL_HEADER, detail: WRAPPED_REASON },
  ]);
  expect(records(out.bytes()).map((record) => record.name)).toEqual(["a.txt", "c.txt"]);
}, 60_000);

test("a different row count fails the copy and aborts the file", async () => {
  const entries = [{ name: "a.txt", body: encoder.encode("a") }];
  const { bytes } = zip(entries);
  const out = memoryHandle();
  const { report } = await runRemux(
    mocks.expose,
    bytes,
    header(State.COMPLETE, 2),
    2,
    { kind: "file", handle: out.handle },
    1,
    2 ** 31,
  );
  expect(report.outcome).toBe("failed");
  expect(report.error).toContain("fewer rows");
  expect(out.state.aborted).toBe(true);
  expect(out.state.closed).toBe(false);
  expect(MiB).toBeGreaterThan(0);
}, 60_000);
