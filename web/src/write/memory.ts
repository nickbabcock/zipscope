// The memory limit of a write worker. The write workers reserve on the same counter as the parse
// worker and the read worker: in the half of the lazy modules, which the
// read worker also uses. Each worker also records its own reservation in
// the slots of the pool, so that the UI can give it back when the worker
// stops.
import {
  WRITE_GROWTH_SLACK_BYTES,
  WRITE_SLOTS_PER_WORKER,
  WriteSlot,
  readReserve,
} from "../contracts";
import { Reservations, units } from "../memory";
import type { GrowthHook } from "../memory";
import { heapBytes, memorySlack, setMemoryCap, setMemorySlack } from "../wasm/zipscope_write.js";

declare global {
  /** The hook of the write wasm in a write worker. */
  var __zipscopeWriteMemory: GrowthHook | undefined;
}

export class WriteMemory {
  private readonly slots: Int32Array;
  private readonly reservations: Reservations;
  private readonly at: number;
  private slack = 0;

  /** Records the wasm memory that the worker has now and reserves the
   *  slack. `index` is the worker in the pool slots. */
  constructor(
    header: SharedArrayBuffer,
    slots: SharedArrayBuffer,
    index: number,
    private readonly memory: () => ArrayBuffer,
    hardBytes: number,
  ) {
    this.slots = new Int32Array(slots);
    this.at = index * WRITE_SLOTS_PER_WORKER;
    this.reservations = new Reservations(header, hardBytes, readReserve(hardBytes));
    const start = memory().byteLength;
    // The memory exists already. When it does not fit below the hard stop
    // (a race with another worker after the pool size was set), give it
    // back and stop, so that the stop stays exact.
    if (!this.reservations.addRead(start)) {
      this.reservations.releaseRead(start);
      throw new Error("The memory limit leaves no room to start a write worker");
    }
    this.record(units(start));
    this.refill();
    // Without the slack, the error path of the wasm can trap.
    if (this.slack < WRITE_GROWTH_SLACK_BYTES) {
      throw new Error("The memory limit leaves no room to start a write worker");
    }
    globalThis.__zipscopeWriteMemory = this.growth;
  }

  /** Adds `count` units to the reservation of this worker. The slot
   *  changes after the shared counter: when the worker stops between the
   *  two, the UI gives back less, never more. */
  private record(count: number): void {
    Atomics.add(this.slots, this.at + WriteSlot.RESERVED, count);
  }

  private reserve(bytes: number): boolean {
    if (!this.reservations.reserveRead(bytes)) return false;
    this.record(units(bytes));
    return true;
  }

  /** The hook of the write wasm allocator. */
  readonly growth: GrowthHook = {
    reserve: (bytes) => this.reserve(bytes),
    release: (bytes) => {
      this.record(-units(bytes));
      this.reservations.releaseRead(bytes);
    },
  };

  /** Reserves the slack again after the allocator used a part of it. */
  private refill(): void {
    this.slack = Math.min(this.slack, memorySlack());
    const missing = WRITE_GROWTH_SLACK_BYTES - this.slack;
    if (missing > 0 && this.reserve(missing)) {
      this.slack = WRITE_GROWTH_SLACK_BYTES;
    }
    setMemorySlack(this.slack);
  }

  /** The most wasm memory that the worker can have now. */
  limit(): number {
    return this.memory().byteLength + this.reservations.readRoom();
  }

  /** The heap that is free below the limit. */
  free(): number {
    return this.limit() - heapBytes();
  }

  /** True when `bytes` more heap fit below the limit. */
  fits(bytes: number): boolean {
    return Math.max(this.memory().byteLength, heapBytes() + bytes) <= this.limit();
  }

  /** Sets the memory cap and reserves the slack again. Call it before
   *  each wasm call that can allocate. */
  arm(): void {
    this.refill();
    setMemoryCap(Math.max(0, this.limit()));
  }

  /** Stores the wasm memory in the slot of the worker. */
  publish(): void {
    Atomics.store(this.slots, this.at + WriteSlot.KIB, Math.ceil(this.memory().byteLength / 1024));
  }
}
