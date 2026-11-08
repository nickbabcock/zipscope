// The registration of the service worker and the update notice.
//
// In a production build, App registers `sw.js` after the first work of
// the page (see `registerWorker` in `App.tsx`). When a new version is
// installed and waits, the map margin shows the update notice with a
// Reload control. The page never reloads on its own, because a
// reload loses the open archive. A plain reload of the browser does not
// activate the new version while this tab is open, so the control asks
// the new version to activate first.

/** The parts of `navigator.serviceWorker` that the notice uses. */
export type UpdateContainer = Pick<
  ServiceWorkerContainer,
  "register" | "controller" | "addEventListener"
>;

/** The parts of a registration that the notice uses. */
export type UpdateRegistration = Pick<
  ServiceWorkerRegistration,
  "waiting" | "installing" | "addEventListener"
>;

/**
 * Registers the service worker at `url`, and calls `onReady` when a new
 * version waits. A page with no controller (a first visit, or a reload
 * that bypassed the service worker) came from the network, so it has the
 * newest version and gets no notice. Resolves with the registration, or
 * with undefined when the registration failed (for example, a private
 * window in some browsers, or a blocked registration that gives no
 * registration object).
 */
export async function watchUpdate<R extends UpdateRegistration>(
  container: Omit<UpdateContainer, "register"> & {
    register: (url: string) => Promise<R>;
  },
  url: string,
  onReady: (registration: R) => void,
): Promise<R | undefined> {
  try {
    const registration = await container.register(url);
    if (registration.waiting !== null && container.controller !== null) onReady(registration);
    registration.addEventListener("updatefound", () => {
      const next = registration.installing;
      next?.addEventListener("statechange", () => {
        if (next.state === "installed" && container.controller !== null) onReady(registration);
      });
    });
    return registration;
  } catch {
    return undefined;
  }
}

/**
 * Activates the waiting version, and then calls `reload`. When no version
 * waits (Reload in another tab activated it), it reloads at once. Other
 * tabs do not reload: they keep their notice.
 *
 * Limits: while a tab streams a download, the new version activates and
 * this tab reloads only after the download ends. When the waiting version
 * goes before it activates (a newer version came first), no change of the
 * controller comes, and nothing occurs. The newer version shows the notice
 * again.
 */
export async function applyUpdate(
  registration: Pick<UpdateRegistration, "waiting">,
  container: Pick<UpdateContainer, "addEventListener">,
  reload: () => void,
): Promise<void> {
  const waiting = registration.waiting;
  if (waiting !== null) {
    const changed = new Promise<void>((resolve) =>
      container.addEventListener("controllerchange", () => resolve(), { once: true }),
    );
    waiting.postMessage({ type: "zipscope-skip-waiting" });
    await changed;
  }
  reload();
}
