// The "Survey sheet" design tokens. DESIGN.md gives their roles.
// The colors are Tailwind v4.3 palette steps, written as sRGB hex values.
// Light is the default. The night sheet follows the system setting.
import * as stylex from "@stylexjs/stylex";

const NIGHT = "@media (prefers-color-scheme: dark)";

export const color = stylex.defineVars({
  /** Main surface: white, stone-950. */
  ground: { default: "#ffffff", [NIGHT]: "#0c0a09" },
  /** Tree, toolbars, status bar: stone-50, stone-900. */
  panel: { default: "#fafaf9", [NIGHT]: "#1c1917" },
  /** Headers, hover: stone-100, stone-800. */
  raised: { default: "#f5f5f4", [NIGHT]: "#292524" },
  /** Grid and dividers: stone-200, stone-800. */
  rule: { default: "#e7e5e4", [NIGHT]: "#292524" },
  /** The dashed edge of a drop target: stone-500 on both sheets, 4.8:1
   *  on white and 4.1:1 on the night ground. */
  ruleStrong: { default: "#79716b", [NIGHT]: "#79716b" },
  /** Tree guides, emphasized rules: amber-700, amber-600. */
  contour: { default: "#bb4d00", [NIGHT]: "#e17100" },
  /** Text: stone-900, stone-100. */
  ink: { default: "#1c1917", [NIGHT]: "#f5f5f4" },
  /** Secondary text: stone-600, stone-400. */
  inkMuted: { default: "#57534d", [NIGHT]: "#a6a09b" },
  /** Links, primary actions: sky-700, sky-400. */
  water: { default: "#0069a8", [NIGHT]: "#00bcff" },
  /** Text on a `water` fill: white, stone-950. */
  onWater: { default: "#ffffff", [NIGHT]: "#0c0a09" },
  /** Focus ring: sky-600, sky-500. */
  focus: { default: "#0084d1", [NIGHT]: "#00a6f4" },
  /** Selected rows: sky-100, sky-950. */
  selectBg: { default: "#dff2fe", [NIGHT]: "#052f4a" },
  /** The selected row of a pane with no focus: stone-200, and a step above
   *  raised at night, where ink muted keeps 4.5:1. */
  selectRest: { default: "#e7e5e4", [NIGHT]: "#38332f" },
  /** Healthy states: green-700, green-400. */
  forest: { default: "#008236", [NIGHT]: "#05df72" },
  /** Health warnings: amber-700 on amber-50, amber-400 on a night
   *  amber surface: 60% amber-950 and 40% stone-950, mixed in OKLab.
   *  It is one step above the ground, as amber-50 is one step below
   *  white. */
  warn: { default: "#bb4d00", [NIGHT]: "#ffb900" },
  warnBg: { default: "#fffbeb", [NIGHT]: "#2e1407" },
  /** Health errors: red-700 on red-50, red-400 on a night red surface
   *  (60% red-950 and 40% stone-950, mixed in OKLab). */
  crit: { default: "#c10007", [NIGHT]: "#ff6467" },
  critBg: { default: "#fef2f2", [NIGHT]: "#2e0c0a" },
  /** Size bars: stone-500 on stone-200, stone-500 on stone-800. */
  bar: { default: "#79716b", [NIGHT]: "#79716b" },
  barTrack: { default: "#e7e5e4", [NIGHT]: "#292524" },
  /** Dialogs, menus and cards: white, stone-900. At night a shadow does
   *  not show on the dark page, so the overlay is one step lighter than
   *  the ground. */
  overlay: { default: "#ffffff", [NIGHT]: "#1c1917" },
  /** The edge of an overlay: stone-200, stone-600. At night it is 2.7:1
   *  against the page below the scrim. */
  overlayRule: { default: "#e7e5e4", [NIGHT]: "#57534d" },
  /** Scrim behind the tree drawer. */
  scrim: { default: "rgb(28 25 23 / 0.24)", [NIGHT]: "rgb(0 0 0 / 0.5)" },
  /** Shadow of the drawer and of popovers. */
  shadow: { default: "0 8px 24px rgb(28 25 23 / 0.14)", [NIGHT]: "0 8px 24px rgb(0 0 0 / 0.5)" },
});

export const font = stylex.defineVars({
  /** The system UI font stack. */
  ui: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

/** The type roles. The tool uses a tight scale (about 1.08 for each step),
 *  because weight and case also separate the roles. Only the front door
 *  uses the large roles. */
export const textSize = stylex.defineVars({
  /** Legend labels (upper case), key hints, badges and tags. */
  label: "11px",
  /** Secondary text: the status bar, panel details, banners and notes. */
  small: "12px",
  /** The base text of the tool: rows, menus, dialogs. */
  body: "13px",
  /** Emphasized values (the totals) and the front door buttons. */
  title: "14px",
  /** The word mark, dialog titles and the action line of the front door on a
   *  phone. A dialog title is one step (1.15) above the body. */
  lead: "15px",
  /** The reference answers of the front door: reading text, at the 16px floor
   *  of web body text. */
  reading: "16px",
  /** The action line of the front door, and the reason of the unsupported
   *  state. */
  subtitle: "17px",
  /** The reference questions of the front door. */
  heading: "22px",
  /** The reopen line and the close of the front door, and the "browser cannot
   *  run Zipscope" state. */
  statement: "clamp(28px, 4.4vw, 56px)",
});

export const size = stylex.defineVars({
  /** The gutter between the pane edges and their contents. */
  gutter: "12px",
  /** The header strip of each pane. */
  strip: "36px",
  /** The top bar. */
  top: "44px",
  /** The status bar. */
  status: "28px",
  /** The width of the tree pane. */
  tree: "320px",
});
