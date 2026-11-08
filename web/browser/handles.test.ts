// The handle store in a real IndexedDB, with file handles of the origin
// private file system: the retention rule, the list of recent archives and
// the clear.
import { beforeEach, expect, test } from "vitest";
import {
  clearHandles,
  forgetHandle,
  HANDLE_MAX_AGE_MS,
  loadHandle,
  pruneHandles,
  RECENT_ARCHIVES,
  recentArchives,
  saveHandle,
} from "../src/lifecycle/remember";

async function handle(name: string): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getFileHandle(name, { create: true });
}

/** A file of `bytes` bytes, as the app opens it. */
const fileOf = (name: string, bytes = 1) => new File([new Uint8Array(bytes)], name);

/** The names in the store, sorted. */
async function keys(): Promise<string[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("zipscope", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("handles").objectStore("handles").getAllKeys();
      request.onsuccess = () =>
        resolve((request.result as [string, number][]).map(([name]) => name).sort());
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Waits for the next task, with no timer clamp. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Deletes the store. */
function clear(): Promise<void> {
  return new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("zipscope");
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

beforeEach(clear);

test("the store keeps the newest archives, also the one just saved at the same time", async () => {
  const file = await handle("a.zip");
  const now = 1_000_000;
  for (let index = 0; index < RECENT_ARCHIVES; index++) {
    await saveHandle(fileOf(`${index}.zip`), file, now);
  }
  // Same time as all the others, and its key sorts last: the new one
  // stays, so the tie does not go by the key order.
  await saveHandle(fileOf("zzz.zip"), file, now);
  const left = await keys();
  expect(left).toHaveLength(RECENT_ARCHIVES);
  expect(left).toContain("zzz.zip");
  expect(await loadHandle({ name: "zzz.zip", bytes: 1 }, now)).toBeInstanceOf(FileSystemFileHandle);
});

test("one archive has one record, and the list shows the newest first", async () => {
  const file = await handle("b.zip");
  await saveHandle(fileOf("one.zip", 3), file, 100);
  await saveHandle(fileOf("two.zip", 5), file, 200);
  // A second open of the same archive, as from another tab.
  await saveHandle(fileOf("one.zip", 3), file, 300);
  const list = await recentArchives(300);
  expect(list.map(({ name, bytes, at }) => ({ name, bytes, at }))).toEqual([
    { name: "one.zip", bytes: 3, at: 300 },
    { name: "two.zip", bytes: 5, at: 200 },
  ]);
  expect(list[0]!.handle).toBeInstanceOf(FileSystemFileHandle);
  // The same name with another size is another archive.
  await saveHandle(fileOf("one.zip", 4), file, 400);
  expect(await keys()).toEqual(["one.zip", "one.zip", "two.zip"]);
});

test("records older than the age limit go and are not used", async () => {
  const file = await handle("c.zip");
  const start = 5_000_000;
  await saveHandle(fileOf("old.zip"), file, start);
  await saveHandle(fileOf("fresh.zip"), file, start + HANDLE_MAX_AGE_MS);
  const later = start + HANDLE_MAX_AGE_MS + 1;
  // Older than the limit, but not removed yet: it is not used.
  expect(await loadHandle({ name: "old.zip", bytes: 1 }, later)).toBeUndefined();
  expect(await loadHandle({ name: "fresh.zip", bytes: 1 }, later)).toBeInstanceOf(
    FileSystemFileHandle,
  );
  expect((await recentArchives(later)).map(({ name }) => name)).toEqual(["fresh.zip"]);
  await pruneHandles(later);
  expect(await keys()).toEqual(["fresh.zip"]);
});

test("a record of an older form goes at the next prune", async () => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("zipscope", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("handles", "readwrite");
    transaction.objectStore("handles").put({ handle: null, at: 10 }, "session-id");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
  expect(await recentArchives(10)).toEqual([]);
  await pruneHandles(10);
  expect(await keys()).toEqual([]);
});

test("forget removes one archive, and clear removes all of them", async () => {
  const file = await handle("d.zip");
  for (const name of ["a.zip", "b.zip", "c.zip"]) await saveHandle(fileOf(name), file, 10);
  await forgetHandle({ name: "b.zip", bytes: 1 });
  expect(await keys()).toEqual(["a.zip", "c.zip"]);
  await clearHandles();
  expect(await keys()).toEqual([]);
  expect(await recentArchives(10)).toEqual([]);
  expect(await loadHandle({ name: "a.zip", bytes: 1 }, 10)).toBeUndefined();
});

test("two saves at the same moment, as from two tabs, keep both archives", async () => {
  const file = await handle("e.zip");
  const now = 9_000_000;
  // The second save starts after a different number of tasks in each
  // round, so that it comes between each two steps of the first save.
  for (let delay = 0; delay < 40; delay++) {
    await clear();
    // The store is full, so each save also deletes an older record.
    for (let index = 0; index < RECENT_ARCHIVES; index++) {
      await saveHandle(fileOf(`s${index}.zip`), file, now - 1000);
    }
    const later = async () => {
      for (let task = 0; task < delay; task++) await nextTask();
      await saveHandle(fileOf("tab-b.zip"), file, now);
    };
    await Promise.all([saveHandle(fileOf("tab-a.zip"), file, now), later()]);
    const left = await keys();
    expect(left, `delay ${delay}`).toHaveLength(RECENT_ARCHIVES);
    expect(left, `delay ${delay}`).toEqual(expect.arrayContaining(["tab-a.zip", "tab-b.zip"]));
  }
});
