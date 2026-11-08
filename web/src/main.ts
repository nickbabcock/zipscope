// The entry module. It checks the browser first, and loads the app only
// when the browser can run it. Thus a browser below the floor, or a page
// that is not cross-origin isolated, gets a clear message and not a
// failure in the app code. The build preloads the app chunk (see
// `vite.config.ts`), so a supported browser does not wait for a second
// request.
import "./front/door.css";
import "./global.css";
import { checkSupport } from "./front/support";
import { renderUnsupported } from "./front/unsupported";

// The boot script shows one line when this module does not run.
document.documentElement.dataset.entry = "run";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Root element is missing");
}
const support = checkSupport();
if (support === "ok") {
  void import("./start").then(
    ({ start }) => start(root),
    () => document.getElementById("door-failed")?.removeAttribute("hidden"),
  );
} else {
  renderUnsupported(root, support);
}
