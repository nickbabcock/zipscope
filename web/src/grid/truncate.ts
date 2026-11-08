// Width-aware middle truncation of names. A name that does not fit keeps
// its start, its extension and the characters just before the extension,
// so `ingest-2026-10-21.jsonl` becomes `ingest-20…10-21.jsonl`, not
// `ingest-2026-10-2…`.

/** Returns the width of a text in pixels. */
export type Measure = (text: string) => number;

export const ELLIPSIS = "…";

/** Characters before the extension that the tail keeps. They tell apart
 *  names with the same start, for example dates and numbers. */
const TAIL_CHARACTERS = 6;

/** One or two extensions (`.gz`, `.tar.gz`), or the `/` of a folder. */
const EXTENSION = /(?:\.[\p{L}\p{N}_-]{1,10}){1,2}$|\/$/u;

/** Code units that one measure reads, when a long text is read in parts. It
 *  is more than the longest tail of a cut: two extensions of a dot and 10
 *  characters, and `TAIL_CHARACTERS`. */
const PART = 256;

/** Returns the end of the part that starts at `at`. It does not split a
 *  surrogate pair. */
function partEnd(text: string, at: number): number {
  const end = Math.min(at + PART, text.length);
  const code = text.charCodeAt(end - 1);
  return end < text.length && code >= 0xd800 && code <= 0xdbff ? end + 1 : end;
}

/**
 * Returns the width of `text`, or a larger number than `room` when it does
 * not fit. It stops at the part that passes the room, so a name of 60,000
 * characters costs a read of its first part. A short name costs one measure.
 */
function widthIn(text: string, room: number, measure: Measure): number {
  if (text.length <= PART) return measure(text);
  let used = 0;
  for (let at = 0; at < text.length && used <= room;) {
    const end = partEnd(text, at);
    used += measure(text.slice(at, end));
    at = end;
  }
  return used;
}

/**
 * Removes the middle of a long text that does not fit, where no cut can
 * reach it: after a start that is wider than the room, and before an end
 * that is wider than the room. The cuts then give the same result as on the
 * whole text, with work that depends on the room and not on the name.
 */
function withoutMiddle(text: string, width: number, measure: Measure): string {
  if (text.length <= 2 * PART) return text;
  let head = 0;
  let used = 0;
  do {
    const end = partEnd(text, head);
    used += measure(text.slice(head, end));
    head = end;
  } while (head < text.length && used <= width);
  let tail = text.length;
  used = 0;
  do {
    let start = Math.max(head, tail - PART);
    const code = text.charCodeAt(start);
    if (start > head && code >= 0xdc00 && code <= 0xdfff) start--;
    used += measure(text.slice(start, tail));
    tail = start;
  } while (tail > head && used <= width);
  return text.slice(0, head) + text.slice(tail);
}

/**
 * Returns `text`, shortened in the middle to fit in `width` pixels. The
 * extension and the characters before it stay. When not even the tail
 * fits, the end is cut instead.
 */
export function middleTruncate(text: string, width: number, measure: Measure): string {
  if (widthIn(text, width, measure) <= width) {
    return text;
  }
  const short = withoutMiddle(text, width, measure);
  // Code points, so that a cut never splits a surrogate pair.
  const chars = Array.from(short);
  const prefix = (count: number) => chars.slice(0, count).join("");
  /** Returns the most head characters, up to `most`, that fit. */
  const fit = (most: number, widthOf: (count: number) => number) => {
    let low = 0;
    let high = most;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (widthOf(middle) <= width) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  };
  const extension = Array.from(EXTENSION.exec(short)?.[0] ?? "").length;
  // First the extension with the characters before it, then the
  // extension only, so that some of the start shows.
  for (const tail of [extension + TAIL_CHARACTERS, extension]) {
    const keep = Math.min(tail, chars.length - 1);
    const end = chars.slice(chars.length - keep).join("");
    if (keep <= 0 || measure(ELLIPSIS + end) > width) {
      continue;
    }
    const head = fit(chars.length - keep, (count) => measure(prefix(count) + ELLIPSIS + end));
    if (head > 0 || tail === extension) {
      return prefix(head) + ELLIPSIS + end;
    }
  }
  return prefix(fit(chars.length, (count) => measure(prefix(count) + ELLIPSIS))) + ELLIPSIS;
}

/**
 * Returns a path, shortened to fit in `width` pixels, and the number of
 * characters of its folder part. The folder goes first, from its start, so
 * the base name stays whole and the nearest folders stay as long as they
 * fit: `demo/lib/libcore.so` becomes `…/lib/libcore.so`, then
 * `…/libcore.so`. Only when the base name itself does not fit is it cut,
 * in the middle. The path of a folder is one chain.
 */
