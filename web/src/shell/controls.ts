// Styles of the standard controls in the shell: buttons, icon buttons and
// pane header strips.
import * as stylex from "@stylexjs/stylex";
import { color, font, size, textSize } from "../theme/tokens.stylex";

const REDUCED = "@media (prefers-reduced-motion: reduce)";
const COARSE = "@media (pointer: coarse)";
/** The width of a strip from which its tools have text labels. */
const TOOL_LABELS = "@container tools (width >= 560px)";

export const controls = stylex.create({
  /** A default button: no fill of its own, so it sits flush on the
   *  ground, a panel or a night overlay, and a Rule Strong edge at 3:1 or
   *  more. */
  button: {
    alignItems: "center",
    backgroundColor: { default: "transparent", ":hover": color.raised },
    borderColor: color.ruleStrong,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: color.ink,
    columnGap: 6,
    cursor: "pointer",
    display: "inline-flex",
    flexShrink: 0,
    font: "inherit",
    height: 28,
    paddingInline: 10,
    whiteSpace: "nowrap",
  },
  iconButton: {
    alignItems: "center",
    backgroundColor: { default: "transparent", ":hover": color.raised },
    borderRadius: 6,
    borderStyle: "none",
    // Ink, so the thin strokes have 3:1. Muted and faint is for off only.
    color: { default: color.ink, ":disabled": color.inkMuted },
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    display: "inline-grid",
    // A button that can do nothing is faint (WCAG exempts it).
    opacity: { default: 1, ":disabled": 0.5 },
    flexShrink: 0,
    // A touch screen gets 36 px, the most that the 36 px strips hold.
    height: { default: 28, [COARSE]: 36 },
    justifyContent: "center",
    padding: 0,
    width: { default: 28, [COARSE]: 36 },
  },
  /** A tool of a strip with an icon and a text label. All tools on a strip
   *  line have this form. The text can go when the strip has no room. */
  tool: {
    alignItems: "center",
    backgroundColor: { default: "transparent", ":hover": color.raised },
    borderRadius: 6,
    borderStyle: "none",
    color: { default: color.ink, ":disabled": color.inkMuted },
    columnGap: 4,
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    display: "inline-flex",
    flexShrink: 0,
    font: "inherit",
    height: { default: 28, [COARSE]: 36 },
    justifyContent: "center",
    opacity: { default: 1, ":disabled": 0.5 },
    paddingBlock: 0,
    paddingInline: { default: 0, [TOOL_LABELS]: 6 },
    whiteSpace: "nowrap",
    width: { default: 28, [COARSE]: 36, [TOOL_LABELS]: "auto" },
  },
  toolLabel: {
    display: { default: "none", [TOOL_LABELS]: "inline" },
  },
  /** A tool that always has its text label. */
  toolLabelled: {
    paddingInline: 6,
    width: "auto",
  },
  /** The strip that chooses the text labels of its tools by its width. */
  toolStrip: {
    containerName: "tools",
    containerType: "inline-size",
  },
  /** The primary action: a `water` fill. Hover mixes the fill toward
   *  `ink`: darker in light, lighter at night, so the text contrast goes
   *  up, not down. */
  primary: {
    backgroundColor: {
      default: color.water,
      ":hover": `color-mix(in oklab, ${color.water} 85%, ${color.ink})`,
    },
    borderColor: "transparent",
    color: color.onWater,
    fontWeight: 600,
  },
  /** A toggle that is on: the fill and an edge, so a pressed button does not
   *  depend on the fill alone. It is neutral: it says a state, and it is not
   *  the loudest control of the strip. */
  pressed: {
    backgroundColor: color.raised,
    boxShadow: `inset 0 0 0 1px ${color.ruleStrong}`,
    color: color.ink,
  },
  focusRing: {
    outlineColor: color.focus,
    outlineOffset: { default: null, ":focus-visible": 1 },
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
  },
  strip: {
    alignItems: "center",
    borderBottomColor: color.rule,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    boxSizing: "border-box",
    columnGap: 6,
    display: "flex",
    height: size.strip,
    minWidth: 0,
    paddingInline: size.gutter,
    whiteSpace: "nowrap",
  },
  /** A legend label in a strip: small, upper case and muted. */
  label: {
    color: color.inkMuted,
    fontSize: textSize.label,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  /** A key hint, such as the "/" of the search field. */
  key: {
    // A key cap on the ground color, so the muted text keeps its contrast
    // on a selected menu item.
    backgroundColor: color.ground,
    borderColor: color.rule,
    borderRadius: 4,
    borderStyle: "solid",
    borderWidth: 1,
    color: color.inkMuted,
    fontFamily: font.mono,
    fontSize: textSize.label,
    lineHeight: "16px",
    paddingInline: 5,
  },
  /** A key hint with no box, where a box is one more frame (the search
   *  field, the row menu). */
  keyPlain: {
    color: color.inkMuted,
    fontFamily: font.mono,
    fontSize: textSize.label,
    lineHeight: "16px",
  },
  spacer: {
    flexGrow: 1,
  },
  /** An overlay fades in when it opens: a popover, a dialog and its
   *  backdrop, or the drawer scrim. `@starting-style` gives the style
   *  before the first frame, so no script is necessary. The overlay
   *  closes at once. Firefox 147 cannot make a transition of `display`,
   *  and Firefox 147 and Safari 26 do not have `overlay`, so a fade on
   *  close does not work at the browser floor. */
  fadeIn: {
    opacity: { default: 1, "@starting-style": 0 },
    transitionDuration: { default: "150ms", [REDUCED]: "0s" },
    transitionProperty: "opacity",
    "::backdrop": {
      opacity: { default: 1, "@starting-style": 0 },
      transitionDuration: { default: "150ms", [REDUCED]: "0s" },
      transitionProperty: "opacity",
    },
  },
  /** For a coarse pointer, a hit area of at least 36 × 36 px around a
   *  small control, and 8 px more on each side of its text, with no
   *  change to the layout. The hit area has no color. Do not put the
   *  control in a box that clips it. */
  touchArea: {
    position: { default: null, [COARSE]: "relative" },
    "::after": {
      content: { default: null, [COARSE]: '""' },
      height: "max(100%, 36px)",
      left: "50%",
      position: "absolute",
      top: "50%",
      transform: "translate(-50%, -50%)",
      width: "max(100% + 16px, 36px)",
    },
  },
  /** Hides content but keeps it for screen readers. */
  visuallyHidden: {
    clipPath: "inset(50%)",
    height: 1,
    overflow: "hidden",
    position: "absolute",
    whiteSpace: "nowrap",
    width: 1,
  },
});
