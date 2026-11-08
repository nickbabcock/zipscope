// Runs the parser in batches and yields between them with a MessageChannel
// self-ping. The ping queues behind messages that are already waiting, so
// Comlink calls run between batches. Not `setTimeout(0)` (nested timers
// clamp to 4ms) and not `scheduler.yield()` (it runs before other tasks).
//
// Before each batch the loop checks the memory budget. At the hard stop it
// fails and keeps the committed rows. At the soft budget it stores `PAUSED`
// and asks the user one time. It still sees the cancel flag while it waits.
import { Header, State } from "../contracts";
import type { ParseOutcome } from "../contracts";
import { INITIAL_BATCH, nextBatchSize } from "./batch";
import { hardStopMessage, MemoryLimitError } from "./budget";
import type { LoopBudget } from "./budget";
import type { MirrorWriter, StoreSource } from "./publish";

/** How often the loop reads the cancel flag while the prompt waits. */
const PAUSED_CANCEL_POLL_MS = 20;

/** The part of the wasm `Parser` that the loop uses. */
export interface BatchParser extends StoreSource {
  /** Parses up to `maxEntries` entries. With `maxBytes`, it stops after
   *  the entry whose estimated allocation makes the total `maxBytes` or
   *  more. */
  parse(maxEntries: number, maxBytes?: number): number;
  state(): number;
  error(): string | undefined;
  /** Makes the views of the tree again. Returns true when one changed. */
  refreshViews(): boolean;
  /** Runs the checks that need all rows, when parsing ends. */
  finishChecks?(budget?: number): boolean | void;
  /** Merges waiting rows into a sorted listing, or builds a listing, for
   *  about `budget` units of work (0: all). Returns
   *  true when the merge ended and the listing changed. */
  mergeViews(budget: number): boolean;
  /** True when a sorted listing waits for `mergeViews`. */
  mergePending(): boolean;
  /** True while a new listing is made in steps by `mergeViews`. */
  viewsBuilding(): boolean;
}

/** The part of the wasm `Parser` that runs the job of the tree order. */
export interface TreeOrderSource {
  /** Runs the job for about `budget` units of work. Returns true when the job
   *  ended and the tree changed. */
  treeOrderStep(budget: number): boolean;
  /** True while the job has work. */
  treeOrderPending(): boolean;
}

/** The time between merges of new rows into a sorted listing. */
export const MERGE_INTERVAL_MS = 250;
/** The time of one step of a merge or a build: half a batch, because the
 *  last step also copies the listing and publishes it. */
export const VIEW_STEP_MS = 4;
/** The budget of one `mergeViews` call, in units of work: about 0.5 ms
 *  natively, 1 ms or less in wasm. */
export const VIEW_CHUNK = 8192;

/**
 * Makes one step of a merge or a build: calls `mergeViews` with small
 * budgets until the step time is used, or the listing changed (the caller
 * then publishes it). The cost of one budget unit changes from stage to
 * stage, so the clock limits the step, not the budget. Returns true when
 * the listing changed.
 */
export function stepViews(
  parser: Pick<BatchParser, "mergeViews" | "mergePending">,
  now: () => number,
  check?: () => void,
): boolean {
  const start = now();
  do {
    check?.();
    const complete = parser.mergeViews(VIEW_CHUNK);
    check?.();
    if (complete) {
      return true;
    }
  } while (parser.mergePending() && now() - start < VIEW_STEP_MS);
  return false;
}

/** The time of one step of the tree order: half of a view step, because the
 *  step of a listing can wait in the queue before a view request too. */
export const TREE_ORDER_STEP_MS = VIEW_STEP_MS / 2;

/**
 * Makes one step of the job of the tree order: calls `treeOrderStep` with small
 * budgets until the step time is used. Returns true when the job ended (the
 * caller then publishes the tree).
 */
export function stepTreeOrder(parser: TreeOrderSource, now: () => number): boolean {
  const start = now();
  do {
    if (parser.treeOrderStep(VIEW_CHUNK)) {
      return true;
    }
  } while (parser.treeOrderPending() && now() - start < TREE_ORDER_STEP_MS);
  return false;
}

