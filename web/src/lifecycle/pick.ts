// The ways a file comes into the app with its file handle (Chromium): the
// File System Access picker, and a drop. With the handle, a reload of the
// tab can reopen the file with a permission prompt (see `remember.ts`).
// Other browsers use the file input and give no handle.
//
// A file launch (`launch.ts`) gives a file handle too, and goes through
// the same path of App.

/** A file and its handle, when the browser gave one. The handle of a drop
 *  comes later, so the field can change after the file came. */
export interface Incoming {
  file: File;
  /** The handle, after it came. */
  handle?: FileSystemFileHandle;
  /** Resolves with the handle, or with undefined when there is none. */
  handled: Promise<FileSystemFileHandle | undefined>;
}

/** A drop that came before the app started. `public/door-boot.js` keeps it. */
export interface KeptDrop {
  file: File;
  handle: Promise<FileSystemHandle | null> | null;
}

declare global {
  interface Window {
    /** Stops the guard of `door-boot.js` and returns its kept drop. */
    zipscopeTakeDrop?: () => KeptDrop | undefined;
  }
}

/** Returns the drop that came before the app started, and stops the guard
 *  that kept it. The app handles a later drop itself. */
export function takeKeptDrop(): Incoming | undefined {
  const kept = window.zipscopeTakeDrop?.();
  return kept === undefined ? undefined : incomingOfDrop(kept.file, kept.handle);
}

/** A file with no handle, for example from the file input. */
export function plainFile(file: File): Incoming {
  return { file, handled: Promise.resolve(undefined) };
}

/** The accepted types, as the file input has them. */
const TYPES = [
  {
    description: "Zip archive",
    accept: {
      "application/zip": [".zip", ".jar", ".apk", ".docx", ".whl", ".vsix", ".ipa"],
    },
  },
];

interface OpenPicker {
  showOpenFilePicker?: (options: {
    id?: string;
    types?: typeof TYPES;
  }) => Promise<FileSystemFileHandle[]>;
}

/**
 * Opens the File System Access picker. Resolves with the file, with
 * undefined when the user closed the picker, or with "input" when the
 * browser has no such picker or it failed: then the caller opens the file
 * input. Call it from a click.
 */
export async function pickFile(
  scope: OpenPicker = window as unknown as OpenPicker,
): Promise<Incoming | "input" | undefined> {
  if (scope.showOpenFilePicker === undefined) return "input";
  let handle: FileSystemFileHandle | undefined;
  try {
    [handle] = await scope.showOpenFilePicker({ id: "zipscope-open", types: TYPES });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return undefined;
    return "input";
  }
  if (handle === undefined) return undefined;
  const file = await handle.getFile().catch(() => undefined);
  return file === undefined ? undefined : { file, handle, handled: Promise.resolve(handle) };
}

interface HandleItem extends DataTransferItem {
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
}

/** Returns the first file of a drop. Call it in the drop handler: the
 *  items of the drop are valid only in that call. */
export function droppedFile(event: DragEvent): Incoming | undefined {
  const file = event.dataTransfer?.files[0];
  if (file === undefined) return undefined;
  const item = [...(event.dataTransfer?.items ?? [])].find((next) => next.kind === "file") as
    | HandleItem
    | undefined;
  return incomingOfDrop(file, item?.getAsFileSystemHandle?.() ?? null);
}

function incomingOfDrop(file: File, handle: Promise<FileSystemHandle | null> | null): Incoming {
  const incoming: Incoming = {
    file,
    handled: (handle ?? Promise.resolve(null)).then(
      (next) => {
        if (typeof FileSystemFileHandle !== "function") return undefined;
        if (!(next instanceof FileSystemFileHandle)) return undefined;
        incoming.handle = next;
        return next;
      },
      () => undefined,
    ),
  };
  return incoming;
}
