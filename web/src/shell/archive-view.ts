// The state of one open archive as the shell shows it: the listed rows,
// the parse status, the store memory, the sort and the frame loop.
//
// App makes one view for each session, in the owner of the session. When
// the archive closes, App disposes that owner: the session closes, the
// frame loop stops and the signals go. A late callback of the old worker
// then writes to a signal that nothing reads, so the callbacks need no
// check for the current session.
import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  from,
  onCleanup,
  untrack,
} from "solid-js";
import { NONE, SortColumn, State } from "../contracts";
import type { EntryCheck } from "../contracts";
import { FrameLoop } from "../grid/frame";
import type { FrameSnapshot } from "../grid/frame";
import {
  crcFindings,
  findings,
  localHeaderFindings,
  mergeFindings,
  refusedText,
  withoutBudgetNotice,
} from "../health/findings";
import { hardStopMessage } from "../parse/budget";
import { watchHealth } from "../health/watch";
import type { SampleUse } from "../front/sample-names";
import type { ArchiveSession } from "../session";
import type { ViewSet } from "../store/reader";
import { ARCHIVE_ORDER, isBestMatch, listingSort, sameSort } from "../view/sort";
import { isParsing, OPENING, phaseProgress } from "./phase";
import type { ParsePhase } from "./phase";
import type { ListedSort, TableSort } from "../view/sort";

export type ArchiveView = ReturnType<typeof createArchiveView>;

/** The time before the strip says that a search or a sort runs. */
const STATUS_DELAY_MS = 250;

/** Makes the view of a session. Call it in an owner that follows the
 *  session, so that the view goes with the session. */
