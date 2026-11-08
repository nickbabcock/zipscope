import { expect, test, vi } from "vitest";
import { applyUpdate, watchUpdate } from "./update";

/** A service worker of the fake registration. */
class FakeWorker extends EventTarget {
  state: ServiceWorkerState = "installing";
  posted: unknown[] = [];
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  /** Moves to `state`, as the browser does. */
  move(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeRegistration extends EventTarget {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  /** A new version starts to install. */
  found(): FakeWorker {
    const next = new FakeWorker();
    this.installing = next;
    this.dispatchEvent(new Event("updatefound"));
    return next;
  }
}

class FakeContainer extends EventTarget {
  controller: object | null;
  registration = new FakeRegistration();
  register = vi.fn((_url: string) => Promise.resolve(this.registration));
  constructor(controlled: boolean) {
    super();
    this.controller = controlled ? {} : null;
  }
}

type Container = Parameters<typeof watchUpdate<ServiceWorkerRegistration>>[0];

test("a version that waits at the start shows the notice", async () => {
  const container = new FakeContainer(true);
  container.registration.waiting = new FakeWorker();
  const onReady = vi.fn();
  await watchUpdate(container as unknown as Container, "/sw.js", onReady);
  expect(container.register).toHaveBeenCalledWith("/sw.js");
  expect(onReady).toHaveBeenCalledWith(container.registration);
});

test("a version that installs later shows the notice when it is installed", async () => {
  const container = new FakeContainer(true);
  const onReady = vi.fn();
  await watchUpdate(container as unknown as Container, "/sw.js", onReady);
  expect(onReady).not.toHaveBeenCalled();
  const next = container.registration.found();
  expect(onReady).not.toHaveBeenCalled();
  next.move("installed");
  expect(onReady).toHaveBeenCalledTimes(1);
});

test("a page with no controller gets no notice", async () => {
  const container = new FakeContainer(false);
  container.registration.waiting = new FakeWorker();
  const onReady = vi.fn();
  await watchUpdate(container as unknown as Container, "/sw.js", onReady);
  container.registration.found().move("installed");
  expect(onReady).not.toHaveBeenCalled();
});

test("a blocked registration with no registration object gives undefined", async () => {
  const container = new FakeContainer(true);
  container.register.mockResolvedValueOnce(undefined as unknown as FakeRegistration);
  await expect(
    watchUpdate(container as unknown as Container, "/sw.js", vi.fn()),
  ).resolves.toBeUndefined();
});

test("a refused registration gives undefined", async () => {
  const container = new FakeContainer(true);
  container.register.mockRejectedValueOnce(new DOMException("blocked", "SecurityError"));
  await expect(
    watchUpdate(container as unknown as Container, "/sw.js", vi.fn()),
  ).resolves.toBeUndefined();
});

test("Reload activates the waiting version and reloads only after the controller changed", async () => {
  const container = new FakeContainer(true);
  const waiting = new FakeWorker();
  container.registration.waiting = waiting;
  const reload = vi.fn();
  const done = applyUpdate(
    container.registration as unknown as ServiceWorkerRegistration,
    container,
    reload,
  );
  expect(waiting.posted).toEqual([{ type: "zipscope-skip-waiting" }]);
  await Promise.resolve();
  expect(reload).not.toHaveBeenCalled();
  container.dispatchEvent(new Event("controllerchange"));
  await done;
  expect(reload).toHaveBeenCalledTimes(1);
});

test("Reload with no waiting version reloads at once", async () => {
  const container = new FakeContainer(true);
  const reload = vi.fn();
  await applyUpdate(
    container.registration as unknown as ServiceWorkerRegistration,
    container,
    reload,
  );
  expect(reload).toHaveBeenCalledTimes(1);
});
