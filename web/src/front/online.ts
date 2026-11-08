// The connection state for the map margin of the front door.
import { createSignal, onCleanup } from "solid-js";

/** Returns a signal that follows `navigator.onLine`. Call it in a
 *  component. */
export function createOnline(): () => boolean {
  const [online, setOnline] = createSignal(navigator.onLine);
  const update = () => setOnline(navigator.onLine);
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  onCleanup(() => {
    window.removeEventListener("online", update);
    window.removeEventListener("offline", update);
  });
  return online;
}
