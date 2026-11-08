// The top bar: the word mark, the open archive, and the slot for search.
// The health strip above the table shows the archive health.
import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { DemoTag } from "../front/DemoTag";
import type { ArchiveInfo } from "./archive";
import { color, size, textSize } from "../theme/tokens.stylex";
import { controls } from "./controls";
import { Icon } from "./icons";
import { nameLabel, nameTitle } from "../label";

export interface TopBarProps {
  archive: ArchiveInfo | undefined;
  onFile: (file: File) => void;
  /** Opens the file picker: the File System Access picker where the
   *  browser has it, else the file input. */
  onPick: () => void;
  /** Gets the file input, so the front door can open the file picker. */
  input?: (element: HTMLInputElement) => void;
  /** Slot for the search field. */
  search?: JSX.Element;
  /** The narrow layout hides the archive icon and the button label. The
   *  map margin gives the file size. */
  narrow: boolean;
  /** True on the first visit and reopen doors: the door has "Open a
   *  file", so the top bar has no second Open button. The file input stays. */
  hideOpen?: boolean;
  /** True on the door states: the door has the `h1` of the page, so the word
   *  mark is a plain element. */
  plainMark?: boolean;
  /** The first door puts its line here, beside the word mark. */
  note?: JSX.Element;
}

export function TopBar(props: TopBarProps) {
  return (
    <header {...stylex.attrs(styles.bar, props.narrow && styles.barNarrow)}>
      <Show
        when={props.plainMark !== true}
        fallback={<span {...stylex.attrs(styles.word)}>Zipscope</span>}
      >
        <h1 {...stylex.attrs(styles.word)}>Zipscope</h1>
      </Show>
      {props.note}
      <Show when={props.archive}>
        {(archive) => (
          <>
            {/* The rule keeps the archive name apart from the word mark. */}
            <Show when={!props.narrow || !archive().demo}>
              <span {...stylex.attrs(styles.rule)} aria-hidden="true" />
            </Show>
            {/* At narrow widths the DEMO tag names the demo archive. */}
            <span {...stylex.attrs(styles.archive, props.narrow && archive().demo && styles.gone)}>
              <Show when={!props.narrow}>
                <Icon name="archive" />
              </Show>
              <span
                id="archive-name"
                dir="ltr"
                title={nameTitle(archive().name)}
                {...stylex.attrs(styles.name)}
              >
                {nameLabel(archive().name)}
              </span>
            </span>
            {/* The demo archive is labeled wherever it shows. */}
            <Show when={archive().demo}>
              <DemoTag id="demo-label" />
            </Show>
          </>
        )}
      </Show>
      <div
        id="search-slot"
        data-slot="search"
        {...stylex.attrs(styles.search, props.narrow && styles.searchNarrow)}
      >
        {props.search}
      </div>
      <input
        ref={(el) => props.input?.(el)}
        id="file-input"
        type="file"
        tabindex={-1}
        aria-hidden="true"
        accept=".zip,.jar,.apk,.docx,.whl,.vsix,.ipa,application/zip"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file !== undefined) {
            props.onFile(file);
          }
          // The same file can open again.
          event.currentTarget.value = "";
        }}
        {...stylex.attrs(controls.visuallyHidden)}
      />
      <Show when={props.hideOpen !== true}>
        <button
          id="open-button"
          type="button"
          aria-label="Open archive"
          title="Open archive"
          onClick={() => props.onPick()}
          {...stylex.attrs(
            controls.button,
            controls.focusRing,
            styles.open,
            props.narrow && styles.openNarrow,
          )}
        >
          <Icon name="open" />
          <span {...stylex.attrs(props.narrow && styles.gone)}>Open</span>
        </button>
      </Show>
    </header>
  );
}

const styles = stylex.create({
  bar: {
    alignItems: "center",
    backgroundColor: color.panel,
    borderBottomColor: color.rule,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    boxSizing: "border-box",
    columnGap: 12,
    display: "flex",
    height: size.top,
    minWidth: 0,
    paddingInline: size.gutter,
    whiteSpace: "nowrap",
  },
  word: {
    flexShrink: 0,
    fontSize: textSize.lead,
    fontWeight: 650,
    letterSpacing: "-0.01em",
    margin: 0,
  },
  rule: {
    backgroundColor: color.rule,
    flexShrink: 0,
    height: 20,
    width: 1,
  },
  archive: {
    alignItems: "center",
    columnGap: 6,
    display: "flex",
    flexShrink: 1,
    minWidth: 0,
  },
  /** At most 280 px, so the search field starts at about one place. */
  name: {
    maxWidth: 280,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  /** The search field adapts to the width of this slot (see SearchBox). */
  search: {
    containerName: "search",
    containerType: "inline-size",
    display: "flex",
    // The field fills the bar, and Open stays at its end.
    flexBasis: 0,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  /** The field keeps its placeholder whole, and it takes the free width, so
   *  Open stays on the gutter at the end of the bar. The archive name gets what
   *  it needs first. */
  searchNarrow: {
    flexBasis: { default: 128, ":empty": 0 },
    flexGrow: { default: 1, ":empty": 0 },
    minWidth: { default: 128, ":empty": 0 },
  },
  open: {
    paddingInline: 10,
  },
  barNarrow: {
    columnGap: 8,
  },
  openNarrow: {
    paddingInline: 7,
  },
  gone: {
    display: "none",
  },
});
