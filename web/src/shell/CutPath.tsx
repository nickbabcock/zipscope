// A path on one line that is cut to its room, with no gap after the
// ellipsis. A text-overflow on the folder part leaves a gap before the base
// name, so the text is measured and cut as one string.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, onCleanup } from "solid-js";
import { fontOf, pathTruncate, TextWidths } from "../grid/truncate";
import { directed, nameText, nameTitle } from "../label";
import { color } from "../theme/tokens.stylex";

/** One measure for all paths: they use one font. */
const widths = new TextWidths();

/** The margin for kerning, which the widths do not count. */
const KERNING = 2;

const styles = stylex.create({
  path: {
    display: "block",
    // In a flex parent the width does not depend on the text.
    flexBasis: 0,
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "pre",
  },
  folder: {
    color: color.inkMuted,
  },
});

/**
 * Shows a path with its folders in ink muted. The folders go first, from the
 * start, so the base name stays. The title has the full path. A path has
 * its marks before the cut, and its isolates after the cut (see `label.ts`).
 */
export function CutPath(props: { path: string }) {
  const [room, setRoom] = createSignal(0);
  const cut = createMemo(() => {
    const path = nameText(props.path);
    if (room() > 0) return pathTruncate(path, room() - KERNING, widths.measure);
    return { text: path, folder: path.lastIndexOf("/", path.length - 2) + 1 };
  });
  return (
    <span
      ref={(element) => {
        const observer = new ResizeObserver(() => {
          widths.setFont(fontOf(element));
          setRoom(element.clientWidth);
        });
        observer.observe(element);
        onCleanup(() => observer.disconnect());
      }}
      title={nameTitle(props.path)}
      {...stylex.attrs(styles.path)}
    >
      <span dir="ltr" {...stylex.attrs(styles.folder)}>
        {directed(cut().text.slice(0, cut().folder))}
      </span>
      <span dir="ltr">{directed(cut().text.slice(cut().folder))}</span>
    </span>
  );
}
