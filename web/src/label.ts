// One place where a name of an archive becomes text on the screen. Names
// and comments come from the archive, so an attacker can choose them.
//
// - A control, a bidirectional control or an invisible format character
//   shows as a visible mark, so `invoice<U+202E>fdp.exe` shows in its true
//   order as `invoice◊fdp.exe`. `crates/marks` has the same rule in Rust,
//   for the health finding and for the output names of an extraction.
// - A right-to-left part of a name gets an isolate with a fixed direction,
//   so the end of a name stays at the right: the base direction of the
//   label is always left to right, and `م.pdf.م.exe` does not show `.exe` at
//   the far left.
//
// The true name stays for search, copy and extraction. The title has the
// true name when it has no mark. If not, it spells each mark as `[U+202E]`,
// because a tooltip applies the same bidirectional rules as the page.

/** The mark: the lozenge. Its class in the bidirectional algorithm is neutral,
 *  so it does not reorder the text around it. The usual system fonts have it.
 *  Control Pictures (U+2400) and U+2426 are not in the fonts of many systems,
 *  where they show as an empty box. */
export const MARK = "\u25ca";

/** A hit is a character to mark or a right-to-left character. All other text
 *  costs this one scan. */
const WORK =
  // oxlint-disable-next-line no-control-regex, no-misleading-character-class -- These characters are what the scan looks for.
  /[\0-\x1f\x7f-\x9f\xad\u034f\u0590-\u08ff\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufb1d-\ufdff\ufe00-\ufe0f\ufe70-\ufeff\uffa0\ufff0-\ufffb]|[\ud802\ud803\ud83a\ud83b][\udc00-\udfff]|\ud82f[\udca0-\udca3]|\ud834[\udd73-\udd7a]|[\udb40-\udb43][\udc00-\udfff]/;

/** True for a code point that always shows as a mark: a control, a
 *  bidirectional control or an invisible format character. `always_marked` in
 *  `crates/marks` has the same rule. */
export function alwaysMarked(code: number): boolean {
  if (code < 0x80) return code < 0x20 || code === 0x7f;
  if (code < 0xa0 || code === 0xad || code === 0x34f || code === 0x61c) return true;
  if (code < 0x1100) return false;
  if (code < 0x2000) {
    return (
      code === 0x115f || code === 0x1160 || code === 0x17b4 || code === 0x17b5 || code === 0x180e
    );
  }
  if (code < 0x3000) {
    return (
      code === 0x200b ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f)
    );
  }
  if (code < 0xf000) return code === 0x3164;
  if (code < 0x10000)
    return code === 0xfeff || code === 0xffa0 || (code >= 0xfff0 && code <= 0xfffb);
  return (
    (code >= 0x1bca0 && code <= 0x1bca3) ||
    (code >= 0x1d173 && code <= 0x1d17a) ||
    (code >= 0xe0000 && code <= 0xe00ff) ||
    (code >= 0xe01f0 && code <= 0xe0fff)
  );
}

/** True for a joiner. It stays only between two characters that are not
 *  ASCII (Persian, Indic scripts, emoji). */
export function isJoiner(code: number): boolean {
  return code === 0x200c || code === 0x200d;
}

/** True for a variation selector. It stays only after a character that is not
 *  ASCII (emoji, CJK, Mongolian). */
export function isVariation(code: number): boolean {
  return (
    (code >= 0x180b && code <= 0x180d) ||
    code === 0x180f ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  );
}

const markOf = () => MARK;

function spelled(code: number): string {
  return `[U+${code.toString(16).toUpperCase().padStart(4, "0")}]`;
}

/** The most code units of a title with marks. A tooltip shows less than this,
 *  and each mark can take 8 code units, so a hostile name stays cheap. */
const TITLE_MOST = 4096;

/**
 * Returns `text` with each marked character replaced. It reads each code
 * point one time. It stops at about `most` code units, with an ellipsis.
 */
