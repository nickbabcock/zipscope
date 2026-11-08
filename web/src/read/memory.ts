// The memory limit of the read worker. The preview, the byte map and the
// extraction use it.
import { Header, READ_GROWTH_SLACK_BYTES, readReserve } from "../contracts";
import { Reservations } from "../memory";
import type { GrowthHook } from "../memory";
import { heapBytes, memorySlack, setMemoryCap, setMemorySlack } from "../wasm/zipscope_read.js";

/**
 * The memory limit of the read worker. The hard stop counts the store
 * memory and the read worker memory together. The read worker reserves
 * each growth of its wasm memory on the shared budget (`Reservations`)
 * before the growth, so the total never passes the hard stop. Wasm memory
 * does not shrink, but free heap below its size can be used again. Thus a
 * step fits when the live heap and the step fit below the limit.
 */
export class ReadMemory {
  private readonly slots: Int32Array;
  private readonly reservations: Reservations;
  /** The slack that the reservation holds and the allocator has not used. */
  private slack = 0;

  /** Reserves the wasm memory that the worker has now and the slack. */
  constructor(
    header: SharedArrayBuffer,
    private readonly memory: () => ArrayBuffer,
    readonly hardBytes: number,
  ) {
    this.slots = new Int32Array(header);
    this.reservations = new Reservations(header, hardBytes, readReserve(hardBytes));
    // The memory exists already. The parse worker keeps the reserve free,
    // and the reserve is more than the memory of the read worker at its
    // start.
    this.reservations.addRead(memory().byteLength);
    this.refill();
  }

  /** The hook of the read wasm allocator. */
  readonly growth: GrowthHook = {
    reserve: (bytes) => this.reservations.reserveRead(bytes),
    release: (bytes) => this.reservations.releaseRead(bytes),
  };

  /** Reserves the slack again after the allocator used a part of it. The
   *  used part is wasm memory now, and the reservation keeps it. */
  private refill(): void {
    this.slack = Math.min(this.slack, memorySlack());
    const missing = READ_GROWTH_SLACK_BYTES - this.slack;
    if (missing > 0 && this.reservations.reserveRead(missing)) {
      this.slack = READ_GROWTH_SLACK_BYTES;
    }
    setMemorySlack(this.slack);
  }

  /** The most wasm memory that the read worker can have now: its memory
   *  and the room that the budget leaves. */
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

  /** True when the wasm memory can grow by `bytes` below the limit. It
   *  does not count the free heap below the wasm memory. */
  fitsAbove(bytes: number): boolean {
    return this.memory().byteLength + bytes <= this.limit();
  }

  /** Sets the memory cap of the read wasm to the limit, and reserves the
   *  slack again. Call it before each wasm call that can allocate. The
   *  allocator also reserves each growth on the budget, so the cap only
   *  stops a growth early. */
  arm(): void {
    this.refill();
    setMemoryCap(Math.max(0, this.limit()));
  }

  /** The size of the wasm memory. */
  memoryBytes(): number {
    return this.memory().byteLength;
  }

  /** Stores the wasm memory in `READ_KIB`, for the status bar and the soft
   *  budget. */
  publish(): void {
    Atomics.store(this.slots, Header.READ_KIB, Math.ceil(this.memory().byteLength / 1024));
  }
}
