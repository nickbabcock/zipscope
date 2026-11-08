import { describe, expect, test } from "vitest";
import { isParsing, phaseProgress, phaseText } from "./phase";
import type { ParsePhase } from "./phase";

describe("phaseText", () => {
  test.each<[ParsePhase, string, boolean]>([
    [{ kind: "opening" }, "Opening", true],
    [{ kind: "listing", progress: 0.426 }, "Listing 42%", true],
    [{ kind: "paused", progress: 0.5 }, "Paused", true],
    [{ kind: "listed", ms: 12.6 }, "Listed in 13 ms", false],
    [{ kind: "failed", rows: 0, message: "not a zip" }, "Cannot open: not a zip", false],
    [
      { kind: "failed", rows: 1200, message: "bad header" },
      "Stopped after 1,200 entries: bad header",
      false,
    ],
    [{ kind: "cancelled", rows: 3 }, "Cancelled after 3 entries", false],
  ])("%j", (phase, text, parsing) => {
    expect(phaseText(phase)).toBe(text);
    expect(isParsing(phase)).toBe(parsing);
  });

  test("only a running parse has progress", () => {
    expect(phaseProgress({ kind: "listing", progress: 0.3 })).toBe(0.3);
    expect(phaseProgress({ kind: "listed", ms: 1 })).toBe(0);
  });
});
