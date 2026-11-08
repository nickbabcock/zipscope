// A worker that reserves on the shared memory budget until the budget
// refuses, for `reservation.test.ts`. All workers start at one signal, so
// their compare-and-swap loops run at the same time.
import { Reservations } from "../src/memory";
import type { ReserveJob, ReserveResult } from "./reservation-types";

self.onmessage = ({ data }: MessageEvent<ReserveJob>) => {
  const reservations = new Reservations(data.header, data.hardBytes, data.reserveBytes);
  const start = new Int32Array(data.start);
  Atomics.add(start, 1, 1);
  Atomics.wait(start, 0, 0);
  const reserve = (bytes: number) =>
    data.side === "store" ? reservations.reserveStore(bytes) : reservations.reserveRead(bytes);
  let taken = 0;
  let refused = 0;
  let releases = 0;
  // Reserve until the budget refuses several times in a row. The other
  // workers can give back bytes, so a refusal is not the end at once.
  while (refused < 64) {
    if (reserve(data.stepBytes)) {
      taken += data.stepBytes;
      refused = 0;
      // Some workers give back a part, as a failed allocation does. They
      // stop after 32 releases, so that the budget fills.
      if (data.release && releases < 32 && taken % (4 * data.stepBytes) === 0) {
        releases++;
        if (data.side === "store") reservations.releaseStore(data.stepBytes);
        else reservations.releaseRead(data.stepBytes);
        taken -= data.stepBytes;
      }
    } else refused++;
  }
  const result: ReserveResult = { taken };
  postMessage(result);
};
