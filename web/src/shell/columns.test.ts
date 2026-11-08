import { createEffect, createRoot, createSignal, flush } from "solid-js";
import { expect, test } from "vitest";
import { tableMinWidth } from "../grid/columns";
import { createColumns, sameColumns } from "./columns";

function setup(width: number) {
  const [room, setRoom] = createSignal<number | undefined>(width);
  const [previewOpen, setPreviewOpen] = createSignal(false);
  const runs: number[] = [];
  const columns = createRoot(() => {
    const columns = createColumns({ narrow: () => false, previewOpen, room });
    // As the table effect: it must run only when the set changes.
    createEffect(columns.hidden, (next) => {
      runs.push(next.size);
    });
    return columns;
  });
  flush();
  return { columns, runs, setRoom, setPreviewOpen };
}

test("a resize that keeps the hidden set does not run its readers", () => {
  const { columns, runs, setRoom } = setup(2000);
  expect(columns.hidden().size).toBe(0);
  for (const width of [1990, 1500, 1400]) {
    setRoom(width);
    flush();
  }
  expect(runs).toEqual([0]);
});

test("a table without room keeps one hidden set while the width moves", () => {
  // fitColumns makes a new set on each call when it hides more columns.
  const narrow = tableMinWidth(new Set()) - 1;
  const { columns, runs, setRoom } = setup(narrow);
  const first = columns.hidden();
  const blocked = columns.blocked();
  expect(first.size).toBeGreaterThan(0);
  setRoom(narrow - 1);
  flush();
  expect(columns.hidden()).toBe(first);
  expect(columns.blocked()).toBe(blocked);
  expect(runs).toHaveLength(1);
  // More room shows the columns again.
  setRoom(5000);
  flush();
  expect(columns.hidden().size).toBe(0);
  expect(runs).toHaveLength(2);
});

test("the preview has its own choice", () => {
  const { columns, setPreviewOpen } = setup(5000);
  columns.pick("modified", false);
  flush();
  expect([...columns.hidden()]).toEqual(["modified"]);
  setPreviewOpen(true);
  flush();
  expect([...columns.hidden()].sort()).toEqual(["compressed", "method"]);
});

test("sameColumns compares the keys", () => {
  expect(sameColumns(new Set(["size"]), new Set(["size"]))).toBe(true);
  expect(sameColumns(new Set(["size"]), new Set(["ratio"]))).toBe(false);
  expect(sameColumns(new Set(), new Set(["ratio"]))).toBe(false);
});
