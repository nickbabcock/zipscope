import { expect, test } from "vitest";
import { HEADER_BYTES, Header, State } from "../contracts";
import { FakeStore } from "./fake-store";
import { parseInBatches } from "./loop";

function setup(soft: number, hard: number) {
  const store = new FakeStore(5 * 2 ** 20);
  store.queue(["kept"]);
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const slots = new Int32Array(header);
  const answer = Promise.withResolvers<boolean>();
  let bytes = 0;
  let steps = 0;
  let prompts = 0;
  let hardStops = 0;
  const parser = Object.assign(store, {
    finishChecks() {
      bytes += 600;
      steps++;
      return steps === 3;
    },
  });
  const writer = {
    allocatedBytes: () => bytes,
    publish: () => {
      Atomics.store(slots, Header.COMMITTED_ROWS, store.rows());
    },
  };
  let clock = 0;
  const finished = parseInBatches(parser, writer, header, () => (clock += 4), {
    softBytes: soft,
    hardBytes: hard,
    confirm: () => {
      prompts++;
      return answer.promise;
    },
    onHardStop: () => {
      hardStops++;
    },
  });
  return {
    slots,
    finished,
    answer,
    steps: () => steps,
    prompts: () => prompts,
    hardStops: () => hardStops,
  };
}

for (const action of ["continue", "refuse", "cancel"] as const) {
  test(`final checks pause at the soft limit and handle ${action}`, async () => {
    const run = setup(1000, 3000);
    await expect.poll(run.prompts).toBe(1);
    expect(run.steps()).toBe(2);
    expect(Atomics.load(run.slots, Header.STATE)).toBe(State.PAUSED);
    let settled = false;
    void run.finished.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    if (action === "cancel") Atomics.store(run.slots, Header.CANCEL, 1);
    else run.answer.resolve(action === "continue");
    expect(await run.finished).toEqual({
      kind: action === "continue" ? "complete" : "cancelled",
      rows: 1,
    });
    expect(run.steps()).toBe(action === "continue" ? 3 : 2);
    expect(run.prompts()).toBe(1);
    expect(run.hardStops()).toBe(0);
    if (action === "cancel") {
      run.answer.resolve(true);
      await Promise.resolve();
      expect(run.steps()).toBe(2);
      expect(Atomics.load(run.slots, Header.STATE)).toBe(State.CANCELLED);
    }
  });
}

test("the last final check cannot complete above the hard limit", async () => {
  const run = setup(10_000, 1500);
  expect(await run.finished).toMatchObject({
    kind: "failed",
    rows: 1,
    message: expect.stringContaining("memory limit"),
  });
  expect(run.steps()).toBe(3);
  expect(run.prompts()).toBe(0);
  expect(run.hardStops()).toBe(1);
  expect(Atomics.load(run.slots, Header.STATE)).toBe(State.FAILED);
  expect(Atomics.load(run.slots, Header.STORE_KIB)).toBe(2);
});
