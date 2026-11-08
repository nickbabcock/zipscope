// The label of the demo archive. The top bar and the reopen door show it. It is in its own module, so the shell does not import the
// front door.
import * as stylex from "@stylexjs/stylex";
import { color, textSize } from "../theme/tokens.stylex";
import type { JSX } from "@solidjs/web";
import { front } from "./strings";

export function DemoTag(props: { id?: string }): JSX.Element {
  return (
    <span id={props.id} {...stylex.attrs(styles.tag)}>
      {front.demo}
    </span>
  );
}

const styles = stylex.create({
  /** Quiet: it names the archive, and it is not a control or a state. */
  tag: {
    backgroundColor: color.raised,
    borderRadius: 4,
    color: color.inkMuted,
    flexShrink: 0,
    fontSize: textSize.label,
    fontWeight: 500,
    letterSpacing: "0.04em",
    lineHeight: "16px",
    paddingInline: 5,
    textTransform: "uppercase",
  },
});
