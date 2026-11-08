import { expect, test } from "vitest";
import { TimeKind } from "../contracts";
import { TimeKinds } from "./times";

const reader = (kinds: number[]) => {
  const reads: number[] = [];
  return { kindOf: (row: number) => (reads.push(row), kinds[row]!), reads };
};

test("all DOS times give the header note and no marks", () => {
  const { kindOf } = reader([TimeKind.DOS, TimeKind.NONE, TimeKind.DOS]);
  const kinds = new TimeKinds();
  kinds.scan(kindOf, 3);
  expect(kinds.dosOnly).toBe(true);
  expect(kinds.mixed).toBe(false);
});

test("DOS times and zoned times give the marks and no header note", () => {
  const { kindOf, reads } = reader([TimeKind.DOS, TimeKind.EXTENDED, TimeKind.DOS]);
  const kinds = new TimeKinds();
  kinds.scan(kindOf, 3);
  expect(kinds.mixed).toBe(true);
  expect(kinds.dosOnly).toBe(false);
  // It stops when it found both kinds.
  expect(reads).toEqual([0, 1]);
});

test("zoned times only give neither", () => {
  const { kindOf } = reader([TimeKind.NTFS, TimeKind.UNIX, TimeKind.NONE]);
  const kinds = new TimeKinds();
  kinds.scan(kindOf, 3);
  expect(kinds.mixed).toBe(false);
  expect(kinds.dosOnly).toBe(false);
});

test("a growing listing reads each row one time", () => {
  const { kindOf, reads } = reader([TimeKind.DOS, TimeKind.DOS, TimeKind.UNIX]);
  const kinds = new TimeKinds();
  kinds.scan(kindOf, 2);
  expect(kinds.dosOnly).toBe(true);
  kinds.scan(kindOf, 2);
  kinds.scan(kindOf, 3);
  expect(kinds.mixed).toBe(true);
  expect(reads).toEqual([0, 1, 2]);
});
