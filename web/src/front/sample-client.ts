// Runs the generator of the demo archive in a module worker. The front door
// loads the worker script when it shows, so that the sample also opens after a
// disconnect. The script does not run until a visitor asks for the sample.
// oxlint-disable-next-line import/default -- Vite makes this default export.
import workerUrl from "./sample-worker?worker&url";

/** Puts the worker script in the HTTP cache. Resolves with true when it
 *  loaded. */
export function warmSample(): Promise<boolean> {
  return fetch(workerUrl).then(
    (response) => response.ok,
    () => false,
  );
}

/** Generates the demo archive as a File. */
export function buildSample(): Promise<File> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<File>) => {
      worker.terminate();
      resolve(event.data);
    });
    worker.addEventListener("error", (event) => {
      worker.terminate();
      reject(new Error(event.message));
    });
  });
}
