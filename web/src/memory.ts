// The shared memory budget of the parse worker and the read worker. One
// header slot, `Header.RESERVED`,
// holds the memory that each worker reserved. A worker reserves bytes with
// a compare-and-swap loop before it grows its wasm memory or allocates a
// mirror. A reservation that would pass the hard stop fails, so the total
// of the two workers never passes it, also when they grow at the same
// moment.
import { Header, RESERVATION_UNIT_BYTES } from "./contracts";

/** The most units of one worker: the 16 bits of its half of the slot. */
const HALF = 0xffff;

/** Returns the units of `bytes`, rounded up. */
export function units(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / RESERVATION_UNIT_BYTES);
}

/** The hook that the wasm allocator calls before it grows the memory (the
 *  inline JS of `crates/core/src/wasm.rs` and `crates/read/src/wasm.rs`). */
export interface GrowthHook {
  /** Reserves `bytes`. Returns false when they do not fit. */
  reserve(bytes: number): boolean;
  /** Gives back `bytes` when the memory did not grow. */
  release(bytes: number): void;
}

declare global {
  /** The hook of the core wasm in the parse worker. */
  var __zipscopeStoreMemory: GrowthHook | undefined;
  /** The hook of the read wasm in the read worker. */
  var __zipscopeReadMemory: GrowthHook | undefined;
}

/**
 * The reservations of the two workers in `Header.RESERVED`. The rules:
 *
 * - The parse worker keeps the read reserve free: its reservation, plus
 *   the larger of the read reservation and the reserve, stays at or below
 *   the hard stop. Thus a preview has the reserve after a hard stop.
 * - The read worker can use all the rest: the two reservations together
 *   stay at or below the hard stop.
 *
 * Both rules hold in one compare-and-swap of the slot, so a reservation
 * of one worker always sees the last reservation of the other.
 */
export class Reservations {
  private readonly slots: Int32Array;
  private readonly hardUnits: number;
  private readonly reserveUnits: number;

  constructor(
    header: SharedArrayBuffer,
    /** The hard stop. */
    readonly hardBytes: number,
    /** The memory that the hard stop keeps for the read worker. */
    readReserveBytes: number,
  ) {
    this.slots = new Int32Array(header);
    // A partial unit does not count, so the hard stop is never passed.
    this.hardUnits = Math.min(HALF, Math.floor(hardBytes / RESERVATION_UNIT_BYTES));
    this.reserveUnits = units(readReserveBytes);
  }

  /** Applies `update` to the two halves with a compare-and-swap loop.
   *  `update` returns the new halves, or undefined to change nothing. */
  private change(update: (store: number, read: number) => [number, number] | undefined): boolean {
    for (;;) {
      const raw = Atomics.load(this.slots, Header.RESERVED);
      const word = raw >>> 0;
      const next = update(word >>> 16, word & HALF);
      if (next === undefined) return false;
      const value = (next[0] << 16) | next[1];
      if (Atomics.compareExchange(this.slots, Header.RESERVED, raw, value) === raw) return true;
      // The other worker changed the slot after the load: try again.
    }
  }

  /** Reserves `bytes` for the parse worker. Returns false, and reserves
   *  nothing, when the parse rule does not permit them. */
  reserveStore(bytes: number): boolean {
    const add = units(bytes);
    return this.change((store, read) =>
      store + add + Math.max(read, this.reserveUnits) <= this.hardUnits
        ? [store + add, read]
        : undefined,
    );
  }

  /** Reserves `bytes` for the read worker. Returns false, and reserves
   *  nothing, when the total would pass the hard stop. */
  reserveRead(bytes: number): boolean {
    const add = units(bytes);
    return this.change((store, read) =>
      store + read + add <= this.hardUnits ? [store, read + add] : undefined,
    );
  }

  /** Records memory that the parse worker has already, also past the
   *  limit. Returns false when it is past the limit. Then the next
   *  reservations fail. */
  addStore(bytes: number): boolean {
    const add = units(bytes);
    let fits = false;
    this.change((store, read) => {
      fits = store + add + Math.max(read, this.reserveUnits) <= this.hardUnits;
      return [Math.min(HALF, store + add), read];
    });
    return fits;
  }

  /** Records memory that the read worker has already: the wasm memory
   *  when it starts. The parse rule keeps the reserve free for it, so
   *  this passes the hard stop only when the start memory is more than the
   *  reserve. Returns false in that case. */
  addRead(bytes: number): boolean {
    const add = units(bytes);
    let fits = false;
    this.change((store, read) => {
      fits = store + read + add <= this.hardUnits;
      return [store, Math.min(HALF, read + add)];
    });
    return fits;
  }

  /** Gives back a reservation of the parse worker. */
  releaseStore(bytes: number): void {
    const remove = units(bytes);
    this.change((store, read) => [Math.max(0, store - remove), read]);
  }

  /** Gives back a reservation of the read worker. */
  releaseRead(bytes: number): void {
    const remove = units(bytes);
    this.change((store, read) => [store, Math.max(0, read - remove)]);
  }

  private halves(): [number, number] {
    const word = Atomics.load(this.slots, Header.RESERVED) >>> 0;
    return [word >>> 16, word & HALF];
  }

  /** The bytes that the parse worker reserved. */
  storeBytes(): number {
    return this.halves()[0] * RESERVATION_UNIT_BYTES;
  }

  /** The bytes that the read worker reserved. */
  readBytes(): number {
    return this.halves()[1] * RESERVATION_UNIT_BYTES;
  }

  /** The bytes that the hard stop counts for the parse worker: its
   *  reservation and the larger of the read reservation and the reserve. */
  stopBytes(): number {
    const [store, read] = this.halves();
    return (store + Math.max(read, this.reserveUnits)) * RESERVATION_UNIT_BYTES;
  }

  /** The bytes that the parse worker can still reserve. */
  storeRoom(): number {
    const [store, read] = this.halves();
    return (
      Math.max(0, this.hardUnits - store - Math.max(read, this.reserveUnits)) *
      RESERVATION_UNIT_BYTES
    );
  }

  /** The bytes that the read worker can still reserve. */
  readRoom(): number {
    const [store, read] = this.halves();
    return Math.max(0, this.hardUnits - store - read) * RESERVATION_UNIT_BYTES;
  }
}
