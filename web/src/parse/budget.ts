// The memory budget of the parse worker and the health report. The store
// memory is wasm memory, the header and all mirrors.
import { HealthField } from "../contracts";
import type {
  HealthReport,
  MemoryBudget,
  MemoryUsage,
  RefusedView,
  RowFinding,
} from "../contracts";
import { formatSize } from "../format";

/** The budget that `parseInBatches` checks before each batch. */
export interface LoopBudget {
  /** A failure from a view request that must also stop parsing. */
  failure?: () => Error | undefined;
  softBytes: number;
  hardBytes: number;
  /** Asks the user to continue at the soft budget. Resolves true to
   *  continue to the hard stop, false to cancel. */
  confirm: (usage: MemoryUsage) => Promise<boolean>;
  /** Called when the hard stop ends parsing. */
  onHardStop?: (bytes: number) => void;
  /** Called when parsing ended and rows that the status counts are not in the
   *  published listing, because the memory limit left no room for the last
   *  merge. */
  onRowsMissing?: () => void;
  /** True after the memory budget refused a growth of the core wasm.
   *  Then the core does no more work that grows, and parsing stops at the
   *  hard stop (see `memory.ts`). */
  memoryFull?: () => boolean;
}

/** What the health report shows about the budget. */
export interface BudgetState {
  limits: MemoryBudget;
  storeBytes: number;
  softReached: boolean;
  declined: boolean;
  hardReached: boolean;
  /** True when the memory limit left no room to add rows to the published
   *  listing, and the status counts these rows. */
  rowsMissing: boolean;
  /** The last view request that the hard stop refused. */
  refused?: RefusedView;
}

export function budgetState(limits: MemoryBudget): BudgetState {
  return {
    limits,
    storeBytes: 0,
    softReached: false,
    declined: false,
    hardReached: false,
    rowsMissing: false,
  };
}

/** The terminal error at the hard stop. */
export function hardStopMessage(hardBytes: number): string {
  return `The store reached the ${formatSize(hardBytes)} memory limit`;
}

function finding(vector: ArrayLike<number>, rows: number, example: number): RowFinding {
  return { rows: vector[rows] ?? 0, example: vector[example] ?? -1 };
}

/** Makes the health report from the wasm health vector and the budget. */
export function healthReport(
  vector: ArrayLike<number>,
  rows: number,
  error: string | undefined,
  budget: BudgetState,
): HealthReport {
  const at = (index: number) => vector[index] ?? 0;
  const encrypted = (kind: number) => at(HealthField.ENCRYPTED + kind - 1);
  const report: HealthReport = {
    rows,
    declaredEntries: at(HealthField.DECLARED_ENTRIES),
    countMismatch: at(HealthField.COUNT_MISMATCH) !== 0,
    countWrapped: at(HealthField.COUNT_WRAPPED) !== 0,
    duplicates: finding(vector, HealthField.DUPLICATE_ROWS, HealthField.DUPLICATE_EXAMPLE),
    bombs: finding(vector, HealthField.BOMB_ROWS, HealthField.BOMB_EXAMPLE),
    overlaps: finding(vector, HealthField.OVERLAP_ROWS, HealthField.OVERLAP_EXAMPLE),
    overlapData: finding(vector, HealthField.OVERLAP_DATA_ROWS, HealthField.OVERLAP_DATA_EXAMPLE),
    intoDirectory: finding(
      vector,
      HealthField.INTO_DIRECTORY_ROWS,
      HealthField.INTO_DIRECTORY_EXAMPLE,
    ),
    depthCap: finding(vector, HealthField.DEPTH_CAP_ROWS, HealthField.DEPTH_CAP_EXAMPLE),
    folderCap: finding(vector, HealthField.FOLDER_CAP_ROWS, HealthField.FOLDER_CAP_EXAMPLE),
    controlNames: finding(vector, HealthField.CONTROL_NAME_ROWS, HealthField.CONTROL_NAME_EXAMPLE),
    wrapped: finding(vector, HealthField.WRAPPED_ROWS, HealthField.WRAPPED_EXAMPLE),
    overlapsChecked: at(HealthField.OVERLAPS_CHECKED) !== 0,
    duplicatesChecked: at(HealthField.DUPLICATES_CHECKED) !== 0,
    preludeBytes: at(HealthField.PRELUDE_BYTES),
    epilogueBytes: at(HealthField.EPILOGUE_BYTES),
    endRecord: {
      commentDeclared: at(HealthField.COMMENT_DECLARED),
      commentPresent: at(HealthField.COMMENT_PRESENT),
      skipped: at(HealthField.END_SKIPPED),
      others: at(HealthField.END_OTHERS),
      unchecked: at(HealthField.END_UNCHECKED),
      secondDirectory: at(HealthField.END_SECOND_DIRECTORY) !== 0,
      declaredDirectory: at(HealthField.END_DECLARED_DIRECTORY),
      foundDirectory: at(HealthField.END_FOUND_DIRECTORY),
      earlierRecords: at(HealthField.END_EARLIER_RECORDS),
      earlierRecord: at(HealthField.END_EARLIER_RECORD),
      earlierDirectory: at(HealthField.END_EARLIER_DIRECTORY),
    },
    encrypted: {
      zipCrypto: encrypted(1),
      aes128: encrypted(2),
      aes192: encrypted(3),
      aes256: encrypted(4),
      other: encrypted(5),
      aesUnknown: encrypted(6),
    },
    budget: { ...budget, limits: { ...budget.limits } },
  };
  if (error !== undefined) {
    report.error = error;
  }
  return report;
}

export class MemoryLimitError extends Error {
  constructor(
    readonly bytes: number,
    hardBytes: number,
  ) {
    super(hardStopMessage(hardBytes));
    this.name = "MemoryLimitError";
  }
}
