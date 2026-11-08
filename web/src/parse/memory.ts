// The reservations of the parse worker on the shared memory budget (see
// `memory.ts`). The worker reserves
// the store memory before it grows: the core wasm memory through the
// growth hook of its allocator, and each mirror before it allocates or
// grows it.
import { HEADER_BYTES } from "../contracts";
import { Reservations } from "../memory";
import type { GrowthHook } from "../memory";
import { MemoryLimitError } from "./budget";

/** The slack of the core wasm: the bytes that the worker reserved for the
 *  allocations that cannot fail, and the part of them that is not used. */
export interface Slack {
  bytes: number;
  left(): number;
}

const NO_SLACK: Slack = { bytes: 0, left: () => 0 };

export class StoreReservation {
  readonly reservations: Reservations;
  /** The wasm memory that the reservation holds, without the slack. */
  private counted: number;

  /**
   * Reserves the memory that the store has now: the header, the wasm
   * memory and the slack. Throws a `MemoryLimitError` when it does not
   * fit below the hard stop.
   */
  constructor(
    header: SharedArrayBuffer,
    readonly hardBytes: number,
    readReserveBytes: number,
    /** Returns the current wasm memory. */
    private readonly memory: () => ArrayBuffer,
    private readonly slack: Slack = NO_SLACK,
  ) {
    this.reservations = new Reservations(header, hardBytes, readReserveBytes);
    this.counted = memory().byteLength;
    if (!this.reservations.reserveStore(HEADER_BYTES + this.counted + slack.bytes)) {
      throw new MemoryLimitError(this.stopBytes(), hardBytes);
    }
  }

  /** The hook of the core wasm allocator. */
  readonly growth: GrowthHook = {
    reserve: (bytes) => {
      if (!this.reservations.reserveStore(bytes)) return false;
      this.counted += bytes;
      return true;
    },
    release: (bytes) => {
      this.reservations.releaseStore(bytes);
      this.counted -= bytes;
    },
  };

  /**
   * Adds wasm memory that grew without the hook to the reservation. With
   * the hook, the core reserves each growth before it, or takes it from
   * the slack, so this adds nothing. Without the hook (a test store, or
   * the growth before the hook was set), the memory is there already, so
   * it is added also when it passes the limit.
   */
  private sync(): void {
    const used = this.slack.bytes - this.slack.left();
    const extra = this.memory().byteLength - this.counted - used;
    if (extra > 0) {
      this.counted += extra;
      this.reservations.addStore(extra);
    }
  }

  /** Reserves `bytes` for a mirror. Returns false when they do not fit. */
  tryTake(bytes: number): boolean {
    this.sync();
    return this.reservations.reserveStore(bytes);
  }

  /** Reserves `bytes` for a mirror. Throws a `MemoryLimitError` when they
   *  do not fit. */
  take(bytes: number): void {
    if (!this.tryTake(bytes)) throw new MemoryLimitError(this.stopBytes(), this.hardBytes);
  }

  /** Gives back a reservation, when the allocation failed. */
  give(bytes: number): void {
    this.reservations.releaseStore(bytes);
  }

  /** Throws a `MemoryLimitError` at the hard stop or past it. */
  check(): void {
    this.sync();
    const used = this.stopBytes();
    if (used >= this.hardBytes) throw new MemoryLimitError(used, this.hardBytes);
  }

  /** The bytes that the hard stop counts: the reservation of the parse
   *  worker and the larger of the read reservation and the reserve. */
  stopBytes(): number {
    return this.reservations.stopBytes();
  }

  /** The bytes that the parse worker can still reserve. */
  room(): number {
    this.sync();
    return this.reservations.storeRoom();
  }
}
