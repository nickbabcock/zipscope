import { createEffect, createRoot, createSignal, flush } from "solid-js";
import { describe, expect, test } from "vitest";
import { listedTarget } from "./target";
import type { PreviewTarget } from "./target";

/** Makes a listed target with an effect that records each value, as the
 *  preview loads each target. */
function setup(first: PreviewTarget | undefined, rows: number) {
  const [target, setTarget] = createSignal(first);
  const [count, setCount] = createSignal(rows);
  const loads: (PreviewTarget | undefined)[] = [];
  const listed = createRoot(() => {
    const accessor = listedTarget(target, count);
    createEffect(accessor, (value) => {
      loads.push(value);
    });
    return accessor;
  });
  flush();
  return { listed, loads, setTarget, setCount };
}

describe("listedTarget", () => {
  test("shows a target when its row arrives", () => {
    const { listed, loads, setCount } = setup({ row: 5, name: "late.txt" }, 3);
    expect(listed()).toBeUndefined();
    expect(loads).toEqual([undefined]);
    setCount(5);
    flush();
    expect(listed()).toBeUndefined();
    setCount(6);
    flush();
    expect(listed()).toEqual({ row: 5, name: "late.txt" });
    expect(loads).toEqual([undefined, { row: 5, name: "late.txt" }]);
  });

  test("does not load again when more rows arrive", () => {
    const { loads, setCount } = setup({ row: 0, name: "a.txt" }, 1);
    setCount(100);
    flush();
    expect(loads).toEqual([{ row: 0, name: "a.txt" }]);
  });

  test("does not load again for an equal target", () => {
    const { loads, setTarget } = setup({ row: 2, name: "b.txt" }, 10);
    setTarget({ row: 2, name: "b.txt" });
    flush();
    expect(loads).toHaveLength(1);
    setTarget({ row: 3, name: "b.txt" });
    flush();
    setTarget(undefined);
    flush();
    expect(loads).toEqual([{ row: 2, name: "b.txt" }, { row: 3, name: "b.txt" }, undefined]);
  });
});
