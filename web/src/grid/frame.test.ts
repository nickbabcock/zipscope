import { describe, expect, test } from "vitest";
import { State } from "../contracts";
import type { ViewSet } from "../store/reader";
import { drawFrame, FrameLoop } from "./frame";
import type { Frame, FrameSnapshot, Prepared } from "./frame";

/** The view part of a source, with no views. */
const noViews = {
  visibleFolders: () => 0,
  views: (): ViewSet | undefined => undefined,
  stable: () => true,
  opened: () => true,
};

/** A render that reads nothing and is complete. */
const empty = (): Prepared => ({ complete: true, commit: () => {} });

/** A source where the worker completes between two reads of one frame. */
function completesDuringFrame(rows: number) {
  let state: State = State.PARSING;
  let committed = rows - 10;
  return {
    ...noViews,
    state: () => state,
    committedRows: () => committed,
    visibleRows: () => {
      // The worker publishes the last batch and completes here.
      committed = rows;
      state = State.COMPLETE;
      return committed;
    },
  };
}

/** A source whose generation changes by `bump` during each read. */
function publishing(bumps: () => boolean) {
  let generation = 1;
  return {
    state: () => State.COMPLETE,
    committedRows: () => 5,
    visibleRows: () => 5,
    visibleFolders: () => 1,
    views: () => ({ generation }) as ViewSet,
    stable: (views: ViewSet) => views.generation === generation,
    opened: () => true,
    read: (frame: Frame) => {
      const seen = frame.views!.generation;
      if (bumps()) {
        generation++;
      }
      return seen;
    },
  };
}

describe("drawFrame", () => {
  test("draws one more frame when parsing completes during a frame", () => {
    const source = completesDuringFrame(100);
    const reports: FrameSnapshot[] = [];
    const again = drawFrame(source, empty, (snapshot) => reports.push(snapshot));
    expect(reports[0]?.state).toBe(State.PARSING);
    expect(again).toBe(true);
    expect(drawFrame(source, empty, (snapshot) => reports.push(snapshot))).toBe(false);
    expect(reports[1]).toEqual({ state: State.COMPLETE, committed: 100, visible: 100 });
  });

  test("continues while rows wait for their buffers", () => {
    const source = {
      ...noViews,
      state: () => State.COMPLETE,
      committedRows: () => 100,
      visibleRows: () => 40,
    };
    expect(drawFrame(source, empty, () => {})).toBe(true);
  });

  test("stops after a terminal state with every row visible", () => {
    for (const state of [State.COMPLETE, State.CANCELLED, State.FAILED]) {
      const source = {
        ...noViews,
        state: () => state,
        committedRows: () => 5,
        visibleRows: () => 5,
      };
      expect(drawFrame(source, empty, () => {})).toBe(false);
    }
  });

  test("commits the second read when the set changes during the first", () => {
    let reads = 0;
    const source = publishing(() => ++reads === 1);
    const committed: number[] = [];
    const again = drawFrame(
      source,
      (frame) => {
        const seen = source.read(frame);
        return { complete: true, commit: () => committed.push(seen) };
      },
      () => {},
    );
    expect(reads).toBe(2);
    expect(committed).toEqual([2]);
    expect(again).toBe(false);
  });

  test("commits nothing when the set changes during every read", () => {
    let reads = 0;
    const source = publishing(() => {
      reads++;
      return true;
    });
    const committed: number[] = [];
    const again = drawFrame(
      source,
      (frame) => {
        const seen = source.read(frame);
        return { complete: true, commit: () => committed.push(seen) };
      },
      () => {},
    );
    expect(reads).toBe(3);
    expect(committed).toEqual([]);
    expect(again).toBe(true);
  });

  test("continues while a row cannot show yet, and settles only when complete", () => {
    for (const [state, settling] of [
      [State.PARSING, true],
      [State.CANCELLED, true],
      [State.COMPLETE, false],
    ] as const) {
      const source = {
        ...noViews,
        state: () => state,
        committedRows: () => 5,
        visibleRows: () => 5,
      };
      let seen: boolean | undefined;
      const again = drawFrame(
        source,
        (frame) => {
          seen = frame.settling;
          return { complete: false, commit: () => {} };
        },
        () => {},
      );
      expect(seen).toBe(settling);
      expect(again).toBe(true);
    }
  });

  test("stops after a failed open, which gives no views", () => {
    const source = {
      ...noViews,
      opened: () => false,
      state: () => State.FAILED,
      committedRows: () => 0,
      visibleRows: () => 0,
    };
    // The panes have no views, so they are not complete.
    const waiting = (): Prepared => ({ complete: false, commit: () => {} });
    expect(drawFrame(source, waiting, () => {})).toBe(false);
    // Before the open fails, the loop continues.
    expect(drawFrame({ ...source, state: () => State.OPENING }, waiting, () => {})).toBe(true);
  });
});

describe("the resize observer of the loop", () => {
  test("draws one time for a frame where many elements change size", () => {
    const callbacks: ResizeObserverCallback[] = [];
    const observed: Element[] = [];
    const saved = {
      ResizeObserver: globalThis.ResizeObserver,
      raf: globalThis.requestAnimationFrame,
      caf: globalThis.cancelAnimationFrame,
    };
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe(element: Element) {
        observed.push(element);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    globalThis.requestAnimationFrame = () => 1;
    globalThis.cancelAnimationFrame = () => {};
    try {
      const source = {
        ...noViews,
        state: () => State.COMPLETE,
        committedRows: () => 0,
        visibleRows: () => 0,
      };
      const loop = new FrameLoop(source, () => {});
      let draws = 0;
      loop.add({
        render: () => {
          draws++;
          return { complete: true, commit: () => {} };
        },
      });
      const tree = {} as Element;
      const table = {} as Element;
      const header = {} as Element;
      const resized: string[] = [];
      loop.observeResize([tree], () => resized.push("tree"));
      loop.observeResize([table, header], () => resized.push("table"));
      // One observer for all elements.
      expect(callbacks).toHaveLength(1);
      expect(observed).toEqual([tree, table, header]);
      draws = 0;
      const entries = [tree, table, header].map((target) => ({ target }));
      callbacks[0]!(entries as unknown as ResizeObserverEntry[], {} as ResizeObserver);
      // Each handler runs one time, and the loop draws one time.
      expect(resized).toEqual(["tree", "table"]);
      expect(draws).toBe(1);
    } finally {
      globalThis.ResizeObserver = saved.ResizeObserver;
      globalThis.requestAnimationFrame = saved.raf;
      globalThis.cancelAnimationFrame = saved.caf;
    }
  });
});
