// Styles that the tree and the table share: size bars, settling values,
// selected rows, the focus ring of the viewport and the spacer.
import * as stylex from "@stylexjs/stylex";
import { color } from "../theme/tokens.stylex";

export const shared = stylex.create({
  /** The slot of a size bar has no track: 30 tracks read as a column of
   *  empty pills, and the fill alone shows the share. */
  bar: {
    borderRadius: 1,
    display: "block",
    height: 6,
    overflow: "hidden",
  },
  fill: {
    backgroundColor: `var(--row-fill, ${color.bar})`,
    borderRadius: 1,
    display: "block",
    height: "100%",
  },
  settling: {
    color: color.inkMuted,
  },
  muted: {
    color: color.inkMuted,
  },
  /** The selected row. Only the pane with the focus shows the full selection:
   *  the select fill and the water bar. The row of the other pane has the
   *  rest fill and a muted bar. With the keyboard
   *  focus the row has the inset 2 px focus ring, as the menu items: the ring
   *  marks the active row, not the whole pane, and it is not under the sticky
   *  header. */
  selected: {
    // Ink muted keeps 3:1 on the select fill and the raised fill in both themes.
    "--row-fill": color.inkMuted,
    backgroundColor: {
      default: color.selectRest,
      [stylex.when.ancestor(":focus")]: color.selectBg,
    },
    // A 2 px bar: a fill alone is only about 1.2:1 on the ground.
    boxShadow: {
      default: `inset 2px 0 0 ${color.inkMuted}`,
      [stylex.when.ancestor(":focus:not(:focus-visible)")]: `inset 2px 0 0 ${color.water}`,
      [stylex.when.ancestor(":focus-visible")]: `inset 0 0 0 2px ${color.focus}`,
    },
  },
  /** The row viewport: the marker of the focus ring of its rows. */
  focused: {
    outlineStyle: "none",
  },
  /** The element that gives a row viewport its scroll height. */
  spacer: {
    width: 1,
  },
  /** The chevron of a folder row turns, and its toggle box does not. Thus
   *  the toggle of a coarse pointer, which is not square, keeps its hit
   *  area. */
  chevron: {
    transitionDuration: { default: "150ms", "@media (prefers-reduced-motion: reduce)": "0s" },
    transitionProperty: "transform",
  },
  chevronOpen: {
    transform: "rotate(90deg)",
  },
});

/** Returns the class name of StyleX props, for elements that the code
 *  makes without JSX. */
export const cls = (props: ReturnType<typeof stylex.props>) => props.className ?? "";

/** Lucide `chevron-right` (ISC license), 16px with a 1.5px stroke. */
export const CHEVRON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

const CHEVRON_CLASS = cls(stylex.props(shared.chevron));
const CHEVRON_OPEN_CLASS = cls(stylex.props(shared.chevron, shared.chevronOpen));

/** Puts the chevron in a toggle element and returns the chevron. */
export function addChevron(toggle: HTMLElement): Element {
  toggle.innerHTML = CHEVRON;
  const chevron = toggle.firstElementChild!;
  chevron.setAttribute("class", CHEVRON_CLASS);
  return chevron;
}

/** Turns the chevron to show an open folder, or back. */
export function turnChevron(chevron: Element, open: boolean): void {
  const name = open ? CHEVRON_OPEN_CLASS : CHEVRON_CLASS;
  if (chevron.getAttribute("class") !== name) chevron.setAttribute("class", name);
}

/** Sets the width of the fill element of a size bar. */
export function setBar(bar: HTMLElement, width: number): void {
  const fill = bar.firstElementChild as HTMLElement | null;
  if (fill !== null) {
    fill.style.width = `${width}%`;
  }
  bar.style.visibility = width > 0 ? "" : "hidden";
}

/** Makes a size bar: a slot of fixed width with a fill. */
export function createBar(): HTMLElement {
  const bar = document.createElement("span");
  bar.className = stylex.props(shared.bar).className ?? "";
  bar.setAttribute("aria-hidden", "true");
  const fill = document.createElement("span");
  fill.className = stylex.props(shared.fill).className ?? "";
  bar.append(fill);
  return bar;
}
