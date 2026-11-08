import { createRoot, flush, untrack } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import type { FrameLoop } from "../grid/frame";
import type { ArchiveSession, MemoryPrompt } from "../session";
import { watchHealth } from "./watch";

afterEach(() => {
  vi.useRealTimers();
});

/** A session whose prompt the test sets. */
function fakeSession(first: MemoryPrompt | undefined) {
  let listener: ((prompt: MemoryPrompt | undefined) => void) | undefined;
  let removed = 0;
  const session = {
    reader: { healthGeneration: () => 0, state: () => 0 },
    health: () => new Promise(() => {}),
    opened: new Promise(() => {}),
    finished: new Promise(() => {}),
    onPrompt(next: (prompt: MemoryPrompt | undefined) => void) {
      listener = next;
      next(first);
      return () => {
        removed++;
        listener = undefined;
      };
    },
  };
  return {
    session: session as unknown as ArchiveSession,
    prompt: (prompt: MemoryPrompt | undefined) => listener?.(prompt),
    removed: () => removed,
  };
}

const loop = { add: () => () => {}, schedule: () => {} } as unknown as FrameLoop;

const settle = async () => {
  for (let step = 0; step < 5; step++) await Promise.resolve();
  flush();
};

test("the budget prompt shows at once, follows the session and ends with the owner", async () => {
  vi.useFakeTimers();
  const answers: boolean[] = [];
  const waiting: MemoryPrompt = {
    usage: { rows: 10, bytes: 2 ** 20 },
    answer: (proceed) => answers.push(proceed),
  };
  const fake = fakeSession(waiting);
  const { health, dispose } = createRoot((dispose) => ({
    health: watchHealth(fake.session, loop),
    dispose,
  }));
  flush();
  // The prompt that waited before the subscription shows with no wait.
  expect(untrack(health.pause)?.rows).toBe(10);
  health.answer(true);
  expect(answers).toEqual([true]);
  fake.prompt(undefined);
  await settle();
  expect(health.pause()).toBeUndefined();
  fake.prompt({ usage: { rows: 20, bytes: 2 ** 21 }, answer: () => {} });
  await settle();
  expect(health.pause()?.rows).toBe(20);
  dispose();
  expect(fake.removed()).toBe(1);
});
