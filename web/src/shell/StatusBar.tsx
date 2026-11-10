// The map margin: the bottom status bar reads like the legend of a map.
// It shows the archive name, the file size, the entries listed, the store
// memory while it matters, and the parse progress.
import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";
import { exactBytes, formatSize, integers } from "../format";
import type { ArchiveInfo } from "./archive";
import { color, size, textSize } from "../theme/tokens.stylex";
import { controls } from "./controls";
import { isParsing, phaseProgress, phaseText } from "./phase";
import type { ParsePhase } from "./phase";
import { nameLabel } from "../label";

export interface StatusBarProps {
  /** The open archive, or undefined before the first file. */
  archive: ArchiveInfo | undefined;
  /** The text when no archive is open. It can be empty. The element
   *  stays, so that its live region speaks when the text comes. */
  idle: string;
  /** True while the device is offline: the idle text gets the offline
   *  mark (a ring). */
  offline?: boolean;
  /** Entries listed. */
  rows: number;
  /** The entry count that the archive declares, or undefined. */
  declared: number | undefined;
  /** Store memory in bytes. */
  storeBytes: number;
  /** The first memory limit in bytes: the soft budget, or the hard stop
   *  when it is lower (only a test sets it so). After the parse, the
   *  store memory shows only above half of it. */
  budgetBytes: number;
  /** The parse phase: progress, the time, or what went wrong. */
  phase: ParsePhase;
  onCancel: () => void;
  /** The narrow layout keeps only the entries and the status text (no
   *  progress track: the text gives the percent). */
  narrow: boolean;
}

export function StatusBar(props: StatusBarProps) {
  const parsing = () => isParsing(props.phase);
  /** After a stop with a partial listing: the visible start of the text
   *  ("Stopped after 10 entries") and the reason after it. */
  const stopped = (): [string, string] | undefined => {
    if (props.phase.kind !== "failed" || props.phase.rows === 0) return undefined;
    const text = phaseText(props.phase);
    const cut = text.indexOf(":");
    return cut < 0 ? undefined : [text.slice(0, cut), text.slice(cut)];
  };
  const progress = () => phaseProgress(props.phase);
  /** The store memory matters only while parsing, or near the budget. */
  const storeShown = () => parsing() || props.storeBytes > props.budgetBytes / 2;
  /** A count that is below the rows is not an estimate of them. */
  const estimate = () =>
    parsing() && props.declared !== undefined && props.rows <= props.declared
      ? ` of ~${integers.format(props.declared)}`
      : "";
  /** "1 entry listed", but "1 of ~5 entries listed". */
  const listed = () =>
    `${estimate()} ${estimate() === "" && props.rows === 1 ? "entry" : "entries"} listed`;
  return (
    <footer {...stylex.attrs(styles.bar, props.narrow && styles.barNarrow)}>
      <Show
        when={props.archive}
        fallback={
          <output
            id="status"
            {...stylex.attrs(styles.field, styles.idle, props.offline === true && styles.offline)}
          >
            <Show when={props.offline === true}>
              <span aria-hidden="true" {...stylex.attrs(styles.mark)} />
            </Show>
            {props.idle}
          </output>
        }
      >
        {(archive) => (
          <>
            {/* Regular weight: the file name shows bold nowhere in the tool views
                but in the top bar's own place. */}
            <span
              dir="ltr"
              {...stylex.attrs(styles.ink, styles.field, props.narrow && styles.gone, styles.name)}
            >
              {nameLabel(archive().name)}
            </span>
            {/* The one reading of the file size. The tree root and the
                totals give the uncompressed size. */}
            <span
              id="file-size"
              {...stylex.attrs(styles.field, props.narrow && styles.gone)}
              title={`The size of the archive file: ${exactBytes(archive().bytes)}`}
            >
              File size {formatSize(archive().bytes)}
            </span>
            {/* The declared count comes from the archive and can be any
                size, so this field shrinks with an ellipsis. */}
            <span
              id="entries-listed"
              title={`${integers.format(props.rows)}${listed()}`}
              {...stylex.attrs(
                // After a stop, "Stopped after 65,536 entries" gives the
                // count once. Screen readers keep this one.
                stopped() === undefined ? styles.name : controls.visuallyHidden,
              )}
            >
              <b id="row-count" {...stylex.attrs(styles.strong)}>
                {integers.format(props.rows)}
              </b>
              {listed()}
            </span>
            <Show when={storeShown()}>
              <span
                id="store-memory"
                {...stylex.attrs(styles.field, props.narrow && styles.gone)}
                title="Memory of the archive: wasm memory and shared mirrors of the listing, and preview memory"
              >
                Store {formatSize(props.storeBytes)}
              </span>
            </Show>
            <span {...stylex.attrs(styles.field, styles.progress)}>
              <Show when={parsing()}>
                <span
                  role="progressbar"
                  aria-label="Parse progress"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  aria-valuenow={String(Math.floor(progress() * 100))}
                  {...stylex.attrs(
                    styles.track,
                    (props.narrow || (props.phase.kind === "paused" && progress() < 0.01)) &&
                      styles.gone,
                  )}
                >
                  <span
                    {...stylex.attrs(styles.fill)}
                    style={{ transform: `scaleX(${progress()})` }}
                  />
                </span>
              </Show>
              <output id="status" data-phase={props.phase.kind} {...stylex.attrs(styles.message)}>
                {stopped() === undefined ? (
                  phaseText(props.phase)
                ) : (
                  <>
                    {stopped()![0]}
                    {/* The health strip shows the reason, so the map
                        margin does not show it again. A screen reader
                        still hears it from the live region. */}
                    <span {...stylex.attrs(controls.visuallyHidden)}>{stopped()![1]}</span>
                  </>
                )}
              </output>
            </span>
            {/* Cancel never shrinks, so it stays on the screen. While the
                memory prompt waits, its "Stop here" is the way to stop,
                so the map margin has no second control. */}
            <Show when={parsing() && props.phase.kind !== "paused"}>
              <button
                id="cancel-button"
                type="button"
                onClick={() => props.onCancel()}
                {...stylex.attrs(styles.field, styles.cancel, controls.focusRing)}
              >
                Cancel
              </button>
            </Show>
          </>
        )}
      </Show>
    </footer>
  );
}

