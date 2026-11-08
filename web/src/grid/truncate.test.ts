import { expect, test } from "vitest";
import { chainTruncate, ELLIPSIS, middleTruncate, pathTruncate } from "./truncate";

/** Each character is 1 px wide, so widths are character counts. */
const measure = (text: string) => Array.from(text).length;

test("a name that fits stays", () => {
  expect(middleTruncate("ingest-2026-10-21.jsonl", 23, measure)).toBe("ingest-2026-10-21.jsonl");
});

test("the extension and the characters before it stay", () => {
  const name = "ingest-2026-10-21.jsonl";
  const short = middleTruncate(name, 20, measure);
  expect(short).toBe(`ingest-${ELLIPSIS}-10-21.jsonl`);
  expect(measure(short)).toBeLessThanOrEqual(20);
  // Two names that differ only at the end stay different.
  expect(middleTruncate("ingest-2026-10-22.jsonl", 20, measure)).not.toBe(short);
});

test("two extensions stay together", () => {
  expect(middleTruncate("backup-of-the-database-0042.tar.gz", 22, measure)).toBe(
    `backup-o${ELLIPSIS}e-0042.tar.gz`,
  );
});

test("a folder keeps its slash and the end of its name", () => {
  expect(middleTruncate("project-1.2.0/src/main/", 16, measure)).toBe(`project-${ELLIPSIS}c/main/`);
});

test("a narrow cell keeps the extension, then cuts the end", () => {
  expect(middleTruncate("ingest-2026-10-21.jsonl", 9, measure)).toBe(`in${ELLIPSIS}.jsonl`);
  expect(middleTruncate("ingest-2026-10-21.jsonl", 4, measure)).toBe(`ing${ELLIPSIS}`);
  expect(middleTruncate("no-extension-at-all", 10, measure)).toBe(`no-${ELLIPSIS}at-all`);
});

