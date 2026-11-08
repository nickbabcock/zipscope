// The pass of the read worker over the central directory. It reads only
// the records of committed rows, so it never goes past the rows that the
// parse worker kept: after a cancel or a memory stop, the committed count
// is final. Each step must fit below the memory limit of the read worker.
import { State } from "../contracts";
import { integers } from "../format";

/** The part of the wasm `ReadArchive` that the pass uses. */
export interface ScanTarget {
  rows(): number;
  scan(maxRecords: number): number;
  /** 0 while records follow, 1 at the end, 2 after an error. */
  scanState(): number;
  tableBytes(): number;
  /** The rows that the table holds without growth. */
  capacity(): number;
  /** The most bytes that `scan(count)` allocates (at most one chunk). */
  growth(count: number): number;
}

/** What the pass reads from the header of the parse worker. */
export interface ScanSource {
  state(): State;
  committedRows(): number;
}

/** Records that the pass reads in one step. */
export const SCAN_STEP = 16_384;

export type ScanStep = "more" | "wait" | "done";

/** States after which `COMMITTED_ROWS` does not change. */
function terminal(state: State): boolean {
  return state === State.COMPLETE || state === State.CANCELLED || state === State.FAILED;
}

export class WayfinderScan {
  /** Why the last step did not fit below the memory limit, or undefined. */
  stopped: string | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly target: ScanTarget,
    private readonly source: ScanSource,
    /** Returns true when `bytes` more heap fit below the memory limit. */
    private readonly fits: (bytes: number) => boolean,
    /** The heap that the pass leaves free for decoding. */
    private readonly keepBytes: number,
    /** Called after the memory can have changed. */
    private readonly publish: () => void = () => {},
  ) {}

  /** Reads up to `count` records. Returns false when `fits` refuses the
   *  growth of the table. The table grows in chunks, so a step past the
   *  allocated chunks grows it by one chunk. */
  private scan(count: number, fits: (growth: number) => boolean): boolean {
    const growth = this.target.growth(count);
    if (!fits(growth)) {
      const rows = this.target.rows();
      this.stopped = `The memory limit leaves no room for the read module after ${integers.format(rows)} rows`;
      return false;
    }
    this.stopped = undefined;
    const added = this.target.scan(count);
    this.publish();
    if (added === 0 && this.target.scanState() === 0) {
      // The table could not grow below the memory cap of the read wasm.
      this.stopped = `The memory limit leaves no room for the read module after ${integers.format(this.target.rows())} rows`;
      return false;
    }
    return true;
  }

  /** Makes one step of the background pass. `more`: call again on the
   *  next turn. `wait`: the parse worker can commit more rows. `done`:
   *  the pass ended, or the memory limit stopped it. */
  step(): ScanStep {
    // Read the state before the count: the parse worker stores its final
    // count before the terminal state.
    const state = this.source.state();
    const committed = this.source.committedRows();
    if (this.target.scanState() !== 0) {
      return "done";
    }
    const rows = this.target.rows();
    if (rows < committed) {
      const fits = (growth: number) => this.fits(growth + this.keepBytes);
      return this.scan(Math.min(SCAN_STEP, committed - rows), fits) ? "more" : "done";
    }
    return terminal(state) ? "done" : "wait";
  }

  /**
   * Reads the records up to `row` at once, in steps, for a read request.
   * Call it only for a committed row. Before each step, `fits` gets the
   * growth of the table and tells if the step leaves the room of the read.
   * The read gives its own room, not the room of the background pass:
   * after a hard stop, the last parse batch can take a part of the
   * reserve, and a small read must still fit. Returns true when the table
   * has the row. When it returns false, `stopped` tells why.
   */
  reach(row: number, fits: (growth: number) => boolean): boolean {
    while (this.target.rows() <= row && this.target.scanState() === 0) {
      if (!this.scan(Math.min(SCAN_STEP, row + 1 - this.target.rows()), fits)) {
        break;
      }
    }
    return this.target.rows() > row;
  }

  /**
   * Starts the background pass, if it does not run. It reads in steps
   * until it has all committed rows, or until a step does not fit below
   * the memory limit, and then it stops. It sets no timer, so an idle
   * worker does no work. Call it again when more rows can be committed or
   * memory can be free: on a read and on a new page.
   */
  resume(nextTurn: () => Promise<void>): Promise<void> {
    if (this.running !== undefined) return this.running;
    let ended = false;
    const steps = async () => {
      try {
        while (this.step() === "more") await nextTurn();
      } finally {
        ended = true;
        this.running = undefined;
      }
    };
    // The steps can end before the first turn, in this call.
    const promise = steps();
    if (!ended) this.running = promise;
    return promise;
  }

  /** Resolves when the background pass does not run. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }
}
