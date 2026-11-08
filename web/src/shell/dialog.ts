// One anatomy for the dialogs of the tool: the extraction dialog, the zstd
// copy dialog and the choice for a second file. See
// DESIGN.md, Dialogs.
import * as stylex from "@stylexjs/stylex";
import { color, size, textSize } from "../theme/tokens.stylex";

/** Below this width each dialog footer is a stack at full width. */
const NARROW = "@media (max-width: 479px)";

export const dialogStyle = stylex.create({
  frame: {
    backgroundColor: color.overlay,
    borderColor: color.overlayRule,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: color.shadow,
    boxSizing: "border-box",
    color: color.ink,
    font: "inherit",
    fontSize: textSize.body,
    maxHeight: "calc(100dvh - 48px)",
    maxWidth: "calc(100vw - 32px)",
    padding: 0,
    width: 560,
    "::backdrop": {
      backgroundColor: color.scrim,
    },
  },
  /** No rule: space makes the groups. */
  title: {
    fontSize: textSize.lead,
    fontWeight: 600,
    margin: 0,
    overflowWrap: "anywhere",
    paddingBlockEnd: 8,
    paddingBlockStart: 16,
    paddingInline: 16,
  },
  /** A file name in a sentence: it goes to the next line whole, and breaks
   *  only when it is wider than the dialog. */
  fileName: {
    display: "inline-block",
    maxWidth: "100%",
    overflowWrap: "anywhere",
  },
  /** A line of the body. Lines of one group are 8 px apart. */
  text: {
    margin: 0,
    overflowWrap: "anywhere",
    paddingBlock: 4,
    paddingInline: 16,
    textWrap: "pretty",
  },
  /** The first line of the next group: 16 px after the group before it. */
  nextGroup: {
    marginBlockStart: 8,
  },
  muted: {
    color: color.inkMuted,
  },
  small: {
    fontSize: textSize.small,
  },
  strong: {
    fontWeight: 600,
  },
  /** One banner form: the tone icon, then a lead at weight 600 in the tone,
   *  then a body in ink. */
  banner: {
    alignItems: "flex-start",
    borderRadius: 6,
    columnGap: 8,
    display: "flex",
    marginBlock: 4,
    marginInline: 16,
    overflowWrap: "anywhere",
    paddingBlock: 8,
    paddingInline: 12,
  },
  bannerBody: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
    rowGap: 4,
    textWrap: "pretty",
  },
  /** The lead of a banner. */
  lead: {
    fontWeight: 600,
    margin: 0,
  },
  /** The body of a banner, also on a tinted fill. */
  body: {
    color: color.ink,
    margin: 0,
  },
  warn: {
    backgroundColor: color.warnBg,
    color: color.warn,
  },
  crit: {
    backgroundColor: color.critBg,
    color: color.crit,
  },
  // Raised, not panel: at night the panel is the overlay fill.
  info: {
    backgroundColor: color.raised,
    color: color.ink,
  },
  /** The footer has no rule. Below 480 px it is a stack at full width, with
   *  the last button (the primary or Close) on top. */
  footer: {
    columnGap: 8,
    display: "flex",
    flexDirection: { default: "row", [NARROW]: "column-reverse" },
    justifyContent: "flex-end",
    paddingBlockEnd: 16,
    paddingBlockStart: 12,
    paddingInline: 16,
    rowGap: 8,
  },
  /** A button of the footer. The ring shows also after a pointer action, so
   *  the first focus of a dialog is visible. */
  button: {
    height: { default: 28, [NARROW]: 36 },
    justifyContent: { default: null, [NARROW]: "center" },
    outlineColor: color.focus,
    outlineOffset: 1,
    outlineStyle: { default: "none", ":focus": "solid" },
    outlineWidth: 2,
  },
  /** The footer of a view that accepts a risk: in a stack the safe button is
   *  on top. */
  footerSafe: {
    flexDirection: { default: "row", [NARROW]: "column" },
  },
  /** An action that accepts a risk: crit text, with no fill, so the view
   *  still has no primary. */
  risky: {
    color: color.crit,
  },
  /** A list in a dialog scrolls. A soft shadow at its bottom edge shows that
   *  more rows are below, as in the health list. */
  list: {
    backgroundAttachment: "local, scroll",
    backgroundColor: color.overlay,
    backgroundImage: `linear-gradient(${color.overlay}, ${color.overlay}), linear-gradient(to top, color-mix(in srgb, ${color.ink} 8%, transparent), transparent)`,
    backgroundPosition: "bottom, bottom",
    backgroundRepeat: "no-repeat",
    backgroundSize: "100% 8px, 100% 8px",
    marginBlockStart: 8,
    maxHeight: "max(240px, calc(100dvh - 320px))",
    overflow: "auto",
  },
  table: {
    borderCollapse: "collapse",
    fontSize: textSize.small,
    tableLayout: "fixed",
    width: "100%",
  },
  /** The cells of a list have no rules, and the outcome groups have space. */
  cell: {
    overflowWrap: "anywhere",
    paddingBlock: 3,
    paddingInline: 16,
    verticalAlign: "top",
  },
  /** Below 480 px a row of a list is two lines: the path at full width, then
   *  the reason. Put the roles on the table parts: a block display can remove
   *  the table from a screen reader. */
  stack: {
    display: { default: null, [NARROW]: "block" },
  },
  stackRow: {
    paddingBlockEnd: { default: null, [NARROW]: 6 },
  },
  stackPath: {
    paddingBlockEnd: { default: null, [NARROW]: 0 },
  },
  stackReason: {
    paddingBlockStart: { default: null, [NARROW]: 0 },
  },
  /** A progress card above the status bar. */
  card: {
    backgroundColor: color.overlay,
    borderColor: color.overlayRule,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    bottom: `calc(${size.status} + 12px)`,
    boxShadow: color.shadow,
    boxSizing: "border-box",
    color: color.ink,
    fontSize: textSize.body,
    maxWidth: "calc(100vw - 32px)",
    position: "fixed",
    right: 16,
    width: 360,
    zIndex: 6,
  },
  cardHead: {
    alignItems: "center",
    borderBottomColor: color.rule,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    columnGap: 6,
    display: "flex",
    height: size.strip,
    paddingInlineEnd: 4,
    paddingInlineStart: size.gutter,
  },
  cardTitle: {
    flexGrow: 1,
    fontWeight: 600,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  cardText: {
    margin: 0,
    overflowWrap: "anywhere",
    paddingBlock: 8,
    paddingInline: size.gutter,
    textWrap: "pretty",
  },
  progress: {
    accentColor: color.water,
    boxSizing: "border-box",
    display: "block",
    height: 8,
    marginInline: size.gutter,
    width: `calc(100% - 2 * ${size.gutter})`,
  },
});
