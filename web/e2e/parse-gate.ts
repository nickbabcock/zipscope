// Holds the parse worker between its batches, so that a test can act during a
// parse. The self-ping of the parse loop waits for a step from the test.
import type { Page } from "@playwright/test";

interface ParseGate {
  worker?: Worker;
  waits: number;
}

export async function pauseBetweenBatches(page: Page) {
  await page.addInitScript(() => {
    const state: ParseGate = { waits: 0 };
    Object.assign(window, { parseGateState: state });
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        const target = new URL(url, location.href).href;
        // Keep ordinary worker messages free. Hold only the self-ping.
        const prefix = `
        const pending = [];
        let gateOpen = false;
        const NativeChannel = MessageChannel;
        globalThis.MessageChannel = class extends NativeChannel {
          constructor() {
            super();
            const send = this.port2.postMessage.bind(this.port2);
            this.port2.postMessage = (...args) => {
              if (gateOpen) {
                send(...args);
                return;
              }
              pending.push(() => send(...args));
              postMessage({ parseGate: "waiting" });
            };
          }
        };
        addEventListener("message", (event) => {
          if (event.data?.parseGate === "step") {
            event.stopImmediatePropagation();
            pending.shift()?.();
          }
          if (event.data?.parseGate === "open") {
            event.stopImmediatePropagation();
            gateOpen = true;
            for (const step of pending.splice(0)) step();
          }
        });
        // The wrapped module adds its message listener
        // only after the dynamic import, so a Comlink call that arrives
        // first is lost and the app stays at "Opening". A plain module
        // worker does not lose it. Hold early messages and send them again
        // after the import. The expectations of the test do not change.
        const early = [];
        const hold = (event) => {
          event.stopImmediatePropagation();
          early.push(event);
        };
        addEventListener("message", hold);
      `;
        const suffix = `
        await import(${JSON.stringify(target)});
        removeEventListener("message", hold);
        for (const event of early) {
          dispatchEvent(new MessageEvent("message", { data: event.data, ports: [...event.ports] }));
        }
      `;
        const blob = new Blob([prefix, suffix], {
          type: "text/javascript",
        });
        const script = URL.createObjectURL(blob);
        super(script, { ...options, type: "module" });
        // The front door also starts a read worker in
        // idle time. The test waits for the preload, so the archive gets
        // the preloaded parse worker, which is the first worker. Only the
        // first worker gets the gate.
        state.worker ??= this;
        this.addEventListener("message", (event) => {
          if (event.data?.parseGate === "waiting") {
            event.stopImmediatePropagation();
            state.waits++;
          }
        });
        URL.revokeObjectURL(script);
      }
    };
  });
}

export const gate = (page: Page, step = false) =>
  page.evaluate((release) => {
    const state = (window as unknown as { parseGateState: ParseGate }).parseGateState;
    if (release) state.worker!.postMessage({ parseGate: "step" });
    return state.waits;
  }, step);

/** Ends the gate: the worker runs freely from now on. */
export const openGate = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { parseGateState: ParseGate }).parseGateState.worker!.postMessage({
      parseGate: "open",
    });
  });
