// The styles that the front door and the unsupported-browser page share,
// and the static page from `index.html`. This module has no Solid code, so
// the entry module can use it in a browser that cannot run the app.
import * as stylex from "@stylexjs/stylex";
import { color, textSize } from "../theme/tokens.stylex";
import { DOOR_IDS } from "./door-static";

/** The parts of the static page. */
export interface DoorParts {
  heading: HTMLElement | null;
  /** The line beside the word mark. */
  tagline: HTMLElement | null;
  /** The first view and the rest of the page. */
  page: HTMLElement | null;
  /** The rest of the page. */
  rest: HTMLElement | null;
}

let parts: DoorParts | undefined;

/** The first caller takes the parts out of the document and removes the
 *  static frame. The door then moves them where it needs them. */
export function takeDoor(): DoorParts {
  if (parts === undefined) {
    const heading = document.getElementById(DOOR_IDS.heading);
    const body = document.getElementById(DOOR_IDS.page);
    const tagline = document.getElementById(DOOR_IDS.tagline);
    parts = { heading, tagline, page: body, rest: document.getElementById(DOOR_IDS.rest) };
    heading?.remove();
    tagline?.remove();
    body?.remove();
    document.getElementById(DOOR_IDS.frame)?.remove();
  }
  return parts;
}

const NARROW = "@media (max-width: 640px)";
const SHORT = "@media (max-height: 560px)";

export const page = stylex.create({
  pitch: {
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    minHeight: "100%",
    paddingBlock: { default: 48, [NARROW]: 32, [SHORT]: 24 },
    paddingInline: { default: "clamp(16px, 7vw, 112px)", [NARROW]: 16 },
  },
  lede: {
    maxWidth: 1040,
  },
  subtitle: {
    color: color.inkMuted,
    fontSize: { default: textSize.subtitle, [NARROW]: textSize.lead },
    lineHeight: 1.45,
    marginBlock: 0,
    marginTop: { default: 20, [NARROW]: 14 },
    maxWidth: "60ch",
    textWrap: "pretty",
  },
  unsupported: {
    color: color.ink,
    fontSize: textSize.statement,
    fontWeight: 650,
    letterSpacing: "-0.03em",
    lineHeight: 1.05,
    margin: 0,
    maxWidth: "16ch",
    textWrap: "balance",
  },
  /** A line of the unsupported page that the user can act on. */
  subtitleInk: {
    color: color.ink,
  },
  /** The missing features: the detail that the user can look up. */
  missing: {
    color: color.inkMuted,
    fontSize: textSize.body,
    marginBlock: 0,
    marginTop: 14,
  },
  link: {
    borderRadius: 2,
    color: color.water,
    textDecorationLine: "underline",
    textDecorationThickness: 1,
    textUnderlineOffset: 3,
  },
});
