// File handler launches (Chromium, an installed app). The manifest has a
// file handler for `.zip` files with `launch_type: "multiple-clients"`, so
// each file opens in its own window, with one file. The browser opens the
// action URL `/?launch` and gives the file handle through
// `window.launchQueue`. The address mark lets the page skip the front
// door before the file comes.

/** The query of the action URL of the file handler. */
export const LAUNCH_SEARCH = "?launch";

/** A page with the mark and no file shows the front door after this time,
 *  for example when the user typed the address. */
export const LAUNCH_WAIT_MS = 5000;

/** The parts of `LaunchParams` that the app uses. */
export interface LaunchParams {
  files: readonly FileSystemHandle[];
}

/** The parts of `window.launchQueue` that the app uses. */
export interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

/**
 * Returns true when the address has the mark of a launch, and removes the
 * mark, so the address bar shows `/` and a reload shows the front door.
 */
export function takeLaunch(
  location: Pick<Location, "search">,
  history: Pick<History, "state" | "replaceState">,
): boolean {
  if (location.search !== LAUNCH_SEARCH) return false;
  history.replaceState(history.state, "", "/");
  return true;
}

/**
 * Gives the file of each launch to `onFile`, with its handle, so a reload
 * can reopen it. A launch with no file that the app can read (a launch of
 * the app itself) goes to `onNone`. A browser that gives more than one
 * file in a launch opens only the first: one tab shows one archive.
 */
export function watchLaunches(
  queue: LaunchQueue | undefined,
  onFile: (file: File, handle: FileSystemFileHandle) => void,
  onNone: () => void,
): void {
  queue?.setConsumer((params) => {
    const handle = params.files.find((next): next is FileSystemFileHandle => next.kind === "file");
    if (handle === undefined) {
      onNone();
      return;
    }
    handle.getFile().then(
      (file) => onFile(file, handle),
      () => onNone(),
    );
  });
}
