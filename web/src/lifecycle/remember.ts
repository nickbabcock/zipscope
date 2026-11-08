// What a tab keeps about its archives for a reload and for deep links. The history entries keep the location in the archive,
// but not the file. After a reload, the front door offers to reopen the
// file, and a matching archive gets its location back.
//
// - The identity of each archive goes in `sessionStorage`, by session id.
//   It survives a reload of the tab, and no other tab can read it.
// - A file handle (Chromium only) goes in IndexedDB, by the name and the
//   size of the archive. With it, the reopen action is one permission
//   prompt, not a file picker. The reload of a tab finds the handle through
//   the identity of its archive. The front door lists the same records as
//   the recent archives of all tabs. The store keeps the 10 newest
//   archives, each for at most 30 days.
// - Limit: two different archives with the same name and size share one
//   record, so the newer one replaces the older one. A reload of the tab of
//   the older one then gets the newer file. The match below sees that it is
//   a different archive, and the file starts at its root. A file that
//   changed its size after an open is a second record. A reopen from the
//   list removes that old record, but an open from the picker or a drop
//   does not.
//
// Matching: the same name, the same size and the same SHA-256 of the last
// TAIL_BYTES of the file. These bytes hold the end of central directory
// record, the zip64 records and the archive comment, and the end of the
// central directory itself. Thus a different archive with the same name
// and size does not match, and the check reads at most 128 KiB, also for a
// large archive. The modified time is not part of the match: a copy of the
// same archive (a second download) has a different time but the same
// entries.

/** The bytes at the end of the file that the match hashes. */
export const TAIL_BYTES = 128 * 1024;
/** The most archive identities that a tab keeps. Older ones go. */
export const KEPT_ARCHIVES = 16;

/** The identity of an archive for the match. */
export interface ArchiveIdentity {
  name: string;
  bytes: number;
  /** The SHA-256 of the last TAIL_BYTES, as hex. */
  tail: string;
}

/** Returns the identity of `file`. */
export async function identify(file: File): Promise<ArchiveIdentity> {
  const tail = await file.slice(Math.max(0, file.size - TAIL_BYTES)).arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", tail));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { name: file.name, bytes: file.size, tail: hex };
}

/** True when two identities are of the same archive. */
export function sameArchive(a: ArchiveIdentity | undefined, b: ArchiveIdentity): boolean {
  return a !== undefined && a.name === b.name && a.bytes === b.bytes && a.tail === b.tail;
}

const STORAGE_KEY = "zipscope:archives";

type Kept = Record<string, ArchiveIdentity & { at: number }>;

function readKept(storage: Storage): Kept {
  try {
    const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    return typeof value === "object" && value !== null ? (value as Kept) : {};
  } catch {
    return {};
  }
}

/** Keeps the identity of the archive of `session`. */
export function rememberArchive(
  session: string,
  identity: ArchiveIdentity,
  storage: Storage = sessionStorage,
): void {
  const kept = readKept(storage);
  delete kept[session];
  // The new archive is first, also when an older one has the same time.
  const newest = [
    [session, { ...identity, at: Date.now() }] as const,
    ...Object.entries(kept).sort(([, a], [, b]) => b.at - a.at),
  ].slice(0, KEPT_ARCHIVES);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // A full or blocked storage only loses the restore after a reload.
  }
}

/** Returns the identity of the archive of `session`, or undefined. */
export function rememberedArchive(
  session: string,
  storage: Storage = sessionStorage,
): ArchiveIdentity | undefined {
  const value = readKept(storage)[session];
  if (
    typeof value?.name !== "string" ||
    typeof value.bytes !== "number" ||
    typeof value.tail !== "string"
  ) {
    return undefined;
  }
  return { name: value.name, bytes: value.bytes, tail: value.tail };
}

/** The permission calls of a file handle (Chromium). The DOM types of
 *  TypeScript do not have them yet. */
interface PermissionHandle extends FileSystemFileHandle {
  queryPermission?(options: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "read" }): Promise<PermissionState>;
}

/** True when this browser can keep file handles. */
export function keepsHandles(scope: typeof globalThis = globalThis): boolean {
  return typeof scope.FileSystemFileHandle === "function" && typeof scope.indexedDB === "object";
}

const DB_NAME = "zipscope";
const STORE = "handles";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB did not open"));
  });
}

/** Runs one request on the handle store. */
async function onStore<T>(
  mode: IDBTransactionMode,
  call: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = call(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
  } finally {
    db.close();
  }
}

/** The most archives that the store keeps. The front door lists them. */
export const RECENT_ARCHIVES = 10;

/**
 * The longest time that the store keeps a handle. A handle names an archive
 * that the user opened, so it does not stay longer than the list of recent
 * archives has a use for it.
 */
export const HANDLE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** An archive that the store keeps: its handle, and the name and the size
 *  of the file when it opened. */
