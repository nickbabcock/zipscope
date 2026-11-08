// The parse worker. One worker per archive; the UI terminates it when the
// archive closes, which also frees the leaked rawzip iterator.
import * as Comlink from "comlink";
import {
  HARD_BUDGET_BYTES,
  HEADER_BYTES,
  HEALTH_FIELDS,
  Header,
  HealthField,
  LAYOUT_VERSION,
  Marks,
  SOFT_BUDGET_BYTES,
  STORE_GROWTH_SLACK_BYTES,
  State,
  readReserve,
} from "../contracts";
import type {
  HealthReport,
  MirrorSink,
  OpenInfo,
  OpenOptions,
  ParseOutcome,
  ParseWorkerApi,
  RefusedView,
  SortColumn,
} from "../contracts";
import init, {
  layoutVersion,
  memoryFull,
  memorySlack,
  Parser,
  setMemorySlack,
} from "../wasm/zipscope_core.js";
import { budgetState, healthReport, MemoryLimitError } from "./budget";
import type { BudgetState } from "./budget";
import { parseInBatches, stepTreeOrder, stepViews } from "./loop";
import { StoreReservation } from "./memory";
import { listingSort } from "../view/sort";
import { FileReaderAt, WindowReaderAt } from "./reader";
import { MirrorWriter } from "./publish";

let opened = false;
/** True until the parse loop ends. */
let parsing = true;
let terminalError: string | undefined;
/** Only for tests: refuse each view request after its change. */
/** Only for tests: the view requests that the budget refuses after their
 *  change (`OpenOptions.refuseViews`). */
let refuseViews: boolean | RefusedView = false;
let interruption: Error | undefined;
/** True after the user chose a sort, also archive order. */
let sortChosen = false;
/** The memory that the default sort of one row can need: the items, its merge
 *  and the mirrors of the published listing. */
const DEFAULT_SORT_BYTES_PER_ROW = 32;
/** The memory that the job of the tree order can need for one folder: 13 bytes
 *  for its vectors, with room for the ends of the sorted runs. The mirrors do
 *  not grow: the tree has the same rows. */
const TREE_ORDER_BYTES_PER_FOLDER = 16;
/** Resolves when the job of the tree order ended. */
let treeOrderEnd: Promise<void> = Promise.resolve();
/** The open archive, for view requests. */
let archive:
  | { parser: Parser; writer: MirrorWriter; budget: BudgetState; header: Int32Array }
  | undefined;
const outcome = Promise.withResolvers<ParseOutcome>();

/**
 * Loads the wasm one time. `warm` and `open` can both wait for it. A
 * second `init` call before the first one completes would make a second
 * instance and replace the exports, while objects of the first instance
 * still exist. A failed load is tried again on the next call.
 */
