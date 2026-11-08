import { describe, expect, test } from "vitest";
import {
  CHUNK_BYTES,
  COLUMN_ID,
  COLUMN_LAYOUT,
  HEADER_BYTES,
  HEALTH_FIELDS,
  Header,
  HealthField,
  Marks,
  PAGE_ROWS,
  State,
} from "../contracts";
import type { Mirror } from "../contracts";
import { budgetState, hardStopMessage, healthReport } from "./budget";
import { FakeStore } from "./fake-store";
import { parseInBatches } from "./loop";
import { MirrorWriter } from "./publish";

const names = (count: number) => Array.from({ length: count }, (_, i) => `f${i}`);

function setup() {
  const store = new FakeStore(CHUNK_BYTES + PAGE_ROWS * 16 + 4096);
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const mirrors: Mirror[] = [];
  const writer = new MirrorWriter(
    header,
    (mirror) => mirrors.push(mirror),
    () => store.memory,
  );
  return { store, header, view: new Int32Array(header), writer, mirrors };
}

test("the pause and the answer change the health generation", async () => {
  const { store, header, view, writer } = setup();
  store.queue(names(5000));
  const answer = Promise.withResolvers<boolean>();
  const budget = budgetState({ soft: 1, hard: 2 ** 31 });
  const done = parseInBatches(store, writer, header, () => 0, {
    softBytes: 1,
    hardBytes: 2 ** 31,
    confirm: (usage) => {
      budget.softReached = true;
      expect(usage.rows).toBe(Atomics.load(view, Header.COMMITTED_ROWS));
      expect(usage.bytes).toBe(writer.allocatedBytes());
      return answer.promise;
    },
  });
  await expect.poll(() => Atomics.load(view, Header.STATE)).toBe(State.PAUSED);
  const generation = Atomics.load(view, Header.HEALTH_GENERATION);
  expect(generation).toBeGreaterThan(0);
  answer.resolve(true);
  await expect(done).resolves.toEqual({ kind: "complete", rows: 5000 });
  expect(Atomics.load(view, Header.HEALTH_GENERATION)).toBeGreaterThan(generation);
  expect(budget.softReached).toBe(true);
});

test("the budget counts the read worker memory", async () => {
  // The store alone stays below the hard stop, but 64 MiB of the read
  // worker take the total past it.
  const run = async (readBytes: number) => {
    const { store, header, view, writer } = setup();
    const hardBytes = writer.storeBytes() + 32 * 2 ** 20;
    Atomics.store(view, Header.READ_KIB, readBytes / 1024);
    expect(writer.allocatedBytes()).toBe(writer.storeBytes() + readBytes);
    store.queue(names(5000));
    const outcome = await parseInBatches(store, writer, header, () => 0, {
      softBytes: 2 ** 31,
      hardBytes,
      confirm: () => Promise.resolve(true),
    });
    // STORE_KIB holds only the store memory.
    expect(Atomics.load(view, Header.STORE_KIB)).toBe(Math.ceil(writer.storeBytes() / 1024));
    return outcome;
  };
  expect(await run(0)).toEqual({ kind: "complete", rows: 5000 });
  const stopped = await run(64 * 2 ** 20);
  expect(stopped.kind).toBe("failed");
  expect(stopped.rows).toBe(0);
});

