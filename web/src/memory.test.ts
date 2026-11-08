// The reservation loop of the shared memory budget. The browser test
// `browser/reservation.test.ts` runs it in workers at the same time.
import { afterEach, describe, expect, test, vi } from "vitest";
import { HEADER_BYTES, Header, RESERVATION_UNIT_BYTES } from "./contracts";
import { Reservations, units } from "./memory";

const UNIT = RESERVATION_UNIT_BYTES;

afterEach(() => {
  vi.restoreAllMocks();
});

type Swap = (array: Int32Array, index: number, expected: number, value: number) => number;

/** Spies on `Atomics.compareExchange`: `before` runs before each swap. */
function onSwap(before: () => void): void {
  const swap = Atomics.compareExchange.bind(Atomics) as unknown as Swap;
  const spy: Swap = (array, index, expected, value) => {
    before();
    return swap(array, index, expected, value);
  };
  vi.spyOn(Atomics, "compareExchange").mockImplementation(
    spy as unknown as typeof Atomics.compareExchange,
  );
}

function pair(hardUnits: number, reserveUnits: number) {
  const header = new SharedArrayBuffer(HEADER_BYTES);
  const parse = new Reservations(header, hardUnits * UNIT, reserveUnits * UNIT);
  const read = new Reservations(header, hardUnits * UNIT, reserveUnits * UNIT);
  return { header, parse, read };
}

describe("Reservations", () => {
  test("bytes round up to whole units", () => {
    expect(units(0)).toBe(0);
    expect(units(1)).toBe(1);
    expect(units(UNIT)).toBe(1);
    expect(units(UNIT + 1)).toBe(2);
  });

  test("the parse worker stops at the hard stop less the read reserve, exactly", () => {
    const { parse } = pair(100, 10);
    expect(parse.reserveStore(89 * UNIT)).toBe(true);
    expect(parse.storeRoom()).toBe(UNIT);
    expect(parse.reserveStore(UNIT + 1)).toBe(false);
    expect(parse.reserveStore(UNIT)).toBe(true);
    expect(parse.reserveStore(1)).toBe(false);
    expect(parse.storeBytes()).toBe(90 * UNIT);
    expect(parse.stopBytes()).toBe(100 * UNIT);
  });

  test("the read worker can use the reserve and the rest, exactly", () => {
    const { parse, read } = pair(100, 10);
    expect(parse.reserveStore(60 * UNIT)).toBe(true);
    expect(read.readRoom()).toBe(40 * UNIT);
    expect(read.reserveRead(40 * UNIT)).toBe(true);
    expect(read.reserveRead(1)).toBe(false);
    // The read worker passed its reserve, so the parse worker has no room.
    expect(parse.storeRoom()).toBe(0);
    expect(parse.reserveStore(1)).toBe(false);
    expect(parse.storeBytes() + read.readBytes()).toBe(100 * UNIT);
  });

  test("a release gives the bytes back, and releases of all give the whole budget", () => {
    const { header, parse, read } = pair(100, 10);
    expect(parse.reserveStore(50 * UNIT)).toBe(true);
    expect(read.reserveRead(50 * UNIT)).toBe(true);
    expect(read.reserveRead(1)).toBe(false);
    read.releaseRead(20 * UNIT);
    expect(parse.reserveStore(20 * UNIT)).toBe(true);
    parse.releaseStore(70 * UNIT);
    read.releaseRead(30 * UNIT);
    expect(Atomics.load(new Int32Array(header), Header.RESERVED)).toBe(0);
    // A release never goes below zero.
    read.releaseRead(UNIT);
    expect(read.readBytes()).toBe(0);
  });

  test("a partial unit below the hard stop does not count", () => {
    const header = new SharedArrayBuffer(HEADER_BYTES);
    const parse = new Reservations(header, 10 * UNIT + UNIT / 2, 0);
    expect(parse.reserveStore(10 * UNIT)).toBe(true);
    expect(parse.reserveStore(1)).toBe(false);
  });

  test("the two halves hold a hard stop of 2 GiB with no sign problems", () => {
    const header = new SharedArrayBuffer(HEADER_BYTES);
    const hard = 2 ** 31;
    const reserve = 96 * 2 ** 20;
    const parse = new Reservations(header, hard, reserve);
    const read = new Reservations(header, hard, reserve);
    expect(parse.reserveStore(hard - reserve)).toBe(true);
    expect(read.reserveRead(reserve)).toBe(true);
    expect(read.reserveRead(1)).toBe(false);
    expect(parse.storeBytes()).toBe(hard - reserve);
    expect(read.readBytes()).toBe(reserve);
    expect(parse.stopBytes()).toBe(hard);
  });

  test("addStore and addRead record memory that exists, also past the limit", () => {
    const { parse, read } = pair(100, 10);
    expect(read.addRead(4 * UNIT)).toBe(true);
    expect(parse.addStore(95 * UNIT)).toBe(false);
    expect(parse.storeBytes()).toBe(95 * UNIT);
    // The parse rule is past the limit, so the parse worker gets no more.
    // The read worker gets only the unit that is left below the hard stop.
    expect(parse.reserveStore(1)).toBe(false);
    expect(read.readRoom()).toBe(UNIT);
    expect(read.reserveRead(2 * UNIT)).toBe(false);
  });

  test("a change between the load and the swap makes the loop try again", () => {
    const { parse, read } = pair(100, 10);
    expect(parse.reserveStore(80 * UNIT)).toBe(true);
    let raced = false;
    onSwap(() => {
      if (!raced) {
        // The parse worker reserves after the read worker loaded the slot
        // and before its swap.
        raced = true;
        expect(parse.reserveStore(5 * UNIT)).toBe(true);
      }
    });
    // The read worker wanted 16 units, which fit before the race. After
    // the race only 15 fit, so the loop that tries again refuses it.
    expect(read.reserveRead(16 * UNIT)).toBe(false);
    expect(raced).toBe(true);
    expect(read.reserveRead(15 * UNIT)).toBe(true);
    expect(parse.storeBytes() + read.readBytes()).toBe(100 * UNIT);
  });

  test("many lost races do not lose a reservation", () => {
    const { parse, read } = pair(1000, 10);
    let races = 0;
    let inside = false;
    onSwap(() => {
      // Each second swap of the read worker loses to one reservation of
      // the parse worker.
      if (inside) return;
      races++;
      if (races < 100 && races % 2 === 0) {
        inside = true;
        parse.reserveStore(UNIT);
        inside = false;
      }
    });
    let taken = 0;
    while (read.reserveRead(UNIT)) taken++;
    vi.restoreAllMocks();
    expect(parse.storeBytes() / UNIT + taken).toBe(1000);
    expect(read.readBytes()).toBe(taken * UNIT);
  });
});