function replaced(
  text: string,
  mark: (code: number) => string,
  keep?: (code: number) => boolean,
  most = Infinity,
): string {
  let out = "";
  let from = 0;
  // True when the last character stays and is not ASCII.
  let attached = false;
  for (let at = 0; at < text.length;) {
    const code = text.codePointAt(at)!;
    const size = code > 0xffff ? 2 : 1;
    let marked: boolean = alwaysMarked(code) || (isVariation(code) && !attached);
    if (isJoiner(code) && !marked) {
      const next = text.codePointAt(at + size) ?? 0;
      marked =
        !attached || next < 0x80 || alwaysMarked(next) || isJoiner(next) || isVariation(next);
    }
    if (marked && keep?.(code) !== true) {
      if (from < at) out += text.slice(from, at);
      out += mark(code);
      from = at + size;
      attached = false;
      if (out.length > most) return `${out}\u2026`;
    } else {
      attached = code >= 0x80 && !marked;
    }
    at += size;
  }
  if (from === 0) return text;
  return from < text.length ? out + text.slice(from) : out;
}

/** True when a name needs no work: it has no character to mark and no
 *  right-to-left character. This is the only cost of a normal name. */
export function isPlainName(name: string): boolean {
  return !WORK.test(name);
}

/** A base name of a Mac folder with a custom icon. */
const MAC_ICON = /(^|[/\\])(?:\._)?Icon\r$/;

/**
 * True when the health finding counts a name: it has a character that shows
 * as a mark, not counting a base name of exactly `Icon<CR>` or `._Icon<CR>`.
 * This file shows its mark and gives no warning. The core makes the count
 * (`counts_as_control` of `crates/core/src/text.rs`), and a test compares the
 * two sides.
 */
export function countsInFinding(name: string): boolean {
  const icon = MAC_ICON.exec(name);
  const rest = icon === null ? name : name.slice(0, icon.index + icon[1]!.length);
  return nameText(rest) !== rest;
}

/** Returns a name with its marks. The surfaces that cut a name to its room
 *  cut this text, then give the cut text to `directed`. */
export function nameText(name: string): string {
  return isPlainName(name) ? name : replaced(name, markOf);
}

const RIGHT_TO_LEFT = String.raw`(?:[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefe]|[\ud802\ud803\ud83a\ud83b][\udc00-\udfff])`;
/** From the first to the last right-to-left character of a path segment. */
const RIGHT_TO_LEFT_PART = new RegExp(`${RIGHT_TO_LEFT}(?:[^/]*${RIGHT_TO_LEFT})?`, "g");

const DOT = 0x2e;
const SLASH = 0x2f;
const QUOTE = 0x22;
/** The kind of each bracket: a positive number opens, a negative number
 *  closes. */
const BRACKETS = new Map<number, number>();
const PAIRS = [
  "()",
  "[]",
  "{}",
  "<>",
  "\u00ab\u00bb",
  "\u201c\u201d",
  "\u2018\u2019",
  "\u2039\u203a",
];
for (const [index, pair] of PAIRS.entries()) {
  BRACKETS.set(pair.charCodeAt(0), index + 1);
  BRACKETS.set(pair.charCodeAt(1), -index - 1);
}

/**
 * Returns the end of a right-to-left part after the numbers that follow it.
 * The run of digits and spaces must reach the next dot, the next slash or the
 * end. The dot stays out, so `.pdf` stays in its order. A dot before a digit
 * is in the number (a date, a version, `.7z`), so the part takes no number: a
 * number stays whole.
 */
function afterNumber(text: string, end: number): number {
  let last = end;
  for (let at = end; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code === DOT) {
      const next = text.charCodeAt(at + 1);
      return next >= 0x30 && next <= 0x39 ? end : last;
    }
    if (code === SLASH) return last;
    if (code >= 0x30 && code <= 0x39) last = at + 1;
    else if (code !== 0x20 && code !== 0xa0) return end;
  }
  return last;
}

/** The counts of `isolateOf`, one for each kind of bracket. A label takes
 *  them for a short time and they stay in one place, so a name with very many
 *  segments makes no garbage. */
const OPEN = new Int32Array(PAIRS.length + 1);
const CLOSE = new Int32Array(PAIRS.length + 1);
const NESTED = new Int32Array(PAIRS.length + 1);

/**
 * Returns the start and the end of the isolate for a right-to-left part.
 * A bracket or a straight quote with no pair in the part goes with its pair
 * in the same segment, because a pair that an isolate splits shows with the
 * two brackets in the same direction. The search stops at a dot and at a
 * slash, so no extension goes into the isolate, and the true end of the name
 * stays at the right. Each search reads each character one time.
 */
