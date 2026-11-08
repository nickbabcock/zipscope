import { createMemo, createSignal, from, onCleanup } from "solid-js";
import { State } from "../contracts";
import type { HealthReport, ParseOutcome } from "../contracts";
import type { FrameLoop } from "../grid/frame";
import type { ArchiveSession } from "../session";
import { budgetPrompt } from "./findings";
import type { BudgetPause } from "./findings";

/**
 * Follows the health of an archive. It asks the worker for the health
 * report when `HEALTH_GENERATION` changes, at most every 250 ms, and when
 * parsing ends. It shows the memory-budget prompt while parsing is paused.
 * Call it in an owner: it stops when its owner is disposed.
 */
export function watchHealth(session: ArchiveSession, loop: FrameLoop) {
  const [report, setReport] = createSignal<HealthReport>();
  const [outcome, setOutcome] = createSignal<ParseOutcome>();
  let seen = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fetching = false;
  let again = false;
  let last = Number.NEGATIVE_INFINITY;
  let stopped = false;

  const fetch = () => {
    timer = undefined;
    if (fetching) {
      again = true;
      return;
    }
    fetching = true;
    last = performance.now();
    session
      .health()
      .then(
        (value) => {
          if (!stopped) {
            setReport(value);
            // The marks of committed rows can change with the report.
            loop.schedule();
          }
        },
        () => {},
      )
      .finally(() => {
        fetching = false;
        if (again) {
          again = false;
          request();
        }
      });
  };
  const request = () => {
    if (timer === undefined && !stopped) {
      timer = setTimeout(fetch, Math.max(0, 250 - (performance.now() - last)));
    }
  };

  // The frame loop runs while parsing. Check the header on each frame.
  const check = () => {
    const reader = session.reader;
    const generation = reader.healthGeneration();
    if (generation !== seen) {
      seen = generation;
      request();
    }
    return { complete: true, commit() {} };
  };
  const remove = loop.add({ render: check });
  // The worker asks through the Comlink sink and waits for the answer.
  // `onPrompt` calls the listener at once with the current prompt, and
  // `from` serves that first value without a loading state. The owner
  // ends the subscription.
  let answer: ((proceed: boolean) => void) | undefined;
  const pause = createMemo(() =>
    from<BudgetPause | undefined>((next) =>
      session.onPrompt((prompt) => {
        answer = prompt?.answer;
        if (prompt === undefined) {
          next(undefined);
          return;
        }
        request();
        const { rows, bytes } = prompt.usage;
        next({ rows, storeBytes: bytes, text: budgetPrompt(rows, bytes) });
      }),
    ),
  );
  // After the answer, the worker stores PARSING. Then the frame loop must
  // run again.
  const resumeFrames = () => {
    if (stopped) {
      return;
    }
    if (session.reader.state() === State.PAUSED) {
      setTimeout(resumeFrames, 16);
    } else {
      loop.schedule();
    }
  };
  session.opened.then(request, () => {});
  session.finished.then((end) => {
    if (stopped) return;
    setOutcome(end);
    request();
  });

  onCleanup(() => {
    stopped = true;
    remove();
    clearTimeout(timer);
  });

  return {
    report,
    outcome,
    pause,
    answer(proceed: boolean) {
      answer?.(proceed);
      resumeFrames();
    },
  };
}
