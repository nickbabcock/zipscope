// The chunk of the Archive panel. The preview pane loads it
// lazily, and the front door preloads it with the workers, so that the
// panel also opens after the network goes.

/** Loads the Archive panel module. */
export function loadArchivePanel() {
  return import("../archive/ArchivePanel");
}
