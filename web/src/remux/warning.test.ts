/*
ASSUMED API
web/src/remux/text.ts:
  export const COMPATIBILITY_WARNING: string
    The warning that the remux dialog shows before the user saves a
    Zstandard copy.
  export function remuxFileName(archiveName: string): string
    The suggested name of the copy. It must not be the source name, so
    that a save does not replace the source archive.

The implementer can rename these. Do not weaken an expectation without a
written reason.
*/
import { expect, test } from "vitest";
import { COMPATIBILITY_WARNING, remuxFileName } from "./text";

test("the warning names zstd, method 93 and Windows Explorer", () => {
  expect(COMPATIBILITY_WARNING).toMatch(/\bzstd\b|Zstandard/i);
  expect(COMPATIBILITY_WARNING).toMatch(/\b93\b/);
  expect(COMPATIBILITY_WARNING).toContain("Windows Explorer");
  // It says that many tools cannot read it, not that one tool cannot.
  expect(COMPATIBILITY_WARNING).toMatch(/many/i);
  expect(COMPATIBILITY_WARNING).toMatch(/can(?:no|')t|cannot|not able/i);
});

test.each([["data.zip"], ["DATA.ZIP"], ["archive"], ["a.b.zip"], [".zip"], ["release.jar"]])(
  "the copy of %s does not get the source name",
  (name) => {
    const copy = remuxFileName(name);
    expect(copy).not.toBe(name);
    expect(copy.toLowerCase()).not.toBe(name.toLowerCase());
    expect(copy.length).toBeGreaterThan(0);
    expect(copy).not.toMatch(/[/\\]/);
  },
);