let loading: ReturnType<typeof init> | undefined;
function load(): ReturnType<typeof init> {
  loading ??= init().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

const api: ParseWorkerApi = {
  async warm(): Promise<void> {
    await load();
  },
  async open(file: File, sink: MirrorSink, options?: OpenOptions): Promise<OpenInfo> {
    if (opened) {
      throw new Error("This worker already has an archive");
    }
    opened = true;
    let reader: WindowReaderAt | undefined;
    let probes: FileReaderAt | undefined;
    let parser: Parser;
    let memory: () => ArrayBuffer;
    try {
      const wasm = await load();
      if (layoutVersion() !== LAYOUT_VERSION) {
        throw new Error(`The wasm writes layout ${layoutVersion()}, expected ${LAYOUT_VERSION}`);
      }
      memory = () => wasm.memory.buffer;
      const header = new SharedArrayBuffer(HEADER_BYTES);
      const view = new Int32Array(header);
      view[Header.LAYOUT] = LAYOUT_VERSION;
      view[Header.STATE] = State.OPENING;
      const limits = options?.budget ?? { soft: SOFT_BUDGET_BYTES, hard: HARD_BUDGET_BYTES };
      refuseViews = options?.refuseViews ?? false;
      // Reserve the memory that the store has now and the slack, then let
      // the allocator of the core reserve each growth before it.
      const reservation = new StoreReservation(
        header,
        limits.hard,
        readReserve(limits.hard),
        memory,
        { bytes: STORE_GROWTH_SLACK_BYTES, left: memorySlack },
      );
      setMemorySlack(STORE_GROWTH_SLACK_BYTES);
      globalThis.__zipscopeStoreMemory = reservation.growth;
      reader = new WindowReaderAt(file, new FileReaderSync());
      // Use a random seed to prevent folder hash collisions.
      const [low, high] = crypto.getRandomValues(new Uint32Array(2));
      const seed = (BigInt(high!) << 32n) | BigInt(low!);
      // The probes read small parts of the file directly, so the window of
      // the central directory stays. Only an archive whose offsets wrap at
      // 4 GiB uses them.
      probes = new FileReaderAt(file, new FileReaderSync());
      parser = Parser.open(reader, file.size, seed, probes);
      const writer = new MirrorWriter(
        header,
        (mirror) => void sink.mirror(mirror),
        memory,
        limits.hard,
        readReserve(limits.hard),
        reservation,
      );
      const entriesHint = parser.entriesHint();
      /** True after the user accepted the soft budget at the prompt. */
      let softAccepted = false;
      const budget = budgetState(limits);
      archive = { parser, writer, budget, header: view };
      // The parser and its store stay until the worker stops.
      const source = reader;
      const headers = probes;
      const loopBudget = {
        failure: () => interruption,
        memoryFull,
        softBytes: limits.soft,
        hardBytes: limits.hard,
        // The prompt goes through the Comlink sink. Without a prompt, the
        // worker continues.
        confirm: async (usage: { rows: number; bytes: number }) => {
          budget.softReached = true;
          budget.storeBytes = usage.bytes;
          const proceed = (await sink.confirmMemory?.(usage)) ?? true;
          budget.declined = !proceed;
          softAccepted = proceed;
          return proceed;
        },
        onHardStop: (bytes: number) => {
          budget.hardReached = true;
          budget.storeBytes = bytes;
        },
        onRowsMissing: () => {
          budget.rowsMissing = true;
        },
      };
      /** Starts the default sort at the end of the rows, unless the user
       *  chose a sort, also archive order. The sort needs memory, and it must
       *  not turn a good parse into a memory prompt or a hard stop: without
       *  room, the listing stays in archive order. */
      const startDefaultSort = (approved: boolean) => {
        if (sortChosen) return false;
        const need = parser.rows() * DEFAULT_SORT_BYTES_PER_ROW;
        if (writer.stopBytes() + need >= limits.hard) return false;
        if (!approved && writer.allocatedBytes() + need >= limits.soft) return false;
        // Not a choice: a search with no sort chosen stays in the best-match
        // order, and gets this sort for its folder when the query goes.
        const value = parser.defaultSort();
        if (value === 0) return false;
        const { column, descending } = listingSort(value);
        writer.sorted(column, descending);
        return true;
      };
      /** Starts the job of the tree order when no more rows come, one time.
       *  The tree is for navigation and it has no sort control, so the rows of
       *  a cancelled parse get this order too. The job needs memory, and, as
       *  the default sort, it must not turn a good parse into a memory prompt
       *  or a hard stop: without room, the tree stays in archive order.
       *  `reserved` is the memory of work that also just started. */
      let treeOrderAsked = false;
      const startTreeOrder = (approved: boolean, reserved: number) => {
        if (treeOrderAsked) return;
        treeOrderAsked = true;
        const need = parser.folderCount() * TREE_ORDER_BYTES_PER_FOLDER + reserved;
        if (writer.stopBytes() + need >= limits.hard) return;
        if (!approved && writer.allocatedBytes() + need >= limits.soft) return;
        parser.startTreeOrder();
        if (parser.treeOrderPending()) treeOrderEnd = runTreeOrder(parser, writer, budget);
      };
      const onRowsEnd = (approved: boolean) => {
        const sorted = startDefaultSort(approved);
        startTreeOrder(approved, sorted ? parser.rows() * DEFAULT_SORT_BYTES_PER_ROW : 0);
        return sorted;
      };
      void parseInBatches(parser, writer, header, undefined, loopBudget, onRowsEnd).then(
        (result) => {
          parsing = false;
          // After the hard stop, the worker refuses each view request. Thus
          // the UI can turn the view controls off at the hard stop.
          if (budget.hardReached) {
            interruption ??= new MemoryLimitError(budget.storeBytes, limits.hard);
          }
          // The hard stop is in the budget state only. Thus the health panel
          // has one finding for it, not also a parse error.
          terminalError =
            result.kind === "failed" && !budget.hardReached ? result.message : undefined;
          writer.healthChanged?.();
          source.close();
          headers.close();
          outcome.resolve(result);
          // A parse that stopped: no more rows come. The hard stop does no
          // more work on the views. After "Stop here" at the memory prompt, the
          // store is at a soft budget that the user did not accept, so the
          // memory rule keeps the tree in archive order. This comes after the
          // outcome, so that it cannot hold the outcome. The UI asks for the
          // job in a later turn.
          if (result.kind === "cancelled" && !budget.hardReached) {
            startTreeOrder(softAccepted, 0);
            // A job with little work ended when it started, and no other
            // publish comes after a cancel.
            if (!parser.treeOrderPending()) publishTreeOrder(parser, writer);
          }
        },
      );
      return { header, entriesHint };
    } catch (err) {
      reader?.close();
      probes?.close();
      const message = err instanceof Error ? err.message : String(err);
      terminalError = message;
      outcome.resolve({ kind: "failed", rows: 0, message });
      throw err;
    }
  },

  finished(): Promise<ParseOutcome> {
    return outcome.promise;
  },

  // A view request runs between batches. A large new listing is made in
  // steps, with a yield after each step, so that other requests and the
  // batches wait for one step at most. The request resolves after the
  // publish of its listing.
  list(folder: number): Promise<void> {
    return viewRequest(
      "folder",
      (parser) => parser.list(folder),
      `Folder ${folder} does not exist`,
      true,
    );
  },

  expand(folder: number, open: boolean): Promise<void> {
    return viewRequest(
      "folder",
      (parser) => parser.expand(folder, open),
      `Folder ${folder} does not exist`,
      true,
    );
  },

  async entryFolder(row: number): Promise<number> {
    if (archive === undefined) {
      throw new Error("No archive is open");
    }
    return archive.parser.entryFolder(row);
  },

  expandInline(folder: number, open: boolean, deep: boolean): Promise<void> {
    return viewRequest(
      "folder",
      (parser) => parser.expandInline(folder, open, deep),
      `Folder ${folder} does not exist`,
      true,
    );
  },

  settleListing(): Promise<void> {
    // Only a large listing is still in steps here. After the hard stop, the
    // worker does no more work on the views.
    if (interruption !== undefined || archive?.parser.mergePending() !== true) {
      return Promise.resolve();
    }
    return viewRequest("sort", () => true, "");
  },

  settleTreeOrder(): Promise<void> {
    return treeOrderEnd;
  },

  sort(column: SortColumn, descending: boolean): Promise<void> {
    sortChosen = true;
    return viewRequest(
      "sort",
      (parser) => {
        if (!parser.sort(column, descending)) return false;
        archive?.writer.sorted(column, descending);
        return true;
      },
      `Sort column ${column} does not exist`,
    );
  },

  search(query: string): Promise<void> {
    return viewRequest(
      "search",
      (parser) => {
        parser.search(query);
        return true;
      },
      "",
    );
  },

  async health(): Promise<HealthReport> {
    if (archive === undefined) {
      if (terminalError === undefined) throw new Error("No archive is open");
      return healthReport(
        new Float64Array(HEALTH_FIELDS),
        0,
        terminalError,
        budgetState({ soft: SOFT_BUDGET_BYTES, hard: HARD_BUDGET_BYTES }),
      );
    }
    const { parser, writer, budget, header } = archive;
    budget.storeBytes = writer.allocatedBytes();
    const rows = Atomics.load(header, Header.COMMITTED_ROWS) >>> 0;
    const vector = parser.health();
    // The rows of a batch that no publish counted are not in the listing,
    // for example after a publish that the hard stop refused.
    if (parser.rows() > rows) {
      for (const [count, example, bit] of [
        [HealthField.CONTROL_NAME_ROWS, HealthField.CONTROL_NAME_EXAMPLE, Marks.CONTROL_NAME],
        [HealthField.WRAPPED_ROWS, HealthField.WRAPPED_EXAMPLE, Marks.WRAPPED_OFFSET],
      ] as const) {
        vector[count]! -= parser.markedFrom(rows, bit);
        if (vector[example]! >= rows) vector[example] = -1;
      }
      vector[HealthField.INTO_DIRECTORY_ROWS]! -= parser.intoDirectoryFrom(rows);
      if (vector[HealthField.INTO_DIRECTORY_EXAMPLE]! >= rows) {
        vector[HealthField.INTO_DIRECTORY_EXAMPLE] = -1;
      }
    }
    return healthReport(vector, rows, terminalError ?? parser.error(), budget);
  },
};

/** Waits for the next turn. A MessageChannel ping queues behind the
 *  messages that wait, as the parse loop does. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Runs the job of the tree order to its end, in steps. A request or a step of
 * a listing can run between two steps, so neither of them waits for the job,
 * and the job does not wait for a listing. At the memory limit the job stops:
 * the tree stays in archive order, as `TREE_ORDER_n` says.
 */
async function runTreeOrder(
  parser: Parser,
  writer: MirrorWriter,
  budget: BudgetState,
): Promise<void> {
  while (parser.treeOrderPending()) {
    // The first turn comes after the publish of the last rows.
    await nextTurn();
    if (interruption !== undefined || budget.hardReached || memoryFull()) return;
    if (stepTreeOrder(parser, () => performance.now())) publishTreeOrder(parser, writer);
  }
}

/** Publishes the tree of the job when it does not show. A publish that does
 *  not fit is a hard stop. */
function publishTreeOrder(parser: Parser, writer: MirrorWriter): void {
  try {
    if (!writer.shows(parser)) writer.publish(parser);
  } catch (err) {
    if (!(err instanceof MemoryLimitError)) throw err;
    stopAtMemoryLimit(err);
  }
}

async function runViewRequest(
  kind: RefusedView,
  change: (parser: Parser) => boolean,
  error: string,
  onlyOwnBuild = false,
): Promise<void> {
  if (archive === undefined) {
    throw new Error("No archive is open");
  }
  if (interruption !== undefined) throw interruption;
  const { parser, writer, budget } = archive;
  const check = () => {
    if (interruption !== undefined) throw interruption;
    const bytes = writer.stopBytes();
    // After the budget refused a growth, the core does no more work that
    // grows, so the request stops at the hard stop.
    if (bytes >= budget.limits.hard || memoryFull()) {
      throw new MemoryLimitError(Math.max(bytes, budget.limits.hard), budget.limits.hard);
    }
  };
  check();
  const epoch = parser.viewsBuildEpoch();
  if (!change(parser)) {
    throw new Error(error);
  }
  if (refuseViews === true || refuseViews === kind)
    throw new MemoryLimitError(budget.limits.hard, budget.limits.hard);
  check();
  parser.refreshViews();
  check();
  // A sort or a search waits for its listing. A list or expand request
  // waits only for a listing that it starts, also when that listing
  // replaces one that runs, but not for a listing that another request
  // started. A later request can replace the listing again: then this
  // request waits for the last listing.
  const waits = !onlyOwnBuild || parser.viewsBuildEpoch() !== epoch;
  // While parsing, the parse loop merges new rows. After it, this loop
  // also ends the merges.
  const working = () => waits && (parser.viewsBuilding() || (!parsing && parser.mergePending()));
  // A request fails only when its listing did not publish, because the UI
  // then keeps the view state of the listing that shows. Thus no check
  // follows when the listing is complete and published, also when another
  // request or the parse loop published it.
  const shown = () => !working() && !parser.viewsBuilding() && writer.shows(parser);
  while (working()) {
    check();
    if (stepViews(parser, () => performance.now(), check)) {
      writer.publish(parser);
    }
    if (working()) {
      await nextTurn();
      if (shown()) return;
      check();
    }
  }
  if (shown()) return;
  check();
  writer.publish(parser);
}

async function viewRequest(
  kind: RefusedView,
  change: (parser: Parser) => boolean,
  error: string,
  onlyOwnBuild = false,
): Promise<void> {
  try {
    await runViewRequest(kind, change, error, onlyOwnBuild);
  } catch (err) {
    if (err instanceof MemoryLimitError && archive !== undefined) {
      stopAtMemoryLimit(err, kind);
    }
    throw err;
  }
}

/** Records the hard stop that a view request or the job of the tree order saw.
 *  `refused` is the kind of the view request that the stop refused. */
function stopAtMemoryLimit(err: MemoryLimitError, refused?: RefusedView): void {
  if (archive === undefined) return;
  interruption = err;
  archive.budget.hardReached = true;
  if (refused !== undefined) archive.budget.refused = refused;
  archive.budget.storeBytes = archive.writer.allocatedBytes();
  // The listing stays, and no later request can add its rows.
  if (archive.writer.listingBehind()) archive.budget.rowsMissing = true;
  Atomics.store(archive.header, Header.STORE_KIB, Math.ceil(archive.writer.storeBytes() / 1024));
  archive.writer.healthChanged?.();
  if (!parsing) Atomics.store(archive.header, Header.STATE, State.FAILED);
}

Comlink.expose(api);
