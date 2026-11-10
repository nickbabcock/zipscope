// The "This browser can't run Zipscope" state.
// The entry module shows it in place of the app, before it loads the app:
// a browser below the floor can fail to parse the app, and a page that is
// not cross-origin isolated cannot start a worker with shared memory. Thus
// this module uses the DOM directly, with no Solid code.
//
// The page has the word mark, the reason, the supported browsers and the
// rest of the static page below them.
import * as stylex from "@stylexjs/stylex";
import { color, font, size, textSize } from "../theme/tokens.stylex";
import { page, takeDoor } from "./door-styles";
import { front } from "./strings";
import { missingFeatures } from "./support";
import type { Support } from "./support";

/** Makes an element with the class names of `style`. */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: { class?: string },
  text?: string,
): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.setAttribute("class", style.class ?? "");
  if (text !== undefined) made.textContent = text;
  return made;
}

/** Puts the unsupported state in `root`. */
export function renderUnsupported(root: HTMLElement, reason: Exclude<Support, "ok">): void {
  const shell = element("div", stylex.attrs(styles.shell));
  const bar = element("header", stylex.attrs(styles.bar));
  bar.append(element("h1", stylex.attrs(styles.word), "Zipscope"));

  const door = element("main", stylex.attrs(styles.door));
  // The ids and the state are the same as the front door had them, so that
  // the tests and the styles find this state.
  door.id = "front-door";
  door.dataset.state = "unsupported";
  door.dataset.reason = reason;

  const section = element("section", stylex.attrs(page.pitch));
  section.id = "unsupported";
  section.setAttribute("aria-labelledby", "unsupported-heading");
  const lede = element("div", stylex.attrs(page.lede));
  const heading = element("h2", stylex.attrs(page.unsupported), front.unsupported);
  heading.id = "unsupported-heading";
  const why = element(
    "p",
    stylex.attrs(page.subtitle),
    reason === "isolation" ? front.unsupportedIsolation : front.unsupportedBrowser,
  );
  why.id = "unsupported-reason";
  // The line that the user can act on is in ink; the reason is muted.
  lede.append(
    heading,
    why,
    element("p", stylex.attrs(page.subtitle, page.subtitleInk), front.supportedBrowsers),
  );
  const missing = reason === "browser" ? missingFeatures() : [];
  if (missing.length > 0) {
    const note = element("p", stylex.attrs(page.missing), front.unsupportedMissing(missing));
    note.id = "unsupported-missing";
    lede.append(note);
  }
  section.append(lede);
  door.append(section);

  // The static page goes. The word mark is the `h1` of this page.
  takeDoor();
  document.documentElement.dataset.door = "unsupported";

  // The isolation check of the e2e tests reads this element.
  const isolated = document.createElement("span");
  isolated.id = "cross-origin-isolated";
  isolated.hidden = true;
  isolated.textContent = String(globalThis.crossOriginIsolated === true);

  // The same frame as the other door states: the empty map margin.
  const margin = element("footer", stylex.attrs(styles.margin));
  shell.append(bar, door, margin, isolated);
  root.replaceChildren(shell);
  document.title = `${front.unsupported} – Zipscope`;
}

const styles = stylex.create({
  shell: {
    backgroundColor: color.ground,
    color: color.ink,
    display: "grid",
    fontFamily: font.ui,
    fontSize: textSize.body,
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: `${size.top} minmax(0, 1fr) ${size.status}`,
    height: "100dvh",
    lineHeight: 1.4,
    overflow: "hidden",
    WebkitFontSmoothing: "antialiased",
  },
  bar: {
    alignItems: "center",
    backgroundColor: color.panel,
    borderBottomColor: color.rule,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    boxSizing: "border-box",
    display: "flex",
    paddingInline: size.gutter,
  },
  margin: {
    backgroundColor: color.panel,
    borderTopColor: color.rule,
    borderTopStyle: "solid",
    borderTopWidth: 1,
    boxSizing: "border-box",
  },
  word: {
    fontSize: textSize.lead,
    fontWeight: 650,
    letterSpacing: "-0.01em",
    margin: 0,
  },
  door: {
    minHeight: 0,
    minWidth: 0,
    overflowY: "auto",
  },
});
