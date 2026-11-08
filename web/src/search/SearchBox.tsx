import * as stylex from "@stylexjs/stylex";
import { onSettled, Show } from "solid-js";
import { color } from "../theme/tokens.stylex";
import { controls } from "../shell/controls";
import { modified, typing } from "../shell/keys";
import { STOPPED } from "../health/findings";

export interface SearchBoxProps {
  query: string;
  onQuery: (query: string) => void;
  /** True after the hard stop, when the worker refuses each search. The
   *  field is off and its placeholder tells why. */
  stopped: boolean;
  /** True when the archive has no entries: there is nothing to search. */
  empty: boolean;
  /** Enter in the field with a query. See `ArchiveView.askFirstRow`. */
  onEnter: () => void;
  /** A later key or new text in the field, or the focus left the field. */
  onLeave: () => void;
}

/**
 * The search field of the archive. `/` focuses it from anywhere. Escape
 * clears it, and a second Escape leaves it. Enter goes to the first result.
 */
export function SearchBox(props: SearchBoxProps) {
  let input!: HTMLInputElement;

  onSettled(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || modified(event) || typing(event.target)) {
        return;
      }
      event.preventDefault();
      input.focus();
      input.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const onKeyDown = (event: KeyboardEvent) => {
    // A held Enter is one key.
    if (event.key === "Enter" && event.repeat) return;
    // Enter that ends a composition is for the composition. A browser can give
    // it `keyCode` 229 with no `isComposing`.
    const composing = event.isComposing || event.keyCode === 229;
    if (event.key === "Enter" && !composing && !modified(event) && !event.shiftKey) {
      if (input.value !== "") {
        event.preventDefault();
        props.onEnter();
      }
      return;
    }
    // Any other key, also a caret key, ends the wait of Enter.
    props.onLeave();
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    if (input.value !== "") {
      input.value = "";
      props.onQuery("");
    } else {
      input.blur();
    }
  };

  return (
    <div role="search" {...stylex.attrs(styles.bar)}>
      <input
        ref={(el) => (input = el)}
        id="search-input"
        type="search"
        placeholder={props.stopped || props.empty ? STOPPED.search : "Search names"}
        disabled={props.stopped || props.empty}
        aria-label="Search names"
        aria-keyshortcuts="/"
        autocomplete="off"
        spellcheck={false}
        value={props.query}
        onInput={(event) => {
          props.onLeave();
          props.onQuery(event.currentTarget.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => props.onLeave()}
        {...stylex.attrs(styles.input, controls.focusRing)}
      />
      {/* While search is off, its key does nothing, so no hint shows. */}
      <Show when={!props.stopped && !props.empty}>
        <kbd aria-hidden="true" {...stylex.attrs(controls.keyPlain, styles.key)}>
          /
        </kbd>
      </Show>
    </div>
  );
}

const styles = stylex.create({
  /** The key hint is inside the field, at its end. */
  bar: {
    alignItems: "center",
    display: "flex",
    flexGrow: 1,
    minWidth: 0,
    position: "relative",
  },
  /** The edge is Rule Strong (3:1 or more). A field that is off has the
   *  raised fill and the rule color, so it does not read as ready; its
   *  placeholder keeps ink muted. */
  input: {
    backgroundColor: { default: color.ground, ":disabled": color.raised },
    borderColor: { default: color.ruleStrong, ":disabled": color.rule },
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    boxSizing: "border-box",
    color: color.ink,
    height: 28,
    paddingInlineEnd: { default: 24, "@container search (width < 200px)": 8 },
    paddingInlineStart: 8,
    width: "100%",
    flexShrink: 1,
    font: "inherit",
    minWidth: 0,
    // The browser gray is 4.3:1 on the night ground. ink-muted passes in
    // both themes.
    // A narrow field cuts the placeholder with an ellipsis. The start of
    // each placeholder tells the most.
    textOverflow: "ellipsis",
    "::placeholder": {
      color: color.inkMuted,
      opacity: 1,
    },
    cursor: { default: null, ":disabled": "not-allowed" },
  },
  /** The key hint shows only when the search slot has room for it, so a
   *  narrow field keeps its room for the placeholder. The key still
   *  works. */
  key: {
    display: { default: null, "@container search (width < 200px)": "none" },
    insetInlineEnd: 9,
    pointerEvents: "none",
    position: "absolute",
  },
});