export interface RecentArchive {
  handle: FileSystemFileHandle;
  name: string;
  bytes: number;
  /** The time of the last open, in ms since the epoch. */
  at: number;
}

/** The key of an archive in the store. One archive has one record, also
 *  when many tabs opened it. */
const keyOf = (archive: Pick<RecentArchive, "name" | "bytes">): IDBValidKey => [
  archive.name,
  archive.bytes,
];

/** True when `value` is a record of the store that is not older than
 *  HANDLE_MAX_AGE_MS. */
function isKept(value: unknown, now: number): value is RecentArchive {
  const record = value as Partial<RecentArchive> | undefined;
  return (
    typeof record?.at === "number" &&
    now - record.at <= HANDLE_MAX_AGE_MS &&
    typeof record.name === "string" &&
    typeof record.bytes === "number" &&
    record.handle instanceof FileSystemFileHandle
  );
}

/**
 * Removes the records that are older than HANDLE_MAX_AGE_MS or that are not
 * valid, and keeps the RECENT_ARCHIVES newest, in one transaction. With
 * `add`, the transaction first puts that record, which is the newest. A
 * second tab cannot write between the read and the deletes.
 */
function prune(db: IDBDatabase, now: number, add?: RecentArchive): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    if (add !== undefined) store.put(add, keyOf(add));
    const kept: { key: IDBValidKey; at: number; added: boolean }[] = [];
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const next = cursor.result;
      if (next !== null) {
        const value: unknown = next.value;
        if (!isKept(value, now)) {
          next.delete();
        } else {
          const added = add !== undefined && value.name === add.name && value.bytes === add.bytes;
          kept.push({ key: next.key, at: value.at, added });
        }
        next.continue();
        return;
      }
      // The record that this call added is first, also at the same time.
      kept.sort((a, b) => b.at - a.at || Number(b.added) - Number(a.added));
      for (const { key } of kept.slice(RECENT_ARCHIVES)) store.delete(key);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write aborted"));
  });
}

/** Keeps the handle of `file` as the newest archive, and removes the old
 *  records (see `prune`). */
export async function saveHandle(
  file: File,
  handle: FileSystemFileHandle,
  now = Date.now(),
): Promise<void> {
  if (!keepsHandles()) return;
  try {
    const db = await database();
    try {
      await prune(db, now, { handle, name: file.name, bytes: file.size, at: now });
    } finally {
      db.close();
    }
  } catch {
    // Without the handle, the reopen action opens the file picker.
  }
}

/** Removes the old records. App calls it in idle time after the start. */
export async function pruneHandles(now = Date.now()): Promise<void> {
  if (!keepsHandles()) return;
  try {
    const db = await database();
    try {
      await prune(db, now);
    } finally {
      db.close();
    }
  } catch {
    // A store that does not open has nothing to remove.
  }
}

/** Returns the kept archives, the newest first. A record older than
 *  HANDLE_MAX_AGE_MS is not in the list, also before it is removed. */
export async function recentArchives(now = Date.now()): Promise<RecentArchive[]> {
  if (!keepsHandles()) return [];
  try {
    const values = await onStore("readonly", (store) => store.getAll());
    return values
      .filter((value): value is RecentArchive => isKept(value, now))
      .sort((a, b) => b.at - a.at)
      .slice(0, RECENT_ARCHIVES);
  } catch {
    return [];
  }
}

/** Returns the handle of `archive`, or undefined. A handle older than
 *  HANDLE_MAX_AGE_MS is not used. */
export async function loadHandle(
  archive: Pick<RecentArchive, "name" | "bytes">,
  now = Date.now(),
): Promise<FileSystemFileHandle | undefined> {
  if (!keepsHandles()) return undefined;
  try {
    const value: unknown = await onStore("readonly", (store) => store.get(keyOf(archive)));
    return isKept(value, now) ? value.handle : undefined;
  } catch {
    return undefined;
  }
}

/** Removes the record of `archive`. */
export async function forgetHandle(archive: Pick<RecentArchive, "name" | "bytes">): Promise<void> {
  if (!keepsHandles()) return;
  await onStore("readwrite", (store) => store.delete(keyOf(archive))).catch(() => {});
}

/** Removes all records. */
export async function clearHandles(): Promise<void> {
  if (!keepsHandles()) return;
  await onStore("readwrite", (store) => store.clear()).catch(() => {});
}

/**
 * Returns the file of a kept handle. When the page has no read permission,
 * the browser asks the user one time (call it from a click). Returns
 * undefined when the user does not allow it, or when the file is gone.
 */
export async function fileOfHandle(handle: FileSystemFileHandle): Promise<File | undefined> {
  const asked = handle as PermissionHandle;
  try {
    let state = (await asked.queryPermission?.({ mode: "read" })) ?? "granted";
    if (state !== "granted" && asked.requestPermission !== undefined) {
      state = await asked.requestPermission({ mode: "read" });
    }
    return state === "granted" ? await handle.getFile() : undefined;
  } catch {
    return undefined;
  }
}
