// The choice of the caches that the service worker keeps. Only `sw.ts`
// imports this module, so the build puts it in `sw.js`. An import from the
// page would make it a shared chunk, and a classic service worker cannot
// load one.

/** The names of the app shell caches start with this text. The version
 *  follows it. */
export const CACHE_PREFIX = "zipscope-shell-";

/** The key of the entry that marks a cache whose version was activated. A
 *  version that waited and then went (a newer version came first) has no
 *  mark. */
export const ACTIVATED = "/zipscope-shell-activated";

/**
 * Returns the caches to remove when the cache `current` activates. `names`
 * are the shell caches in the order that they were made. The caches made
 * before `current` go, except the newest activated one: a tab of that
 * version can still be open. A cache made after `current` is of a newer
 * version that installs or waits, so it stays.
 */
export function staleCaches(
  names: readonly string[],
  current: string,
  activated: ReadonlySet<string>,
): string[] {
  const older = names.slice(0, Math.max(0, names.indexOf(current)));
  const kept = older.findLast((name) => activated.has(name));
  return older.filter((name) => name !== kept);
}
