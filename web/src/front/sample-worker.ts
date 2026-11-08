// Generates the demo archive in a module worker, so that a click does not
// freeze the page. The work is 19.7 MB of entry data and a zip of 9.17 MB.
import { buildSample } from "./sample";

// A rejected promise fires no `error` event on the Worker. A throw in a task
// does, so the page can tell the visitor.
void buildSample().then(
  (file) => postMessage(file),
  (error: unknown) =>
    setTimeout(() => {
      throw error;
    }),
);