export function createArchiveView(
  session: ArchiveSession,
  { reveal }: { reveal?: SampleUse } = {},
) {
  const [rows, setRows] = createSignal(0);
  /** The entry count that the archive declares, or undefined. */
  const [declared, setDeclared] = createSignal<number>();
  const [storeBytes, setStoreBytes] = createSignal(0);
  const [phase, setPhase] = createSignal<ParsePhase>(OPENING);
  /** The order of the listing that shows. The worker publishes it with
   *  the views, and each frame reads it from the set that it draws, so it
   *  always agrees with the rows. */
  const [listedSort, setListedSort] = createSignal<ListedSort>(ARCHIVE_ORDER, {
    equals: sameSort,
  });
  /** True when the listing that shows has rows. */
  const [listedRows, setListedRows] = createSignal(false);
  /** The sort that the column headers show: the sort of the request in
   *  progress, else the sort of the listing. The request value goes when
   *  the request settles, so a refused sort cannot stay in the header. */
  const [sort, setRequestedSort] = createOptimistic<ListedSort>(() => listedSort());
  /** Calls that wait for the next drawn frame. */
  const frameWaits: (() => void)[] = [];
  /** Resolves after the next frame read the views. */
  const nextFrame = () =>
    new Promise<void>((resolve) => {
      frameWaits.push(resolve);
      loop.schedule();
    });
  /** Sorts the listing. Rejects when the worker refused the request. The
   *  action does not write the sort of the listing: the frame reads it
   *  from the published views. The action waits for the frame after the
   *  request, so the header goes from the requested sort to the listing
   *  sort with no frame of the old sort between them. */
  const requestSort = action(function* (next: TableSort) {
    setRequestedSort(next);
    yield session.sort(next.column, next.descending);
    yield nextFrame();
  });
  /** True after a sort request of the user or of a kept history entry. Then
   *  the default sort and the best-match order do not apply. */
  const [sortChosen, setSortChosen] = createSignal(false);
  /** Ends when the last sort request ended, also when the worker refused it. */
  let sorted: Promise<unknown> = Promise.resolve();
  const sortBy = (next: TableSort) => {
    setSortChosen(true);
    const request = requestSort(next);
    sorted = request.catch(() => {});
    return request;
  };
  /** Changes when a chosen sort lists the rows in a new order. The default
   *  sort lands with no change: it keeps the scroll position of the user. */
  let chosenOrders = 0;
  const listingOrder = createMemo(() => {
    listedSort();
    return untrack(sortChosen) ? ++chosenOrders : chosenOrders;
  });
  const [healthOpen, setHealthOpen] = createSignal(reveal === "health");
  /** True while the worker ends the default sort after the parse. */
  const [settling, setSettling] = createSignal(false);
  /** The request that took longer than `STATUS_DELAY_MS`, so a short one
   *  does not flash a text in the strip: a search when one runs, else a sort. */
  const working = createMemo(() =>
    from<"search" | "sort" | false>((next) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let late = false;
      let kind: "search" | "sort" = "sort";
      const stop = session.onBusy((count, searching) => {
        kind = searching ? "search" : "sort";
        if (count === 0) {
          clearTimeout(timer);
          timer = undefined;
          late = false;
          next(false);
        } else if (late) {
          next(kind);
        } else {
          timer ??= setTimeout(() => {
            late = true;
            next(kind);
          }, STATUS_DELAY_MS);
        }
      });
      return () => {
        clearTimeout(timer);
        stop();
      };
    }),
  );

  /** The rows of the last frame. The frame loop is not reactive, so it
   *  reads this variable, not the signal. */
  let shown = 0;
  /** True when the parse ended. Then a frame does not change the phase. */
  let ended = false;
  /** True when the worker reported a complete parse. */
  let complete = false;
  /** The time from the open to the frame that showed all rows. */
  let listedMs: number | undefined;
  const end = (last: ParsePhase) => {
    ended = true;
    setPhase(last);
  };
  const onFrame = ({ state, committed, visible }: FrameSnapshot) => {
    if (visible !== shown) {
      if (shown === 0 && visible > 0) {
        performance.mark("zipscope:first-rows");
      }
      shown = visible;
      setRows(visible);
    }
    setStoreBytes(session.reader.storeBytes() + session.writeBytes());
    if (ended) {
      return;
    }
    if (state === State.COMPLETE && visible === committed) {
      if (listedMs === undefined) {
        performance.mark("zipscope:listed");
        listedMs = performance.measure(
          "zipscope:listing",
          "zipscope:open",
          "zipscope:listed",
        ).duration;
      }
      // The parse ends with the outcome of the worker.
      if (complete) {
        end({ kind: "listed", ms: listedMs });
      } else {
        setPhase({ kind: "listing", progress: 1 });
      }
    } else if (state === State.PAUSED) {
      setPhase({ kind: "paused", progress: session.reader.progress() });
    } else if (state === State.PARSING) {
      setPhase({ kind: "listing", progress: session.reader.progress() });
    }
  };
  const loop = new FrameLoop(session.reader, onFrame);
  /** The query whose first result Enter waits for, or undefined. */
  let firstRowFor: string | undefined;
  /**
   * Enter in the search field. It acts on the results of the query in the
   * field, and it opens nothing. When they show, the table selects their first
   * row and takes the focus, in one frame. Until they show, the rows on the
   * screen are of another listing, so the key waits with the focus in the field:
   * a new key or a move of the focus ends the wait. With no results, nothing
   * occurs. After this one action, a later row of a parse does not move the
   * selection: it stays with its row.
   */
  const askFirstRow = (query: string) => {
    firstRowFor = query;
    loop.schedule();
  };
  const dropFirstRow = () => {
    firstRowFor = undefined;
  };
  /** True when this frame, with the views `set`, shows the results that Enter
   *  waits for: the query in the field is the query of the listing, no search
   *  or sort runs, and an earlier frame already read this order, because a new
   *  order starts the table at the top on the frame after it. Each frame calls
   *  it, also on a folder listing, so a query that changed ends the wait. */
  const firstRowReady = (query: string, set: ViewSet) => {
    if (firstRowFor === undefined) return false;
    if (firstRowFor !== query) {
      firstRowFor = undefined;
      return false;
    }
    return (
      set.folder === NONE &&
      session.idle() &&
      session.shownQuery() === query &&
      sameSort(untrack(listedSort), listingSort(set.sort))
    );
  };
  // Each frame reads the sort of the set that it draws.
  const removeSortPart = loop.add({
    render: (frame) => ({
      complete: true,
      commit() {
        if (frame.views !== undefined) {
          setListedSort(listingSort(frame.views.sort));
          setListedRows(frame.views.permutation.length > 0);
        }
        // Enter waits for a later frame.
        if (firstRowFor !== undefined) loop.schedule();
        for (const resolve of frameWaits.splice(0)) resolve();
      },
    }),
  });
  // A view request settles after the worker published the views. After
  // parsing, the loop is stopped, so draw a frame.
  session.onPublished = () => loop.schedule();
  // The read worker memory counts in the status bar also after the frame
  // loop stops.
  const memory = () => setStoreBytes(session.reader.storeBytes() + session.writeBytes());
  session.read.onMemory = memory;
  // The write workers of a zstd copy count too.
  session.onWriteMemory = memory;
  onCleanup(() => {
    removeSortPart();
    session.onViewRequest = undefined;
    loop.stop();
    session.onPublished = undefined;
    session.read.onMemory = undefined;
    session.onWriteMemory = undefined;
  });

  session.opened.then(
    (info) => setDeclared(info.entriesHint),
    // `finished` also reports an open error, so this rejection needs no
    // other handling.
    () => {},
  );
  // A complete parse is "listed" when also a frame showed all its rows.
  session.finished.then((outcome) => {
    setStoreBytes(session.reader.storeBytes() + session.writeBytes());
    setSettling(true);
    session
      .settleListing()
      .catch(() => {})
      .finally(() => setSettling(false));
    session.settleTreeOrder().catch(() => {});
    if (ended) {
      return;
    }
    if (outcome.kind !== "complete") {
      end(outcome);
    } else if (listedMs !== undefined) {
      end({ kind: "listed", ms: listedMs });
    } else {
      complete = true;
    }
  });

  const health = watchHealth(session, loop);
  /** Local headers that the read worker checked, by row: mismatch bits. */
  const [checked, setChecked] = createSignal<ReadonlyMap<number, number>>(new Map());
  /** Records the local header check of a row. Two checks can come before
   *  the next flush, so the update starts from the staged map. */
  const onCheck = (row: number, check: EntryCheck) => {
    setChecked((last) =>
      last.get(row) === check.mismatches ? last : new Map(last).set(row, check.mismatches),
    );
  };
  /** The rows whose data did not agree with its CRC-32 at preview. */
  const [crcFailures, setCrcFailures] = createSignal<ReadonlySet<number>>(new Set<number>());
  const onCrcFailure = (row: number) => {
    setCrcFailures((last) => (last.has(row) ? last : new Set(last).add(row)));
  };
  /** The health findings. The health strip and the Archive panel read
   *  this one memo. While the memory prompt shows, the finding of the
   *  soft budget does not: the prompt tells the same. */
  const healthFindings = createMemo(() => {
    const report = health.report();
    const list = report === undefined ? [] : findings(report, health.outcome());
    return withoutBudgetNotice(
      mergeFindings(list, [...localHeaderFindings(checked()), ...crcFindings(crcFailures())]),
      health.pause() !== undefined,
    );
  });

  /** The text that the screen-reader status speaks: empty when a view
   *  request starts, and what could not run when the memory limit refused
   *  it. Thus each refusal is new text, also a refusal of the same kind.
   *  The health strip shows the same text, but it is not a live region. */
  const [refusal, setRefusal] = createSignal("");
  /** True after the memory limit refused a view request. */
  const [refused, setRefused] = createSignal(false);
  session.onViewRequest = (kind) => {
    if (kind !== undefined) setRefused(true);
    setRefusal(kind === undefined ? "" : refusedText(kind, session.hard));
  };
  /** True after the hard stop. Then the worker refuses each view request,
   *  so the search field and the sort buttons are off. The outcome and a
   *  refusal come before the health report, so they also count. */
  const stopped = createMemo(() => {
    const end = health.outcome();
    return (
      health.report()?.budget.hardReached === true ||
      refused() ||
      (end?.kind === "failed" && end.message === hardStopMessage(session.hard))
    );
  });

  /** The text next to the breadcrumb: a search or a sort that runs, else the
   *  best-match order, which no header can show. */
  const sortStatus = () => {
    const best = isBestMatch(sort());
    const running = working();
    // A new search says so, also from a folder with an arrow. A sort says so,
    // also the sort to archive order, which has no column. The default sort
    // shows in `sort()` only when it lands. It does not change a listing in the
    // best-match order.
    const sorted =
      !best &&
      (running === "sort" ||
        (running !== "search" && (settling() || sort().column !== SortColumn.ARCHIVE)));
    const verb = sorted ? "Sorting" : "Searching";
    const now = phase();
    // The default sort starts at the end of the parse, so only a chosen sort
    // merges new rows while the parse runs.
    const late = running === "search" || running === "sort";
    if (isParsing(now) && ((sorted && sortChosen()) || late)) {
      return `${verb}… (parse ${Math.floor(phaseProgress(now) * 100)}%)`;
    }
    if (late) return `${verb}…`;
    // A search with no result has no order to tell.
    return best && listedRows() ? "Best match" : "";
  };

  return {
    session,
    /** The frame loop that draws the tree, the table and the breadcrumb. */
    loop,
    /** The count of listed rows, from the last frame. */
    rows,
    declared,
    storeBytes,
    /** The parse phase: the status bar shows it. */
    phase,
    /** The order that the column headers show. */
    sort,
    listedSort,
    sortChosen,
    listingOrder,
    sorted: () => sorted,
    sortBy,
    sortStatus,
    askFirstRow,
    dropFirstRow,
    firstRowReady,
    stopped,
    refusal,
    health,
    findings: healthFindings,
    onCheck,
    onCrcFailure,
    /** The control of the front door that opened this sample, if any. It does
     *  not change. */
    reveal,
    healthOpen,
    toggleHealth: () => setHealthOpen((open) => !open),
  };
}
