// The flag of the compact door: one value per browser, with no file name.
// `public/door-boot.js` reads it before the first paint.
import { DOOR_FLAG_KEY } from "./strings";

const COMPACT = "compact";

/** Records that this browser opened a real file. */
export function rememberCompact(): void {
  try {
    localStorage.setItem(DOOR_FLAG_KEY, COMPACT);
  } catch {
    // A browser can refuse storage. The full door then shows.
  }
}

/** True when this browser opened a real file before. */
export function compactStored(): boolean {
  try {
    return localStorage.getItem(DOOR_FLAG_KEY) === COMPACT;
  } catch {
    return false;
  }
}
