// The preview pane. It shows the preview of the selected entry, or the
// Archive panel. In the narrow layout it is
// a full-screen view with Back.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, from, Match, Show, Switch } from "solid-js";
import type { EntryCheck } from "../contracts";
import type { Finding } from "../health/findings";
import { EntryPreview } from "../preview/EntryPreview";
import type { PreviewTarget } from "../preview/target";
import type { ArchiveSession } from "../session";
import { color, size } from "../theme/tokens.stylex";
import { controls } from "./controls";
import { Icon } from "./icons";
import { loadArchivePanel } from "./panel";
import { nameLabel, nameTitle } from "../label";

/** The chunk of the Archive panel, while it loads, or why it did not. */
type PanelChunk =
  | { status: "loading" }
  | { status: "ready"; module: Awaited<ReturnType<typeof loadArchivePanel>> }
  | { status: "failed" };

export interface PreviewPaneProps {
  session: ArchiveSession;
  /** The entry in the preview, or undefined. */
  target: PreviewTarget | undefined;
  /** The count of listed rows. */
  rows: number;
  /** The full name of the selected entry, or undefined. */
  entry: string | undefined;
  /** The archive name when the pane shows the Archive panel. */
  archive?: string | undefined;
  narrow: boolean;
  /** True while the tree drawer covers the pane. */
  inert: boolean;
  onClose: () => void;
  /** Opens the preview in a new window. Undefined when it cannot. */
  onPopOut?: (() => void) | undefined;
  onCheck?: (row: number, check: EntryCheck) => void;
  onCrcFailure?: (row: number) => void;
  /** The health findings, for the Archive panel. */
  findings: Finding[];
  /** Opens the list of the health findings. */
  onShowHealth: () => void;
  /** Opens the dialog of the zstd copy, from the Archive panel. */
  onRemux: () => void;
}

export function PreviewPane(props: PreviewPaneProps) {
  // The pane of the archive says what it is: the top bar and the tree name the
  // file.
  const title = () =>
    props.archive !== undefined
      ? "Archive"
      : (props.entry?.split(/[/\\]/).findLast((part) => part !== "") ?? "Preview");
  /** The place of the actions of the entry, in the strip. */
  const [actions, setActions] = createSignal<HTMLElement>();
  return (
    <aside
      id="preview-pane"
      aria-label="Preview"
      inert={props.inert}
      onKeyDown={(event) => {
        // Escape closes the preview in all layouts. A control in the pane
        // that uses Escape itself prevents the default.
        if (event.key === "Escape" && !event.defaultPrevented) {
          props.onClose();
        }
      }}
      {...stylex.attrs(styles.pane, props.narrow && styles.fullScreen)}
    >
      <div {...stylex.attrs(controls.strip, styles.strip)}>
        <Show when={props.narrow}>
          <button
            id="preview-back"
            type="button"
            aria-label="Back to list"
            title="Back to list"
            onClick={() => props.onClose()}
            {...stylex.attrs(controls.iconButton, controls.focusRing, styles.back)}
          >
            <Icon name="back" />
          </button>
        </Show>
        <span
          {...stylex.attrs(styles.title)}
          title={nameTitle(props.archive ?? props.entry ?? "")}
          dir="ltr"
        >
          {nameLabel(title())}
        </span>
        <span {...stylex.attrs(controls.spacer)} />
        <span ref={setActions} {...stylex.attrs(styles.actions)} />
        <Show when={props.onPopOut !== undefined && props.archive === undefined}>
          <button
            id="preview-popout"
            type="button"
            aria-label="Open preview in a new window"
            title="Open in new window"
            onClick={() => props.onPopOut?.()}
            {...stylex.attrs(controls.iconButton, controls.focusRing)}
          >
            <Icon name="popout" />
          </button>
        </Show>
        <Show when={!props.narrow}>
          <button
            id="preview-close"
            type="button"
            aria-label="Close preview"
            title="Close preview"
            onClick={() => props.onClose()}
            {...stylex.attrs(controls.iconButton, controls.focusRing, styles.close)}
          >
            <Icon name="close" />
          </button>
        </Show>
      </div>
      <Show
        when={props.archive === undefined}
        fallback={
          <div {...stylex.attrs(styles.body)}>
            <PanelSlot
              session={props.session}
              rows={props.rows}
              findings={props.findings}
              onShowHealth={props.onShowHealth}
              onRemux={props.onRemux}
            />
          </div>
        }
      >
        <div {...stylex.attrs(styles.entry)}>
          <EntryPreview
            session={props.session}
            target={props.target}
            actions={actions()}
            rows={props.rows}
            onCheck={props.onCheck}
            onCrcFailure={props.onCrcFailure}
          />
        </div>
      </Show>
    </aside>
  );
}

