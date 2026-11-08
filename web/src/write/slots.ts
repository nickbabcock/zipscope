// The memory slots of the write workers: two Int32 values for
// each worker. The UI reads them without the write wasm.
import { RESERVATION_UNIT_BYTES, WRITE_SLOTS_PER_WORKER, WriteSlot } from "../contracts";

/** The bytes that the write workers reserved, from their slots. */
export function reservedBytes(slots: SharedArrayBuffer): number {
  const view = new Int32Array(slots);
  let total = 0;
  for (let at = WriteSlot.RESERVED; at < view.length; at += WRITE_SLOTS_PER_WORKER) {
    total += Math.max(0, Atomics.load(view, at));
  }
  return total * RESERVATION_UNIT_BYTES;
}

/** The wasm memory of the write workers, from their slots. */
export function memoryBytes(slots: SharedArrayBuffer): number {
  const view = new Int32Array(slots);
  let total = 0;
  for (let at = WriteSlot.KIB; at < view.length; at += WRITE_SLOTS_PER_WORKER) {
    total += Math.max(0, Atomics.load(view, at));
  }
  return total * 1024;
}
