// The pass of the read worker over the central directory: it
// reads only committed rows, it ends at a terminal state,
// and it stops at the memory limit of the read worker.
import { expect, test } from "vitest";
import { State } from "../contracts";
import { SCAN_STEP, WayfinderScan } from "./scan";
import type { ScanTarget } from "./scan";

/** A central directory of `records` records. A row costs 48 bytes. */
class FakeTarget implements ScanTarget {
  table = 0;
  scanned = 0;
  constructor(private readonly records: number) {}
  rows(): number {
    return this.table;
  }
  scan(max: number): number {
    const added = Math.min(max, this.records - this.table);
    this.table += added;
    this.scanned += added;
    return added;
  }
  scanState(): number {
    return this.table >= this.records ? 1 : 0;
  }
  tableBytes(): number {
    return Math.ceil(this.table / 65_536) * 3 * 2 ** 20;
  }
  capacity(): number {
    return Math.ceil(this.table / 65_536) * 65_536;
  }
  growth(count: number): number {
    return this.table + count > this.capacity() ? 3 * 2 ** 20 : 0;
  }
}

function source(state: State, committed: number) {
  return { state: () => state, committedRows: () => committed };
}

const MiB = 2 ** 20;
const LIMIT = 512 * MiB;
const KEEP = 64 * MiB;
const always = () => true;

test("reads only the committed rows while parsing continues", () => {
  const target = new FakeTarget(1_000_000);
  const shared = { state: State.PARSING as State, committed: 100 };
  const pass = new WayfinderScan(
    target,
    { state: () => shared.state, committedRows: () => shared.committed },
    always,
    0,
  );
  expect(pass.step()).toBe("more");
  expect(target.rows()).toBe(100);
  // No more rows yet: the pass waits, and reads nothing.
  expect(pass.step()).toBe("wait");
  expect(target.scanned).toBe(100);
  shared.committed = 100 + 2 * SCAN_STEP;
  expect(pass.step()).toBe("more");
  expect(target.rows()).toBe(100 + SCAN_STEP);
  expect(pass.step()).toBe("more");
  expect(pass.step()).toBe("wait");
  expect(target.rows()).toBe(100 + 2 * SCAN_STEP);
});

test("ends at a terminal state with the committed rows only", () => {
  for (const state of [State.COMPLETE, State.CANCELLED, State.FAILED]) {
    // The parse worker stopped at a budget stop after 5,000 of 1,000,000
    // records. A preview must not make wayfinders for the others.
    const target = new FakeTarget(1_000_000);
    const pass = new WayfinderScan(target, source(state, 5000), always, 0);
    let steps = 0;
    while (pass.step() === "more") steps++;
    expect(steps).toBe(1);
    expect(target.rows()).toBe(5000);
    expect(pass.step()).toBe("done");
    expect(target.scanned).toBe(5000);
  }
  // A paused parse can commit more rows, so the pass waits.
  const pass = new WayfinderScan(new FakeTarget(10), source(State.PAUSED, 0), always, 0);
  expect(pass.step()).toBe("wait");
});

test("reaches a requested row at once, but not past it", () => {
  const target = new FakeTarget(1_000_000);
  const pass = new WayfinderScan(target, source(State.FAILED, 200_000), always, 0);
  expect(pass.reach(70_000, always)).toBe(true);
  expect(target.rows()).toBe(70_001);
  expect(pass.reach(10, always)).toBe(true);
  expect(target.scanned).toBe(70_001);
});

test("stops at the memory limit and tells why", () => {
  const target = new FakeTarget(100_000_000);
  let published = 0;
  // The heap is 4 MiB and the table.
  const heap = () => 4 * MiB + target.tableBytes();
  const limit = { bytes: LIMIT };
  const pass = new WayfinderScan(
    target,
    source(State.COMPLETE, 100_000_000),
    (bytes) => heap() + bytes <= limit.bytes,
    KEEP,
    () => published++,
  );
  let steps = 0;
  while (pass.step() === "more") steps++;
  expect(pass.stopped).toMatch(/memory limit leaves no room for the read module after [\d,]+ rows/);
  // The heap stays below the limit, with the decode room free.
  expect(heap() + KEEP).toBeLessThanOrEqual(LIMIT);
  expect(target.rows()).toBeGreaterThan(1_000_000);
  expect(target.rows()).toBeLessThan(100_000_000);
  expect(published).toBe(steps);
  // A row one step past the table then cannot be reached.
  const far = target.rows() + SCAN_STEP - 1;
  const room = (growth: number) => heap() + growth + KEEP <= limit.bytes;
  expect(pass.reach(far, room)).toBe(false);
  expect(pass.reach(0, room)).toBe(true);
  // When the limit leaves more room, the pass can go on.
  limit.bytes = 2 * LIMIT;
  expect(pass.reach(far, room)).toBe(true);
  expect(pass.stopped).toBeUndefined();
});

test("a read reaches its row with only the room that the read needs", () => {
  // The case of preview.spec.ts after a hard stop: the last parse batch
  // took a part of the reserve. The room is less than the room that the
  // background pass keeps free, but a small read fits.
  const target = new FakeTarget(100_000);
  const heap = () => MiB + target.tableBytes();
  const limit = 5.5 * MiB;
  const fits = (bytes: number) => heap() + bytes <= limit;
  const pass = new WayfinderScan(target, source(State.FAILED, 100_000), fits, 4 * MiB);
  expect(pass.step()).toBe("done");
  expect(target.rows()).toBe(0);
  expect(pass.stopped).toBe("The memory limit leaves no room for the read module after 0 rows");
  // The read gives its own room. The growth goes to `fits`.
  const growths: number[] = [];
  const room = (keep: number) => (growth: number) => {
    growths.push(growth);
    return fits(growth + keep);
  };
  expect(pass.reach(1, room(4 * MiB))).toBe(false);
  expect(target.rows()).toBe(0);
  expect(growths).toEqual([3 * MiB]);
  expect(pass.reach(1, room(MiB))).toBe(true);
  expect(pass.stopped).toBeUndefined();
  expect(target.rows()).toBe(2);
  expect(heap() + MiB).toBeLessThanOrEqual(limit);
  // The next chunk of the table does not fit with the room of the read.
  expect(pass.reach(70_000, room(MiB))).toBe(false);
  expect(target.rows()).toBeGreaterThan(2);
  expect(target.rows()).toBeLessThanOrEqual(65_536);
  expect(pass.stopped).toMatch(/after [\d,]+ rows/);
  expect(heap() + MiB).toBeLessThanOrEqual(limit);
});

test("ends when the central directory ends", () => {
  const target = new FakeTarget(10);
  const pass = new WayfinderScan(target, source(State.PARSING, 20), always, 0);
  expect(pass.step()).toBe("more");
  expect(pass.step()).toBe("done");
});

test("the background pass stops when it has the committed rows", async () => {
  const target = new FakeTarget(1_000_000);
  const shared = { committed: 3 * SCAN_STEP };
  const pass = new WayfinderScan(
    target,
    { state: () => State.PARSING, committedRows: () => shared.committed },
    always,
    0,
  );
  let turns = 0;
  const nextTurn = () => {
    turns++;
    return Promise.resolve();
  };
  await pass.resume(nextTurn);
  expect(target.rows()).toBe(3 * SCAN_STEP);
  expect(turns).toBe(3);
  // It waits for nothing. A later call reads the new rows.
  shared.committed += 10;
  await pass.resume(nextTurn);
  expect(target.rows()).toBe(3 * SCAN_STEP + 10);
});