test("a cut does not split a surrogate pair", () => {
  const name = "😀😀😀😀😀😀😀😀😀😀.txt";
  const short = middleTruncate(name, 8, measure);
  expect(short.endsWith(".txt")).toBe(true);
  expect(short).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("the measure decides, not the character count", () => {
  // Wide characters are 2 px.
  const wide = (text: string) => Array.from(text).reduce((sum, c) => sum + (c === "W" ? 2 : 1), 0);
  const short = middleTruncate("WWWWWWWWWW-01.txt", 16, wide);
  expect(wide(short)).toBeLessThanOrEqual(16);
  expect(short.endsWith("-01.txt")).toBe(true);
});

test("a path cuts its folders first, from the start, and keeps the base name", () => {
  const path = "demo-app/lib/libdemo_store.so";
  expect(pathTruncate(path, 40, measure)).toEqual({ text: path, folder: 13 });
  // The nearest folder stays while it fits.
  expect(pathTruncate(path, 22, measure)).toEqual({
    text: `${ELLIPSIS}/lib/libdemo_store.so`,
    folder: 6,
  });
  expect(pathTruncate(path, 20, measure)).toEqual({
    text: `${ELLIPSIS}/libdemo_store.so`,
    folder: 2,
  });
  // A base name that does not fit is cut in the middle, with no folder.
  const short = pathTruncate(path, 12, measure);
  expect(short.folder).toBe(0);
  expect(measure(short.text)).toBeLessThanOrEqual(12);
});

test("a name with no folder, and a folder path, are one part", () => {
  expect(pathTruncate("readme.txt", 40, measure)).toEqual({ text: "readme.txt", folder: 0 });
  expect(pathTruncate("a/b/", 40, measure)).toEqual({ text: "a/b/", folder: 0 });
});

/** One pixel for each character. */
const measureChars = (text: string) => Array.from(text).length;

test("chainTruncate: a chain that fits stays", () => {
  expect(chainTruncate("a/b/", 4, measureChars)).toBe("a/b/");
  expect(chainTruncate("plain.bin", 9, measureChars)).toBe("plain.bin");
});

test("chainTruncate: a chain goes from its start and keeps the last folder", () => {
  const chain = "demo/module-000/component-00";
  expect(chainTruncate(chain, 25, measureChars)).toBe("…/module-000/component-00");
  expect(chainTruncate(chain, 20, measureChars)).toBe("…/component-00");
  expect(chainTruncate(`${chain}/`, 26, measureChars)).toBe("…/module-000/component-00/");
});

test("chainTruncate: a last folder that does not fit is cut in the middle", () => {
  const cut = chainTruncate("demo/module-with-a-long-name/", 16, measureChars);
  expect(cut.length).toBeLessThanOrEqual(16);
  expect(cut.endsWith("/")).toBe(true);
  expect(cut.startsWith("module")).toBe(true);
});

test("chainTruncate: a name with no folders is cut in the middle", () => {
  expect(chainTruncate("ingest-2026-10-21.jsonl", 21, measureChars)).toContain(ELLIPSIS);
  expect(chainTruncate("ingest-2026-10-21.jsonl", 21, measureChars).endsWith(".jsonl")).toBe(true);
});

/** The cut before the long-name change. The new cut must give its result. */
function wholeCut(text: string, width: number, measure: (text: string) => number): string {
  if (measure(text) <= width) return text;
  const chars = Array.from(text);
  const prefix = (count: number) => chars.slice(0, count).join("");
  const fit = (most: number, widthOf: (count: number) => number) => {
    let low = 0;
    let high = most;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (widthOf(middle) <= width) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const extension = Array.from(
    /(?:\.[\p{L}\p{N}_-]{1,10}){1,2}$|\/$/u.exec(text)?.[0] ?? "",
  ).length;
  for (const tail of [extension + 6, extension]) {
    const keep = Math.min(tail, chars.length - 1);
    const end = chars.slice(chars.length - keep).join("");
    if (keep <= 0 || measure(ELLIPSIS + end) > width) continue;
    const head = fit(chars.length - keep, (count) => measure(prefix(count) + ELLIPSIS + end));
    if (head > 0 || tail === extension) return prefix(head) + ELLIPSIS + end;
  }
  return prefix(fit(chars.length, (count) => measure(prefix(count) + ELLIPSIS))) + ELLIPSIS;
}

/** A small generator with a fixed seed, so a failure repeats. */
function random(seed: number) {
  let state = seed;
  return (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * limit);
  };
}

test("a cut of a long name gives the result of a cut of the whole name", () => {
  // Characters of different widths, among them a zero width and a pair.
  const widths: Record<string, number> = { a: 7, W: 11, ".": 3, "/": 4, "😀": 13, "\u0301": 0 };
  const alphabet = Object.keys(widths);
  const wide = (text: string) => {
    let width = 0;
    for (const char of text) width += widths[char] ?? 7;
    return width;
  };
  const next = random(11);
  for (let round = 0; round < 3000; round++) {
    const length = [next(40), 200 + next(600), 1000 + next(3000)][round % 3]!;
    let name = "";
    for (let at = 0; at < length; at++) name += alphabet[next(alphabet.length)];
    if (round % 2 === 0) name += ".tar.gz";
    const width = [0, 1, 5, 40, 200, 700, 2000 + next(3000), 40_000][next(8)]!;
    const short = middleTruncate(name, width, wide);
    expect(short, `round ${round} width ${width}`).toBe(wholeCut(name, width, wide));
    const path = `${name.slice(0, next(length + 1))}/b/${name.slice(0, next(100))}`;
    const cut = pathTruncate(path, width, wide);
    expect(wide(cut.text) <= width || width < 20, `path round ${round}`).toBe(true);
  }
});

test("the cut of a name of 60,000 characters reads only near its room", () => {
  let read = 0;
  const counted = (text: string) => {
    read += text.length;
    return Array.from(text).length;
  };
  for (const name of [
    `${"x".repeat(60_000)}.exe`,
    `folder/${"x".repeat(60_000)}.exe`,
    `${"x/".repeat(30_000)}name.txt`,
    `${"\u2426".repeat(60_000)}.exe`,
  ]) {
    read = 0;
    const cut = pathTruncate(name, 400, counted);
    expect(Array.from(cut.text).length).toBeLessThanOrEqual(400);
    // The whole name once would be 60,000. Before this change, a cut read
    // about 20 times the name.
    expect(read, name.slice(0, 10)).toBeLessThan(30_000);
    expect(cut.text.endsWith(".exe") || cut.text.endsWith(".txt"), name.slice(0, 10)).toBe(true);
  }
});