test("the hard stop keeps the read worker reserve before a preview", async () => {
  const store = new FakeStore(CHUNK_BYTES + PAGE_ROWS * 16 + 4096);
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const view = new Int32Array(header);
  const reserve = 16 * 2 ** 20;
  const writer = new MirrorWriter(
    header,
    () => {},
    () => store.memory,
    2 ** 31,
    reserve,
  );
  // No read worker yet: the reserve counts. The hard stop counts the
  // reservation of the store, which holds the store memory in whole units
  // of 64 KiB (the header takes one unit).
  const reservedStore = writer.reservation.reservations.storeBytes();
  expect(reservedStore).toBeGreaterThanOrEqual(writer.storeBytes());
  expect(reservedStore - writer.storeBytes()).toBeLessThan(2 * 65_536);
  expect(writer.stopBytes()).toBe(reservedStore + reserve);
  expect(writer.allocatedBytes()).toBe(writer.storeBytes());
  // A read worker above the reserve counts with its memory.
  Atomics.store(view, Header.READ_KIB, (20 * 2 ** 20) / 1024);
  expect(writer.stopBytes()).toBe(writer.storeBytes() + 20 * 2 ** 20);
  Atomics.store(view, Header.READ_KIB, 0);
  // The store alone fits below the hard stop, but not with the reserve.
  store.queue(names(5000));
  const outcome = await parseInBatches(store, writer, header, () => 0, {
    softBytes: 2 ** 31,
    hardBytes: writer.storeBytes() + 8 * 2 ** 20,
    confirm: () => Promise.resolve(true),
  });
  expect(outcome.kind).toBe("failed");
  expect(outcome.rows).toBe(0);
});

test("a refused growth of the core wasm stops parsing at the hard stop", async () => {
  // The core sets `memoryFull()` when the shared budget refuses its growth.
  // The rows of that batch are not published: the committed rows are those
  // of the batches before it.
  const { store, header, view, writer } = setup();
  store.queue(names(50_000));
  let calls = 0;
  let full = false;
  let committed = 0;
  const parse = store.parse.bind(store);
  store.parse = (count: number) => {
    calls++;
    if (calls === 3) {
      committed = store.rows();
      full = true;
    }
    return parse(Math.min(count, 1000));
  };
  let stopped: number | undefined;
  const hard = 2 ** 31;
  const outcome = await parseInBatches(store, writer, header, () => 0, {
    softBytes: hard,
    hardBytes: hard,
    confirm: () => Promise.resolve(true),
    memoryFull: () => full,
    onHardStop: (bytes) => (stopped = bytes),
  });
  expect(committed).toBeGreaterThan(0);
  expect(outcome).toEqual({ kind: "failed", rows: committed, message: hardStopMessage(hard) });
  expect(Atomics.load(view, Header.COMMITTED_ROWS)).toBe(committed);
  expect(Atomics.load(view, Header.STATE)).toBe(State.FAILED);
  expect(stopped).toBe(hard);
  // The worker did not parse again after the refusal.
  expect(calls).toBe(3);
});

describe("MirrorWriter", () => {
  test("copies the marks of committed rows again", () => {
    const { store, mirrors } = setup();
    const header = new SharedArrayBuffer(HEADER_BYTES);
    const writer = new MirrorWriter(
      header,
      (mirror) => mirrors.push(mirror),
      () => store.memory,
    );
    store.queue(names(3));
    store.parse(3);
    writer.publish(store);
    store.markRow(0, Marks.DUPLICATE_NAME);
    store.markRow(2, Marks.OVERLAP);
    store.queue(["f3"]);
    store.parse(1);
    writer.publish(store);
    expect(store.markUpdateCount()).toBe(0);
    const page = mirrors.find((mirror) => mirror.kind === "page")!;
    const marks = new Uint8Array(page.buffer, COLUMN_LAYOUT[COLUMN_ID.marks]!.byteOffset, 4);
    expect([...marks]).toEqual([Marks.DUPLICATE_NAME, 0, Marks.OVERLAP, 0]);
  });

  test("changes the health generation only when the vector changes", () => {
    const store = new FakeStore(CHUNK_BYTES + PAGE_ROWS * 8 + 64);
    const header = new SharedArrayBuffer(HEADER_BYTES);
    const writer = new MirrorWriter(
      header,
      () => {},
      () => store.memory,
    );
    const view = new Int32Array(header);
    let vector = new Float64Array(HEALTH_FIELDS);
    const source = Object.assign(store, { health: () => vector });
    writer.publish(source);
    const first = Atomics.load(view, Header.HEALTH_GENERATION);
    writer.publish(source);
    expect(Atomics.load(view, Header.HEALTH_GENERATION)).toBe(first);
    vector = vector.slice();
    vector[HealthField.DUPLICATE_ROWS] = 2;
    writer.publish(source);
    expect(Atomics.load(view, Header.HEALTH_GENERATION)).toBe(first + 1);
    expect(Math.ceil(writer.storeBytes() / 1024)).toBe(Atomics.load(view, Header.STORE_KIB));
  });
});