type PanelSlotProps = Pick<
  PreviewPaneProps,
  "session" | "rows" | "findings" | "onShowHealth" | "onRemux"
>;

/** The Archive panel, from its chunk. */
function PanelSlot(props: PanelSlotProps) {
  // The Archive panel is a separate chunk: only an open archive root needs
  // it, and the front door preloads it with the workers. `lazy` with
  // `Loading` and `Errored` would add about 1.9 kB to the main chunk, so
  // the chunk is an async source, and a failed load stays data.
  const chunk = createMemo(() =>
    from<PanelChunk>((emit) => {
      emit({ status: "loading" });
      loadArchivePanel().then(
        (module) => emit({ status: "ready", module }),
        () => emit({ status: "failed" }),
      );
    }),
  );
  const loaded = () => {
    const now = chunk();
    return now.status === "ready" ? now.module : undefined;
  };
  return (
    <Switch>
      <Match when={chunk().status === "failed"}>
        <p role="alert" {...stylex.attrs(styles.note, styles.pad)}>
          The Archive panel could not load. Check the network, then open the panel again.
        </p>
      </Match>
      <Match when={loaded()}>
        {(module) => {
          const ArchivePanel = module().default;
          return (
            <ArchivePanel
              session={props.session}
              rows={props.rows}
              findings={props.findings}
              onShowHealth={props.onShowHealth}
              onRemux={props.onRemux}
            />
          );
        }}
      </Match>
      <Match when={true}>
        <p {...stylex.attrs(styles.note, styles.pad)}>Loading…</p>
      </Match>
    </Switch>
  );
}

const styles = stylex.create({
  pane: {
    backgroundColor: color.ground,
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: `${size.strip} minmax(0, 1fr)`,
    minHeight: 0,
    minWidth: 0,
  },
  /** The narrow layout: an opaque view below the top bar. */
  fullScreen: {
    inset: `${size.top} 0 0 0`,
    position: "fixed",
    zIndex: 4,
  },
  strip: {
    backgroundColor: color.ground,
  },
  /** It has the icon cell of the tree toggle of the table strip, and the title
   *  starts at the x of the location, so the row does not jump when a preview
   *  opens. */
  back: {
    marginInlineStart: -6,
  },
  close: {
    marginInlineEnd: -6,
  },
  /** The title gives way first: the actions keep their place. */
  actions: {
    alignItems: "center",
    columnGap: 6,
    display: "flex",
    flexShrink: 0,
  },
  title: {
    fontWeight: 600,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  entry: {
    minHeight: 0,
    minWidth: 0,
  },
  /** An edge shadow over the full width while rows are above it. It is lighter
   *  than a rule. The first layer scrolls with the content and covers the
   *  shadow at the start. */
  body: {
    backgroundAttachment: "local, scroll",
    backgroundImage: `linear-gradient(${color.ground}, ${color.ground}), linear-gradient(to bottom, color-mix(in srgb, ${color.ink} 8%, transparent), transparent)`,
    backgroundPosition: "top, top",
    backgroundRepeat: "no-repeat",
    backgroundSize: "100% 8px, 100% 8px",
    minHeight: 0,
    overflow: "auto",
  },
  pad: {
    padding: size.gutter,
  },
  note: {
    color: color.inkMuted,
    margin: 0,
  },
});
