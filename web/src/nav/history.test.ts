import { describe, expect, test } from "vitest";
import { frontState, Navigator, readState, REPLACE_INTERVAL } from "./history";
import type { HistoryLike, NavState, Timers } from "./history";

/** A history stack like the one of a browser tab. `go` pops at once. */
class FakeHistory implements HistoryLike {
  entries: unknown[] = [null];
  at = 0;
  replaces = 0;
  popped: unknown[] = [];

  get state(): unknown {
    return this.entries[this.at];
  }
  pushState(data: unknown): void {
    this.entries = [...this.entries.slice(0, this.at + 1), structuredClone(data)];
    this.at++;
  }
  replaceState(data: unknown): void {
    this.entries[this.at] = structuredClone(data);
    this.replaces++;
  }
  go(delta: number): void {
    this.at = Math.max(0, Math.min(this.entries.length - 1, this.at + delta));
    this.popped.push(this.state);
  }
}

class FakeTimers implements Timers {
  time = 1000;
  private waiting: { at: number; callback: () => void }[] = [];
  set(callback: () => void, ms: number): unknown {
    const timer = { at: this.time + ms, callback };
    this.waiting.push(timer);
    return timer;
  }
  clear(handle: unknown): void {
    this.waiting = this.waiting.filter((timer) => timer !== handle);
  }
  now(): number {
    return this.time;
  }
  advance(ms: number): void {
    this.time += ms;
    for (const timer of this.waiting.filter((timer) => timer.at <= this.time)) {
      this.clear(timer);
      timer.callback();
    }
  }
}

const setup = () => {
  const history = new FakeHistory();
  const timers = new FakeTimers();
  const navigator = new Navigator(history, timers);
  return { history, timers, navigator };
};

const entry = (history: FakeHistory, at = history.at) => history.entries[at] as NavState;

describe("Navigator", () => {
  test("the first entry becomes the front door", () => {
    const { history, navigator } = setup();
    expect(entry(history)).toEqual(frontState());
    expect(navigator.state.session).toBe("");
  });

  test("keeps a state of this app after a reload", () => {
    const history = new FakeHistory();
    history.entries = [{ ...frontState(4), session: "old", folder: 3 }];
    const navigator = new Navigator(history, new FakeTimers());
    expect(navigator.state).toMatchObject({ index: 4, session: "old", folder: 3 });
    expect(navigator.showsSession("new")).toBe(false);
  });

  test("the first entry of a session names its archive", () => {
    const { history, navigator } = setup();
    navigator.openSession("a", "demo.zip", true);
    navigator.push({ folder: 2 });
    expect(history.state).toMatchObject({ session: "a", name: "demo.zip", demo: true });
    // A state from before the name was recorded has no name.
    const { name: _name, demo: _demo, ...old } = frontState();
    expect(readState(old)).toMatchObject({
      name: null,
      demo: false,
    });
  });

  test("a push adds an entry and drops the forward entries", () => {
    const { history, navigator } = setup();
    navigator.openSession("a");
    navigator.push({ folder: 2 });
    navigator.push({ folder: 5 });
    expect(history.entries).toHaveLength(4);
    history.go(-1);
    navigator.pop(history.state);
    navigator.push({ folder: 7 });
    expect(history.entries.map((value) => (value as NavState).folder)).toEqual([null, null, 2, 7]);
    expect(entry(history).index).toBe(3);
  });

  test("replaces at most one time in the interval, with the last state", () => {
    const { history, timers, navigator } = setup();
    navigator.openSession("a");
    const before = history.replaces;
    for (let step = 0; step < 50; step++) {
      navigator.replace({ scroll: step });
      timers.advance(10);
    }
    // 500 ms: the push at the start, then one write in each interval.
    expect(history.replaces - before).toBeLessThanOrEqual(500 / REPLACE_INTERVAL + 1);
    timers.advance(REPLACE_INTERVAL);
    expect(entry(history).scroll).toBe(49);
    expect(history.entries).toHaveLength(2);
  });

  test("a push first writes the replace that waits to the old entry", () => {
    const { history, navigator } = setup();
    navigator.openSession("a");
    navigator.replace({ query: "abc" });
    navigator.push({ folder: 4, query: "" });
    expect(entry(history, 1).query).toBe("abc");
    expect(entry(history, 2)).toMatchObject({ folder: 4, query: "" });
  });

  test("Back drops the replace that waits, so it never goes to the new entry", () => {
    const { history, timers, navigator } = setup();
    navigator.openSession("a");
    navigator.push({ folder: 4 });
    navigator.replace({ query: "late" });
    history.go(-1);
    const state = navigator.pop(history.state);
    timers.advance(REPLACE_INTERVAL * 2);
    expect(state?.query).toBe("");
    expect(entry(history).query).toBe("");
  });

  test("returns to the first entry of the session from the front door", () => {
    const { history, navigator } = setup();
    navigator.openSession("a");
    navigator.push({ folder: 4 });
    history.go(-2);
    expect(navigator.pop(history.state)?.session).toBe("");
    expect(navigator.returnToSession()).toBe(true);
    expect(history.popped.at(-1)).toMatchObject({ session: "a", folder: null });
  });

  test("ignores states of other apps", () => {
    expect(readState({ index: 1 })).toBeUndefined();
    expect(readState(null)).toBeUndefined();
    const { navigator } = setup();
    expect(navigator.pop({ other: true })).toBeUndefined();
  });
});