function isolateOf(text: string, start: number, end: number): [number, number] {
  OPEN.fill(0);
  CLOSE.fill(0);
  let quotes = 0;
  let opens = 0;
  let closes = 0;
  for (let at = start; at < end; at++) {
    const code = text.charCodeAt(at);
    if (code === QUOTE) quotes++;
    const kind = BRACKETS.get(code);
    if (kind === undefined) continue;
    if (kind > 0) {
      OPEN[kind]!++;
      opens++;
    } else if (OPEN[-kind]! > 0) {
      OPEN[-kind]!--;
      opens--;
    } else {
      CLOSE[-kind]!++;
      closes++;
    }
  }
  let oddQuote = quotes % 2 === 1;
  let after = end;
  if (opens > 0 || oddQuote) {
    NESTED.fill(0);
    for (let at = end; (opens > 0 || oddQuote) && at < text.length; at++) {
      const code = text.charCodeAt(at);
      if (code === DOT || code === SLASH) break;
      if (code === QUOTE && oddQuote) {
        oddQuote = false;
        after = at + 1;
      }
      const kind = BRACKETS.get(code);
      if (kind === undefined) continue;
      if (kind > 0) NESTED[kind]!++;
      else if (NESTED[-kind]! > 0) NESTED[-kind]!--;
      else if (OPEN[-kind]! > 0) {
        OPEN[-kind]!--;
        opens--;
        after = at + 1;
      }
    }
  }
  let before = start;
  if (closes > 0 || oddQuote) {
    NESTED.fill(0);
    for (let at = start - 1; (closes > 0 || oddQuote) && at >= 0; at--) {
      const code = text.charCodeAt(at);
      if (code === DOT || code === SLASH) break;
      if (code === QUOTE && oddQuote) {
        oddQuote = false;
        before = at;
      }
      const kind = BRACKETS.get(code);
      if (kind === undefined) continue;
      if (kind < 0) NESTED[-kind]!++;
      else if (NESTED[kind]! > 0) NESTED[kind]!--;
      else if (CLOSE[kind]! > 0) {
        CLOSE[kind]!--;
        closes--;
        before = at;
      }
    }
  }
  return [before, afterNumber(text, after)];
}

/**
 * Isolates each right-to-left part of a text that has its marks, in each
 * path segment. Thus the base direction of the label is left to right, an
 * extension after the part stays in its order at the right, and an
 * extension that starts with a digit (`.7z`, `.001`) does not join the
 * right-to-left part. The part also takes the pair of a bracket or a quote,
 * and a number at its end (see `isolateOf`). The characters are for display
 * only, so call this after the cut.
 */
export function directed(text: string): string {
  let out = "";
  let from = 0;
  for (const match of text.matchAll(RIGHT_TO_LEFT_PART)) {
    const [start, end] = isolateOf(text, match.index, match.index + match[0].length);
    out += `${text.slice(from, start)}\u2067${text.slice(start, end)}\u2069`;
    from = end;
  }
  return from === 0 && out === "" ? text : out + text.slice(from);
}

/** Returns the text of a name that `cut` shortens to its room. */
export function cutLabel(name: string, cut: (text: string) => string): string {
  return isPlainName(name) ? cut(name) : directed(cut(replaced(name, markOf)));
}

/** Returns the text of a name for a surface that does not cut it. */
export function nameLabel(name: string): string {
  return isPlainName(name) ? name : directed(replaced(name, markOf));
}

/** Returns the title of a name: the true name, or the name with each mark
 *  spelled, because a raw U+202E in a tooltip can spoof too. */
export function nameTitle(name: string): string {
  return isPlainName(name) ? name : replaced(name, spelled, undefined, TITLE_MOST);
}

/**
 * Returns the text of a comment. A comment is prose with real line breaks,
 * so a line feed, a carriage return and a tab stay as text layout, and a
 * carriage return ends a line in the same way as a line feed. All other
 * characters follow the rule of a name. A comment keeps its own direction:
 * the element has `dir="auto"`, which sets the direction of each line.
 */
export function commentText(text: string): string {
  if (isPlainName(text)) return text;
  return replaced(text.replace(/\r\n?/g, "\n"), markOf, (code) => code === 0x0a || code === 0x09);
}
