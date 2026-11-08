// The splitter between the table and the preview. It follows the WAI-ARIA
// window splitter pattern. Its value is the width of the preview.
import * as stylex from "@stylexjs/stylex";
import type { JSX } from "@solidjs/web";
import { color } from "../theme/tokens.stylex";
import { controls } from "./controls";
import { keyWidth, PREVIEW_MAX, PREVIEW_MIN } from "./preview-width";

export interface SplitterProps {
  /** The width of the preview now. */
  width: number;
  /** Returns the width for a pointer at this x position. */
  widthAt: (clientX: number) => number;
  /** Sets a new width. `done` is true when the move ends. */
  onResize: (width: number, done: boolean) => void;
  /** True while the tree drawer covers the splitter. */
  inert: boolean;
}

export function Splitter(props: SplitterProps) {
  const onPointerDown: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    event.preventDefault();
    const move = (moved: PointerEvent) => props.onResize(props.widthAt(moved.clientX), false);
    const end = (ended: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      props.onResize(props.widthAt(ended.clientX), true);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const next = keyWidth(props.width, event.key);
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    props.onResize(next, true);
  };

  return (
    <div
      id="preview-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize preview"
      aria-controls="preview-pane"
      aria-valuemin={String(PREVIEW_MIN)}
      aria-valuemax={String(PREVIEW_MAX)}
      aria-valuenow={String(props.width)}
      tabindex={0}
      inert={props.inert}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      {...stylex.attrs(controls.focusRing, styles.splitter)}
    >
      <span {...stylex.attrs(styles.grip)} />
    </div>
  );
}

const styles = stylex.create({
  /** A 1 px divider, so the rules and the fills of both panes run to it. */
  splitter: {
    alignItems: "center",
    backgroundColor: { default: color.rule, ":hover": color.ruleStrong },
    cursor: "col-resize",
    display: "flex",
    justifyContent: "center",
    outlineOffset: { default: null, ":focus-visible": 0 },
    position: "relative",
    touchAction: "none",
    zIndex: 1,
    // A wider target for the pointer than the 1 px that shows.
    "::before": {
      content: '""',
      insetBlock: 0,
      insetInline: -5,
      position: "absolute",
    },
  },
  /** Rule Strong: 3:1 or more against the ground. */
  grip: {
    backgroundColor: color.ruleStrong,
    borderRadius: 2,
    flexShrink: 0,
    height: 28,
    pointerEvents: "none",
    width: 3,
  },
});
