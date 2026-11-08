// The width of the preview pane: limits, keyboard steps and the value that
// the browser remembers.

export const PREVIEW_MIN = 280;
export const PREVIEW_MAX = 720;
/** The natural width of the hex view, about 440 px. The table keeps the
 *  rest, so the base names stay whole. */
export const PREVIEW_DEFAULT = 440;
/** One arrow key moves the splitter this far. */
export const PREVIEW_STEP = 16;

const STORAGE_KEY = "zipscope:preview-width";

/** Clamps a preview width to the limits. */
export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return PREVIEW_DEFAULT;
  }
  return Math.round(Math.min(PREVIEW_MAX, Math.max(PREVIEW_MIN, width)));
}

/**
 * Returns the width that the pane gets in a body of `available` pixels
 * (the table and the preview together). The table keeps `tableMin`
 * pixels (see `tableMinWidth`) when it can. The preview never goes below
 * `PREVIEW_MIN`.
 */
export function fitWidth(width: number, available: number, tableMin: number): number {
  return Math.max(PREVIEW_MIN, Math.min(clampWidth(width), available - tableMin));
}

/**
 * Returns the width after a key on the splitter, or undefined for a key
 * that the splitter does not use. The preview is on the right, so
 * ArrowLeft moves the splitter left and makes the preview wider.
 */
export function keyWidth(width: number, key: string): number | undefined {
  switch (key) {
    case "ArrowLeft":
      return clampWidth(width + PREVIEW_STEP);
    case "ArrowRight":
      return clampWidth(width - PREVIEW_STEP);
    case "Home":
      return PREVIEW_MIN;
    case "End":
      return PREVIEW_MAX;
    default:
      return undefined;
  }
}

/** Reads the remembered width. Storage can be blocked; then it uses the
 *  default. */
export function loadWidth(storage: Pick<Storage, "getItem"> | undefined): number {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    return text === null || text === undefined ? PREVIEW_DEFAULT : clampWidth(Number(text));
  } catch {
    return PREVIEW_DEFAULT;
  }
}

/** Remembers the width. A storage error is not a problem for the user. */
export function saveWidth(storage: Pick<Storage, "setItem"> | undefined, width: number): void {
  try {
    storage?.setItem(STORAGE_KEY, String(clampWidth(width)));
  } catch {
    // The width is a convenience. Without storage, it is not remembered.
  }
}

/** Returns local storage, or undefined when the browser blocks it. */
export function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
