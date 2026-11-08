// "Open in new window": a same-origin popup that the app window renders
// into. It shares the store and the read worker, so it follows the
// selection at once. COOP same-origin keeps a same-origin popup connected
// to its opener. The popup closes with its archive.
import * as stylex from "@stylexjs/stylex";
import { render } from "@solidjs/web";
import { createEffect, createMemo } from "solid-js";
import type { EntryCheck } from "../contracts";
import type { ArchiveSession } from "../session";
import { controls } from "../shell/controls";
import { Icon } from "../shell/icons";
import { color, font, size, textSize } from "../theme/tokens.stylex";
import { EntryPreview } from "./EntryPreview";
import type { PreviewTarget } from "./target";
import { nameLabel, nameText } from "../label";

export interface PopupOptions {
  session: ArchiveSession;
  target: () => PreviewTarget | undefined;
  /** The count of listed rows. */
  rows: () => number;
  /** Called one time when the user closes the popup. */
  onClosed: () => void;
  onCheck?: (row: number, check: EntryCheck) => void;
  onCrcFailure?: (row: number) => void;
}

export interface Popup {
  /** Closes the popup. `onClosed` is not called. */
  close(): void;
  focus(): void;
}

const title = (target: PreviewTarget | undefined) =>
  target?.name.split(/[/\\]/).findLast((part) => part !== "") ?? "Preview";

/** Opens the popup. Returns undefined when the browser blocks it. */
export function openPopup(options: PopupOptions): Popup | undefined {
  const view = window.open(
    "",
    `zipscope-preview-${options.session.id}`,
    "popup,width=720,height=800",
  );
  if (view === null) {
    return undefined;
  }
  const doc = view.document;
  // A popup with this name from before can still show an old render.
  doc.body.textContent = "";
  doc.documentElement.lang = document.documentElement.lang || "en";
  for (const node of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
    doc.head.append(doc.importNode(node, true));
  }
  const root = doc.createElement("div");
  root.id = "popup-root";
  doc.body.append(root);

  let done = false;
  let dispose: () => void = () => {};
  const end = () => {
    if (done) return;
    done = true;
    clearInterval(poll);
    view.removeEventListener("pagehide", onHide);
    dispose();
  };
  const onHide = () => {
    if (done) return;
    end();
    options.onClosed();
  };
  view.addEventListener("pagehide", onHide);
  // Some browsers do not send pagehide for a popup that the user closes.
  const poll = setInterval(() => {
    if (view.closed) onHide();
  }, 500);

  dispose = render(() => {
    const name = createMemo(() => title(options.target()));
    createEffect(name, (value) => {
      doc.title = `${nameText(value)} · Zipscope`;
    });
    return (
      <div {...stylex.attrs(styles.window)}>
        <div {...stylex.attrs(controls.strip)}>
          <span {...stylex.attrs(styles.title)} dir="ltr" id="popup-title">
            {nameLabel(name())}
          </span>
          <span {...stylex.attrs(controls.spacer)} />
          <button
            type="button"
            aria-label="Close window"
            title="Close window"
            onClick={() => view.close()}
            {...stylex.attrs(controls.iconButton, controls.focusRing)}
          >
            <Icon name="close" />
          </button>
        </div>
        <EntryPreview
          session={options.session}
          target={options.target()}
          rows={options.rows()}
          view={view}
          onCheck={options.onCheck}
          onCrcFailure={options.onCrcFailure}
        />
      </div>
    );
  }, root);

  return {
    close() {
      end();
      view.close();
    },
    focus() {
      view.focus();
    },
  };
}

const styles = stylex.create({
  window: {
    backgroundColor: color.ground,
    color: color.ink,
    display: "grid",
    fontFamily: font.ui,
    fontSize: textSize.body,
    fontVariantNumeric: "tabular-nums",
    gridTemplateRows: `${size.strip} minmax(0, 1fr)`,
    height: "100dvh",
    inset: 0,
    lineHeight: 1.4,
    position: "fixed",
  },
  title: {
    fontWeight: 600,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});
