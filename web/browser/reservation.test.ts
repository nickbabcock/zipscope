// The shared memory budget with workers that reserve at the same moment.
// The parse side and the read side race
// for the last bytes. The total stays at or below the hard stop exactly,
// no reservation is lost, and the losing side gets a refusal.
import { expect, test } from "vitest";
import { HEADER_BYTES, RESERVATION_UNIT_BYTES } from "../src/contracts";
import { Reservations } from "../src/memory";
import type { ReserveJob, ReserveResult } from "./reservation-types";

const UNIT = RESERVATION_UNIT_BYTES;

async function race(hardUnits: number, reserveUnits: number) {
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const start = new SharedArrayBuffer(8);
  const signal = new Int32Array(start);
  const jobs: Omit<ReserveJob, "header" | "start" | "hardBytes" | "reserveBytes">[] = [
    { side: "store", stepBytes: UNIT, release: false },
    { side: "store", stepBytes: 3 * UNIT, release: true },
    { side: "read", stepBytes: UNIT, release: true },
    { side: "read", stepBytes: 2 * UNIT, release: false },
  ];
  const workers = jobs.map(
    () => new Worker(new URL("./reservation-worker.ts", import.meta.url), { type: "module" }),
  );
  try {
    const results = jobs.map(
      (job, index) =>
        new Promise<ReserveResult & { side: string }>((resolve, reject) => {
          const worker = workers[index]!;
          worker.onerror = (event) => reject(new Error(event.message));
          worker.onmessage = ({ data }: MessageEvent<ReserveResult>) =>
            resolve({ ...data, side: job.side });
          const message: ReserveJob = {
            ...job,
            header,
            start,
            hardBytes: hardUnits * UNIT,
            reserveBytes: reserveUnits * UNIT,
          };
          worker.postMessage(message);
        }),
    );
    while (Atomics.load(signal, 1) < jobs.length) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    return { header, results: await Promise.all(results) };
  } finally {
    for (const worker of workers) worker.terminate();
  }
}

for (const [hardUnits, reserveUnits] of [
  [4096, 128],
  [32_768, 1536],
] as const) {
  test(`four workers fill a hard stop of ${hardUnits} units exactly`, async () => {
    expect(globalThis.crossOriginIsolated).toBe(true);
    const { header, results } = await race(hardUnits, reserveUnits);
    const counter = new Reservations(header, hardUnits * UNIT, reserveUnits * UNIT);
    const sum = (side: string) =>
      results.filter((result) => result.side === side).reduce((all, r) => all + r.taken, 0);
    // No reservation is lost or counted two times.
    expect(counter.storeBytes()).toBe(sum("store"));
    expect(counter.readBytes()).toBe(sum("read"));
    // The total is at the hard stop or below it, and full to within the
    // largest step: the last bytes went to one side, the other got a
    // refusal.
    const total = counter.storeBytes() + counter.readBytes();
    expect(total).toBeLessThanOrEqual(hardUnits * UNIT);
    expect(total).toBeGreaterThan((hardUnits - 3) * UNIT);
    expect(counter.readRoom()).toBeLessThan(3 * UNIT);
    // The parse rule kept the reserve for the read side.
    expect(counter.storeBytes()).toBeLessThanOrEqual((hardUnits - reserveUnits) * UNIT);
    // Releases of all give the whole budget back.
    counter.releaseStore(counter.storeBytes());
    counter.releaseRead(counter.readBytes());
    expect(counter.storeRoom()).toBe((hardUnits - reserveUnits) * UNIT);
  });
}
