// The address part of the new-tab handoff (see `handoff.ts`). App loads
// this small module at once: the opener must open the tab in the click,
// and a new tab must read its id before the navigation writes the address.
// The channel code loads after that.

/** The address of a new tab that waits for a file has this hash. */
export const HANDOFF_HASH = "#handoff=";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True when `id` has the form of a one-time id. */
export function isHandoffId(id: unknown): id is string {
  return typeof id === "string" && ID.test(id);
}

/** Makes a one-time id and opens the new tab for it with `openTab`. Call
 *  it in the click: a browser blocks a new tab without a user action. */
export function openHandoffTab(openTab: (url: string) => void): string {
  const id = crypto.randomUUID();
  openTab(`/${HANDOFF_HASH}${id}`);
  return id;
}

/**
 * Takes the one-time id from the address of a new tab, and removes it, so
 * that the address bar shows `/` and a reload does not wait again.
 * Returns undefined when the address has no valid id.
 */
export function takeHandoffId(
  location: Pick<Location, "hash">,
  history: Pick<History, "state" | "replaceState">,
): string | undefined {
  if (!location.hash.startsWith(HANDOFF_HASH)) return undefined;
  const id = location.hash.slice(HANDOFF_HASH.length);
  history.replaceState(history.state, "", "/");
  return isHandoffId(id) ? id : undefined;
}
