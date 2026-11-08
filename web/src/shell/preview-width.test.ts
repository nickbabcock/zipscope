import { describe, expect, test } from "vitest";
import {
  clampWidth,
  fitWidth,
  keyWidth,
  loadWidth,
  PREVIEW_DEFAULT,
  PREVIEW_MAX,
  PREVIEW_MIN,
  saveWidth,
} from "./preview-width";

describe("preview width", () => {
  test("clamps to 280 to 720 pixels", () => {
    expect(clampWidth(100)).toBe(PREVIEW_MIN);
    expect(clampWidth(5000)).toBe(PREVIEW_MAX);
    expect(clampWidth(400.4)).toBe(400);
    expect(clampWidth(Number.NaN)).toBe(PREVIEW_DEFAULT);
  });

  test("keeps room for the table, but not below the minimum", () => {
    expect(fitWidth(720, 1400, 572)).toBe(720);
    expect(fitWidth(720, 994, 572)).toBe(422);
    expect(fitWidth(720, 500, 572)).toBe(PREVIEW_MIN);
  });

  test("moves in 16px steps with the arrow keys", () => {
    expect(keyWidth(360, "ArrowLeft")).toBe(376);
    expect(keyWidth(360, "ArrowRight")).toBe(344);
    expect(keyWidth(712, "ArrowLeft")).toBe(PREVIEW_MAX);
    expect(keyWidth(290, "ArrowRight")).toBe(PREVIEW_MIN);
    expect(keyWidth(400, "Home")).toBe(PREVIEW_MIN);
    expect(keyWidth(400, "End")).toBe(PREVIEW_MAX);
    expect(keyWidth(400, "ArrowUp")).toBeUndefined();
  });

  test("remembers the width and survives blocked storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    expect(loadWidth(storage)).toBe(PREVIEW_DEFAULT);
    saveWidth(storage, 9000);
    expect(loadWidth(storage)).toBe(PREVIEW_MAX);
    saveWidth(storage, 432);
    expect(loadWidth(storage)).toBe(432);
    const blocked = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadWidth(blocked)).toBe(PREVIEW_DEFAULT);
    expect(() => saveWidth(blocked, 400)).not.toThrow();
    expect(loadWidth(undefined)).toBe(PREVIEW_DEFAULT);
  });
});