/** The writer calls of the loop. The budget calls are optional, so that a
 *  test writer can leave them out. */
export type LoopWriter = Pick<MirrorWriter, "publish"> &
  Partial<
    Pick<
      MirrorWriter,
      "allocatedBytes" | "stopBytes" | "storeBytes" | "healthChanged" | "shows" | "listingBehind"
    >
  >;

/**
 * Parses in batches. `onRowsEnd` is called one time, when the parser read the
 * last row of a parse that ended by itself, with true when the user accepted
 * the soft budget. It returns true when it started a listing.
 */
export function parseInBatches(
  parser: BatchParser,
  writer: LoopWriter,
  header: SharedArrayBuffer,
  now: () => number = () => performance.now(),
  budget?: LoopBudget,
  onRowsEnd?: (approved: boolean) => boolean,
): Promise<ParseOutcome> {
  const view = new Int32Array(header);
  const channel = new MessageChannel();
  const { promise, resolve } = Promise.withResolvers<ParseOutcome>();
  let batch = INITIAL_BATCH;
  let ended = false;
  let final:
    | {
        state: State;
        outcome: ParseOutcome;
        checks: boolean;
        pending?: boolean;
        /** True at the hard stop: no later request can add rows to the listing. */
        stopped?: boolean;
        /** True when the memory limit ended the last merge. */
        noRoom?: boolean;
      }
    | undefined;
  let approved = false;
  let paused = false;
  const committed = () => Atomics.load(view, Header.COMMITTED_ROWS) >>> 0;
  /** The bytes that the hard stop counts. They include the reserve of the
   *  read worker (see `MirrorWriter.stopBytes`). */
  const stopUsed = () => writer.stopBytes?.() ?? writer.allocatedBytes?.() ?? 0;
  /** Throws at the hard stop after the budget refused a growth of the
   *  core wasm. Call it after each wasm call that can allocate. */
  const grown = () => {
    if (budget?.memoryFull?.() === true) {
      const hard = budget?.hardBytes ?? 0;
      throw new MemoryLimitError(Math.max(stopUsed(), hard), hard);
    }
  };
  // A merge into a sorted listing runs in steps of half a batch, so a
  // view request waits for one step at most.
  let merging = false;
  let lastMerge = now();
  /** True after the parser read the last row. */
  let rowsEnded = false;
  /** True when `onRowsEnd` started a listing that can run after the parse. */
  let afterParse = false;

  const finish = (state: State, outcome: ParseOutcome, checks = true) => {
    if (ended || final !== undefined) return;
    final = { state, outcome, checks };
    channel.port2.postMessage(null);
  };
  const finishNow = () => {
    if (final === undefined) return;
    // Only rows that the status counts: the last publish counted them, and they
    // are not in the listing of that publish.
    if ((final.noRoom === true || final.stopped === true) && writer.listingBehind?.() === true) {
      budget?.onRowsMissing?.();
    }
    ended = true;
    Atomics.store(view, Header.STATE, final.state);
    channel.port1.close();
    channel.port2.close();
    resolve(final.outcome);
  };

  const fail = (err: unknown) => {
    const stopped = err instanceof MemoryLimitError;
    if (stopped) budget?.onHardStop?.(err.bytes);
    const message = err instanceof Error ? err.message : String(err);
    paused = false;
    final = {
      state: State.FAILED,
      outcome: { kind: "failed", rows: committed(), message },
      checks: false,
      stopped,
    };
    const store = writer.storeBytes?.() ?? writer.allocatedBytes?.() ?? 0;
    Atomics.store(view, Header.STORE_KIB, Math.ceil(store / 1024));
    writer.healthChanged?.();
    if (stopped && lastMergeWaits()) channel.port2.postMessage(null);
    else finishNow();
  };

  /** True when the listing that shows does not have all rows that the store
   *  can give it, at the end of a parse that stops. Rows wait for a merge, or a
   *  publish failed after a merge. A listing in steps is not part of it: its
   *  request ends it after the parse, or `settleListing` does, so a stop does
   *  not wait for a long sort. */
  const lastMergeWaits = () =>
    final?.noRoom !== true &&
    !parser.viewsBuilding() &&
    (parser.mergePending() || writer.shows?.(parser) === false);

  /**
   * Makes one step of the last merge of a parse that stops, and returns true
   * when more steps follow. Without it, the rows of up to one merge interval
   * would never get into the listing. When the memory limit has no room for
   * it, the listing says that rows are missing.
   */
  const stepLastMerge = (): boolean => {
    if (final === undefined || !lastMergeWaits()) return false;
    try {
      // The core does no more work that grows after a refused growth.
      const full = budget?.memoryFull?.() === true;
      if (parser.mergePending() && !full) {
        if (stepViews(parser, now)) writer.publish(parser, true);
      } else if (writer.shows?.(parser) === false) {
        writer.publish(parser, true);
      }
      if (budget?.memoryFull?.() === true && parser.mergePending()) final.noRoom = true;
    } catch (err) {
      if (!(err instanceof MemoryLimitError)) throw err;
      budget?.onHardStop?.(err.bytes);
      final.noRoom = true;
    }
    if (final.outcome.kind === "failed") final.outcome.rows = committed();
    if (final.noRoom === true) return false;
    channel.port2.postMessage(null);
    return true;
  };

  const cancelled = () => Atomics.load(view, Header.CANCEL) !== 0;
  const cancel = () => {
    paused = false;
    if (final !== undefined) {
      if (final.outcome.kind !== "failed") {
        final.state = State.CANCELLED;
        final.outcome = { kind: "cancelled", rows: committed() };
      }
      final.checks = false;
      finishNow();
    } else finish(State.CANCELLED, { kind: "cancelled", rows: parser.rows() });
  };

  /** Asks the user at the soft budget and waits. A late answer after a
   *  cancel does nothing. */
  const ask = (limits: LoopBudget, bytes: number) => {
    approved = true;
    paused = true;
    Atomics.store(view, Header.STATE, State.PAUSED);
    writer.healthChanged?.();
    const poll = () => {
      if (ended) {
        return;
      }
      const failure = budget?.failure?.();
      if (failure !== undefined) fail(failure);
      else if (cancelled()) {
        cancel();
      } else {
        setTimeout(poll, PAUSED_CANCEL_POLL_MS);
      }
    };
    setTimeout(poll, PAUSED_CANCEL_POLL_MS);
    limits.confirm({ rows: committed(), bytes }).then(
      (proceed) => {
        if (ended) {
          return;
        }
        if (!proceed || cancelled()) {
          cancel();
          return;
        }
        paused = false;
        Atomics.store(view, Header.STATE, State.PARSING);
        writer.healthChanged?.();
        channel.port2.postMessage(null);
      },
      (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        fail(new Error(`The memory prompt failed: ${reason}`));
      },
    );
  };

  /** Returns true when the budget stops or pauses parsing before a batch. */
  const checkBudget = (): boolean => {
    if (budget === undefined) {
      return false;
    }
    const bytes = writer.allocatedBytes?.() ?? 0;
    const stop = stopUsed();
    if (stop >= budget.hardBytes) {
      budget.onHardStop?.(stop);
      finish(
        State.FAILED,
        {
          kind: "failed",
          rows: committed(),
          message: hardStopMessage(budget.hardBytes),
        },
        false,
      );
      if (final !== undefined) final.stopped = true;
      return true;
    }
    if (bytes >= budget.softBytes && !approved) {
      // The listing that shows while the prompt waits has all parsed rows.
      if (parser.mergePending()) {
        merging = true;
        return false;
      }
      ask(budget, bytes);
      return true;
    }
    return false;
  };

  /** The bytes that the next batch can add before the next budget check:
   *  half of the room below the limit, because the mirrors copy the pages
   *  and the arena chunks of wasm. */
  const batchBytes = (): number | undefined => {
    if (budget === undefined) {
      return undefined;
    }
    let room = budget.hardBytes - stopUsed();
    if (!approved) room = Math.min(room, budget.softBytes - (writer.allocatedBytes?.() ?? 0));
    return Math.max(1, Math.floor(room / 2));
  };

  const step = () => {
    if (ended) return;
    const failure = final?.stopped === true ? undefined : budget?.failure?.();
    if (failure !== undefined) {
      fail(failure);
      return;
    }
    if (paused) return;
    if (final !== undefined) {
      if (stepLastMerge()) return;
      if (!final.checks) {
        finishNow();
        return;
      }
      if (cancelled() && final.outcome.kind === "complete") {
        cancel();
        return;
      }
      const bytes = writer.allocatedBytes?.() ?? 0;
      const stop = stopUsed();
      if (budget !== undefined && stop >= budget.hardBytes) {
        fail(new MemoryLimitError(stop, budget.hardBytes));
        return;
      }
      if (final.pending && budget !== undefined && bytes >= budget.softBytes && !approved) {
        ask(budget, bytes);
        return;
      }
      const start = now();
      let complete: boolean;
      do {
        complete = parser.finishChecks?.(VIEW_CHUNK) !== false;
        grown();
        const used = writer.allocatedBytes?.() ?? 0;
        const stop = stopUsed();
        if (budget !== undefined && stop >= budget.hardBytes) {
          fail(new MemoryLimitError(stop, budget.hardBytes));
          return;
        }
        if (!complete && budget !== undefined && used >= budget.softBytes && !approved) {
          if (parser.finishChecks !== undefined) writer.publish(parser);
          final.pending = true;
          ask(budget, used);
          return;
        }
      } while (!complete && now() - start < VIEW_STEP_MS);
      if (parser.finishChecks !== undefined) writer.publish(parser);
      if (complete) finishNow();
      else {
        final.pending = true;
        channel.port2.postMessage(null);
      }
      return;
    }
    // The UI sets the flag. Check it before each batch.
    if (cancelled()) {
      cancel();
      return;
    }
    if (checkBudget()) {
      return;
    }
    const start = now();
    if (merging) {
      if (
        stepViews(parser, now, () => {
          grown();
          const stop = stopUsed();
          if (budget !== undefined && stop >= budget.hardBytes)
            throw new MemoryLimitError(stop, budget.hardBytes);
        })
      ) {
        writer.publish(parser);
      }
      merging = parser.mergePending();
      lastMerge = now();
    } else {
      // A requested listing can start after the last batch was sized.
      // Limit the first batches while it builds, then keep room for the
      // sort and filter work in each refresh.
      const count = parser.viewsBuilding() ? Math.min(batch, INITIAL_BATCH * 8) : batch;
      parser.parse(count, batchBytes());
      grown();
      // Before the publish of the last rows: a listing that is ready at once
      // comes with them, so a small archive has no frame in the other order.
      if (!rowsEnded && parser.state() !== State.PARSING) {
        rowsEnded = true;
        afterParse = onRowsEnd?.(approved) === true;
      }
      parser.refreshViews();
      grown();
      writer.publish(parser);
      const end = now();
      batch = nextBatchSize(count, (end - start) * (parser.mergePending() ? 2 : 1));
      merging = parser.mergePending() && end - lastMerge >= MERGE_INTERVAL_MS;
    }
    const state = parser.state();
    if (
      state !== State.PARSING &&
      parser.mergePending() &&
      !(afterParse && parser.viewsBuilding())
    ) {
      // The final sort: merge the last rows before the end. A large default
      // sort does not hold the end of the parse: the listing that shows has
      // all rows, and the worker ends the sort after the parse.
      merging = true;
      channel.port2.postMessage(null);
    } else if (state === State.COMPLETE) {
      finish(State.COMPLETE, { kind: "complete", rows: parser.rows() });
    } else if (state === State.FAILED) {
      const message = parser.error() ?? "Parsing failed";
      finish(State.FAILED, { kind: "failed", rows: parser.rows(), message });
    } else {
      channel.port2.postMessage(null);
    }
  };

  channel.port1.onmessage = () => {
    try {
      step();
    } catch (err) {
      fail(err);
    }
  };
  Atomics.store(view, Header.STATE, State.PARSING);
  channel.port2.postMessage(null);
  return promise;
}
