// The three layouts (see DESIGN.md, Layout). The shell uses no
// CSS media queries for the layout: all layout styles follow this signal,
// so the styles and the controls agree at the breakpoints.
import { createSignal, onCleanup } from "solid-js";

export type Layout = "wide" | "medium" | "narrow";

/** At least 1200px: tree, table and preview side by side. */
export const WIDE_QUERY = "(width >= 1200px)";
/** Below 700px: one pane at a time. */
export const NARROW_QUERY = "(width < 700px)";

function current(): Layout {
  if (matchMedia(WIDE_QUERY).matches) {
    return "wide";
  }
  return matchMedia(NARROW_QUERY).matches ? "narrow" : "medium";
}

/** Returns the current layout as a signal. Call it in a component. */
export function createLayout(): () => Layout {
  const [layout, setLayout] = createSignal<Layout>(current());
  const update = () => setLayout(current());
  const queries = [matchMedia(WIDE_QUERY), matchMedia(NARROW_QUERY)];
  for (const query of queries) {
    query.addEventListener("change", update);
  }
  onCleanup(() => {
    for (const query of queries) {
      query.removeEventListener("change", update);
    }
  });
  return layout;
}
