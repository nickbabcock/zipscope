// Starts the app. The entry module loads this chunk only in a browser that
// can run Zipscope.
import { render } from "@solidjs/web";
import { App } from "./App";
import { takeDoor } from "./front/door-styles";

export function start(root: HTMLElement): void {
  // The static page goes and the app shows in one task, so no paint comes
  // between them.
  takeDoor();
  render(() => <App />, root);
}