export function pathTruncate(
  path: string,
  width: number,
  measure: Measure,
): { text: string; folder: number } {
  const slash = path.lastIndexOf("/");
  if (slash < 0 || slash === path.length - 1) {
    return { text: chainTruncate(path, width, measure), folder: 0 };
  }
  if (widthIn(path, width, measure) <= width) {
    return { text: path, folder: slash + 1 };
  }
  const base = path.slice(slash + 1);
  const prefix = `${ELLIPSIS}/`;
  const after = width - measure(prefix);
  let room = after - widthIn(base, after, measure);
  if (room < 0) {
    return { text: middleTruncate(base, width, measure), folder: 0 };
  }
  // From the nearest folder up. A deep path stops early.
  let start = slash + 1;
  while (start > 0) {
    const before = path.lastIndexOf("/", start - 2);
    const used = widthIn(path.slice(before + 1, start), room, measure);
    if (used > room) break;
    room -= used;
    start = before + 1;
  }
  const folder = prefix + path.slice(start, slash + 1);
  return { text: folder + base, folder: folder.length };
}

/**
 * Returns a compact chain of folders, shortened to fit in `width` pixels.
 * The chain is one name, so it has no folder part. It goes from its start
 * and keeps the last folder: `demo/module-000/component-00/` becomes
 * `…/module-000/component-00/`. Only when the last folder itself does not
 * fit is it cut, in the middle. A name with no folders is cut in the middle.
 */
export function chainTruncate(chain: string, width: number, measure: Measure): string {
  if (widthIn(chain, width, measure) <= width) {
    return chain;
  }
  const end = chain.endsWith("/") ? chain.length - 1 : chain.length;
  const slash = chain.lastIndexOf("/", end - 1);
  if (slash < 0) {
    return middleTruncate(chain, width, measure);
  }
  const prefix = `${ELLIPSIS}/`;
  const last = chain.slice(slash + 1);
  const after = width - measure(prefix);
  let room = after - widthIn(last, after, measure);
  if (room < 0) {
    return middleTruncate(last, width, measure);
  }
  // From the nearest folder up. A deep chain stops early.
  let start = slash + 1;
  while (start > 0) {
    const before = chain.lastIndexOf("/", start - 2);
    const used = widthIn(chain.slice(before + 1, start), room, measure);
    if (used > room) break;
    room -= used;
    start = before + 1;
  }
  return prefix + chain.slice(start);
}

/**
 * Measures text with the widths of its characters. It measures each
 * character one time for each font, so the table does no layout work for
 * each row. Kerning is not counted: a small margin covers it.
 */
export class TextWidths {
  private font = "";
  private readonly widths = new Map<string, number>();
  private context: CanvasRenderingContext2D | null = null;

  /** Sets the font, as the CSS `font` shorthand. A new font clears the
   *  widths. Returns true when the font changed. */
  setFont(font: string): boolean {
    if (font === this.font) {
      return false;
    }
    this.font = font;
    this.widths.clear();
    this.digit = -1;
    // A document canvas: an OffscreenCanvas in Firefox does not take
    // system fonts such as `system-ui`.
    this.context ??= document.createElement("canvas").getContext("2d");
    if (this.context !== null) {
      this.context.font = font;
    }
    return true;
  }

  /** Clears the widths, for example when a web font loaded. */
  clear(): void {
    this.widths.clear();
    this.digit = -1;
    if (this.context !== null) {
      this.context.font = this.font;
    }
  }

  /** The width of a digit. The table uses tabular digits, which a canvas
   *  cannot set, so each digit counts as the widest digit. */
  private digit = -1;

  private width(char: string): number {
    let value = this.widths.get(char);
    if (value === undefined) {
      value = this.context?.measureText(char).width ?? 0;
      this.widths.set(char, value);
    }
    return value;
  }

  readonly measure: Measure = (text) => {
    if (this.digit < 0) {
      this.digit = Math.max(...Array.from("0123456789", (char) => this.width(char)));
    }
    let width = 0;
    for (const char of text) {
      width += char >= "0" && char <= "9" ? this.digit : this.width(char);
    }
    return width;
  };
}

/** Returns the CSS `font` of an element. Some browsers give an empty
 *  `font` shorthand, so it is made from its parts. */
export function fontOf(element: Element): string {
  const style = getComputedStyle(element);
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}