const styles = stylex.create({
  bar: {
    alignItems: "center",
    backgroundColor: color.panel,
    borderTopColor: color.rule,
    borderTopStyle: "solid",
    borderTopWidth: 1,
    boxSizing: "border-box",
    color: color.inkMuted,
    columnGap: 18,
    display: "flex",
    fontSize: textSize.small,
    height: size.status,
    minWidth: 0,
    overflow: "hidden",
    paddingInline: size.gutter,
    whiteSpace: "nowrap",
  },
  field: {
    flexShrink: 0,
  },
  idle: {
    alignItems: "center",
    columnGap: 8,
    display: "inline-flex",
  },
  /** The offline reading is in ink: it confirms the offline line of the
   *  front door. */
  offline: {
    color: color.ink,
  },
  /** The offline mark: a 10 px ring of 1.5 px in ink. */
  mark: {
    borderColor: color.ink,
    borderRadius: "50%",
    borderStyle: "solid",
    borderWidth: 1.5,
    boxSizing: "border-box",
    height: 10,
    width: 10,
  },
  name: {
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  ink: {
    color: color.ink,
  },
  strong: {
    color: color.ink,
    fontWeight: 600,
  },
  barNarrow: {
    columnGap: 12,
  },
  gone: {
    display: "none",
  },
  progress: {
    alignItems: "center",
    columnGap: 8,
    display: "inline-flex",
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  message: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  /** A 1 px Rule Strong edge shows the extent of the track (3:1). */
  track: {
    backgroundColor: color.rule,
    boxShadow: `inset 0 0 0 1px ${color.ruleStrong}`,
    borderRadius: 2,
    display: "block",
    flexShrink: 0,
    height: 4,
    overflow: "hidden",
    width: 120,
  },
  fill: {
    backgroundColor: color.water,
    display: "block",
    height: "100%",
    transformOrigin: "left",
    transitionDuration: { default: "200ms", "@media (prefers-reduced-motion: reduce)": "0s" },
    transitionProperty: "transform",
  },
  cancel: {
    backgroundColor: "transparent",
    borderStyle: "none",
    color: color.water,
    cursor: "pointer",
    font: "inherit",
    padding: 0,
    textDecorationLine: { default: "none", ":hover": "underline" },
  },
});
