// Tests of keyboard events that the shell and the search field share.

/** Returns true when a key goes to a text control, so a shortcut key must
 *  not act. */
export function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/** True when a modifier key other than Shift is down. */
export const modified = (event: KeyboardEvent): boolean =>
  event.altKey || event.ctrlKey || event.metaKey;