test("healthReport reads the vector, the error and the budget", () => {
  const vector = new Float64Array(HEALTH_FIELDS);
  vector[HealthField.DECLARED_ENTRIES] = 7;
  vector[HealthField.COUNT_MISMATCH] = 1;
  vector[HealthField.COUNT_WRAPPED] = 1;
  vector[HealthField.OVERLAP_DATA_ROWS] = 8;
  vector[HealthField.OVERLAP_DATA_EXAMPLE] = 6;
  vector[HealthField.INTO_DIRECTORY_ROWS] = 6;
  vector[HealthField.INTO_DIRECTORY_EXAMPLE] = 4;
  vector[HealthField.DUPLICATE_ROWS] = 2;
  vector[HealthField.DUPLICATE_EXAMPLE] = 1;
  vector[HealthField.BOMB_EXAMPLE] = -1;
  vector[HealthField.OVERLAP_EXAMPLE] = -1;
  vector[HealthField.DEPTH_CAP_EXAMPLE] = -1;
  vector[HealthField.FOLDER_CAP_EXAMPLE] = -1;
  vector[HealthField.CONTROL_NAME_ROWS] = 4;
  vector[HealthField.CONTROL_NAME_EXAMPLE] = 2;
  vector[HealthField.WRAPPED_ROWS] = 5;
  vector[HealthField.WRAPPED_EXAMPLE] = 3;
  vector[HealthField.PRELUDE_BYTES] = 512;
  vector[HealthField.OVERLAPS_CHECKED] = 1;
  vector[HealthField.DUPLICATES_CHECKED] = 1;
  vector[HealthField.ENCRYPTED] = 3;
  vector[HealthField.ENCRYPTED + 3] = 4;
  const budget = budgetState({ soft: 10, hard: 20 });
  budget.softReached = true;
  budget.storeBytes = 12;
  const report = healthReport(vector, 5, "bad record", budget);
  expect(report).toEqual({
    rows: 5,
    declaredEntries: 7,
    countMismatch: true,
    countWrapped: true,
    duplicates: { rows: 2, example: 1 },
    bombs: { rows: 0, example: -1 },
    overlaps: { rows: 0, example: -1 },
    overlapData: { rows: 8, example: 6 },
    intoDirectory: { rows: 6, example: 4 },
    depthCap: { rows: 0, example: -1 },
    folderCap: { rows: 0, example: -1 },
    controlNames: { rows: 4, example: 2 },
    wrapped: { rows: 5, example: 3 },
    overlapsChecked: true,
    duplicatesChecked: true,
    preludeBytes: 512,
    epilogueBytes: 0,
    endRecord: {
      commentDeclared: 0,
      commentPresent: 0,
      skipped: 0,
      others: 0,
      unchecked: 0,
      secondDirectory: false,
      declaredDirectory: 0,
      foundDirectory: 0,
      earlierRecords: 0,
      earlierRecord: 0,
      earlierDirectory: 0,
    },
    encrypted: { zipCrypto: 3, aes128: 0, aes192: 0, aes256: 4, other: 0, aesUnknown: 0 },
    error: "bad record",
    budget: {
      limits: { soft: 10, hard: 20 },
      storeBytes: 12,
      softReached: true,
      declined: false,
      hardReached: false,
      rowsMissing: false,
    },
  });
});
