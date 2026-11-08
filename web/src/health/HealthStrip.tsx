// Archive health in the table strip, its list of findings, and the memory
// prompt.
import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";
import { BUDGET_QUESTION, severityCounts, STOPPED, STOPPED_ID } from "./findings";
import type { BudgetPause, Finding, Severity } from "./findings";

import { color, textSize } from "../theme/tokens.stylex";
import { controls } from "../shell/controls";
import { CutPath } from "../shell/CutPath";
import { Icon } from "../shell/icons";
import { COARSE_POINTER } from "../grid/scroll";
import { nameText } from "../label";
import { count } from "../format";

export interface HealthStripProps {
  findings: Finding[];
  /** The name of an example row, if it can show. */
  exampleName: (row: number) => string | undefined;
  /** Set while parsing waits at the soft memory budget. */
  pause: BudgetPause | undefined;
  onAnswer: (proceed: boolean) => void;
  /** True after the hard stop: the strip also says that the view
   *  controls are off, and "Show entry" is off. */
  stopped: boolean;
  /** Lists the folder of a row and previews the row. */
  onShowEntry: (row: number) => void;
  open: boolean;
  onToggle: () => void;
}

const NARROW = "@media (max-width: 699px)";
const LIST_NARROW = "@container (width < 480px)";
const LIST_WIDE = "@container (width >= 700px)";
const COARSE = "@media (pointer: coarse)";

const tone = (severity: Severity) =>
  severity === "error" ? styles.error : severity === "warning" ? styles.warning : styles.notice;
const iconTone = (severity: Severity) =>
  severity === "error" ? null : severity === "warning" ? styles.warnIcon : styles.noticeIcon;
const labelTone = (severity: Severity) =>
  severity === "error"
    ? styles.labelError
    : severity === "warning"
      ? styles.labelWarning
      : styles.noticeIcon;

/**
 * One line with the most severe finding and a button that opens the list of
 * all findings. With no findings it shows nothing. While parsing waits at
 * the memory budget, it shows the prompt.
 */
export function HealthStrip(props: HealthStripProps) {
  const first = () => props.findings[0];
  /** The tone of the strip. The hard stop is an error. */
  const severity = (): Severity => first()?.severity ?? "error";
  const example = (finding: Finding) =>
    finding.example >= 0 ? props.exampleName(finding.example) : undefined;

  return (
    <>
      <Show when={props.pause}>
        {(pause) => (
          <div id="budget-prompt" role="alert" {...stylex.attrs(styles.strip, styles.prompt)}>
            {/* A question about memory, not a finding of the archive: a
                neutral banner, not a health tone. */}
            <Icon name="info" />
            <span {...stylex.attrs(styles.text, styles.promptText)}>
              {pause().text.slice(0, -BUDGET_QUESTION.length)}
              <strong {...stylex.attrs(styles.question)}>{BUDGET_QUESTION}</strong>
            </span>
            {/* In the narrow layout the buttons go to a second line, so
                that the question shows whole. */}
            <span {...stylex.attrs(styles.actions)}>
              <button
                type="button"
                id="budget-continue"
                onClick={() => props.onAnswer(true)}
                {...stylex.attrs(controls.button, controls.focusRing, controls.primary)}
              >
                Continue
              </button>
              <button
                type="button"
                id="budget-stop"
                onClick={() => props.onAnswer(false)}
                {...stylex.attrs(controls.button, controls.focusRing)}
              >
                Stop here
              </button>
            </span>
          </div>
        )}
      </Show>
      {/* After the hard stop, the strip shows also before the finding of
          the memory limit comes: a refused request can come first. */}
      <Show when={first() !== undefined || props.stopped}>
        <div
          id="health-strip"
          data-severity={severity()}
          {...stylex.attrs(styles.strip, tone(severity()))}
        >
          {/* One icon for each tone, on the first line of the text: circle-x
              for an error, a triangle for a warning, and info for a notice.
              Only an error has the tinted band, so a bomb looks heavier than
              a duplicate name. */}
          <span {...stylex.attrs(styles.stripIcon, iconTone(severity()))}>
            <Icon
              name={severity() === "error" ? "failed" : severity() === "warning" ? "alert" : "info"}
            />
          </span>
          <span {...stylex.attrs(styles.stack)}>
            {/* While the list is open, the list has the texts: the strip
                shows only the count, split by severity, at the same place. */}
            <Show
              when={!props.open && first()}
              fallback={
                <Show when={props.findings.length > 0}>
                  <span {...stylex.attrs(styles.line)}>{severityCounts(props.findings)}</span>
                </Show>
              }
            >
              {(finding) => (
                <span {...stylex.attrs(styles.line, props.stopped && styles.lineStopped)}>
                  {finding().text}
                </span>
              )}
            </Show>
            {/* Its own line, so that it shows whole also in the narrow
                layout, where the finding text is cut. */}
            <Show when={props.stopped}>
              <span {...stylex.attrs(styles.line, styles.consequence)}>
                <span id={STOPPED_ID}>{STOPPED.controls}</span> {STOPPED.next}
              </span>
            </Show>
          </span>
          <Show when={props.findings.length > 0}>
            <button
              type="button"
              id="health-toggle"
              aria-expanded={props.open ? "true" : "false"}
              aria-controls="health-panel"
              onClick={() => props.onToggle()}
              {...stylex.attrs(styles.link, styles.toggle, controls.focusRing)}
            >
              {/* A disclosure: the chevron turns, and the width stays. */}
              <span {...stylex.attrs(styles.chevron, props.open && styles.chevronOpen)}>
                <Icon name="chevron" />
              </span>
              {count(props.findings.length, "finding")}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={props.open && props.findings.length > 0}>
        <section
          id="health-panel"
          aria-label="Archive health"
          {...stylex.attrs(styles.panel, COARSE_POINTER && styles.panelCoarse)}
        >
          <ul {...stylex.attrs(styles.list)}>
            {/* Each report makes new finding objects, so the items have a
                key by id: an item stays while its finding stays. */}
            <For each={props.findings} keyed={(finding) => finding.id}>
              {(finding) => (
                <li
                  data-finding={finding().id}
                  data-severity={finding().severity}
                  {...stylex.attrs(styles.item)}
                >
                  {/* One form for each severity, with no fill: the color and
                      the weight say it, so the error is the heaviest. */}
                  <span {...stylex.attrs(styles.label, labelTone(finding().severity))}>
                    {finding().severity}
                  </span>
                  <div {...stylex.attrs(styles.itemText)}>
                    <span {...stylex.attrs(finding().severity === "error" && styles.errorText)}>
                      {finding().text}
                    </span>
                    <Show when={example(finding())}>
                      {(name) => (
                        <span {...stylex.attrs(styles.example)}>
                          <span {...stylex.attrs(styles.exampleLabel)}>For example: </span>
                          <CutPath path={name()} />
                        </span>
                      )}
                    </Show>
                  </div>
                  {/* After the hard stop the worker refuses each folder
                      change, so the link is off, as "Show in tree" of the row
                      menu. */}
                  <Show when={example(finding())}>
                    <button
                      type="button"
                      data-action="show-entry"
                      aria-label={`Show entry ${nameText(example(finding()) ?? "")}`}
                      aria-disabled={props.stopped ? "true" : undefined}
                      aria-describedby={props.stopped ? STOPPED_ID : undefined}
                      onClick={() => {
                        if (!props.stopped) props.onShowEntry(finding().example);
                      }}
                      {...stylex.attrs(
                        styles.link,
                        styles.itemLink,
                        controls.focusRing,
                        controls.touchArea,
                      )}
                    >
                      Show entry
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
    </>
  );
}

const styles = stylex.create({
  /** The text wraps, so that a narrow strip shows the whole finding or
   *  question. A wide strip has one line. */
  strip: {
    alignItems: "flex-start",
    borderBottomColor: "color-mix(in srgb, currentColor 20%, transparent)",
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    boxSizing: "border-box",
    columnGap: 8,
    display: "flex",
    flexShrink: 0,
    // 8 + 20 + 7 and the rule, on the 36 px grid of the strips.
    lineHeight: "20px",
    minHeight: 36,
    paddingBlockEnd: 7,
    paddingBlockStart: 8,
    paddingInline: 12,
    rowGap: 4,
  },
  /** The icon on the first line of the text. */
  stripIcon: {
    display: "flex",
    flexShrink: 0,
    marginBlockStart: 2,
  },
  /** The memory prompt: neutral, with its 28 px buttons in the 36 px strip.
   *  The ground fill, the strong rule and the water bar part it from the
   *  raised column header below it. */
  prompt: {
    alignItems: { default: "center", [NARROW]: "flex-start" },
    backgroundColor: color.ground,
    borderBottomColor: color.ruleStrong,
    boxShadow: `inset 2px 0 0 ${color.water}`,
    color: color.ink,
    flexWrap: "wrap",
    paddingBlockEnd: { default: 3, [NARROW]: 8 },
    paddingBlockStart: { default: 4, [NARROW]: 8 },
    rowGap: 8,
  },
  /** The full width, and the question on a line of its own when the buttons go
   *  below the text, so the question keeps with its answers. */
  question: {
    display: { default: null, [NARROW]: "block" },
    fontWeight: 600,
  },
  promptText: {
    textWrap: "wrap",
  },
  text: {
    flexBasis: 0,
    flexGrow: 1,
    minWidth: 0,
    overflowWrap: "anywhere",
    textWrap: "pretty",
  },
  /** A line of the finding stack. */
  line: {
    overflowWrap: "anywhere",
    textWrap: "pretty",
  },
  /** The first line of the hard stop: this is the outcome of the parse. */
  lineStopped: {
    fontWeight: 600,
  },
  /** The buttons of the memory prompt. Below 700 px they are on their own
   *  line, at the end. */
  actions: {
    columnGap: 8,
    display: "flex",
    flexBasis: { default: "auto", [NARROW]: "100%" },
    justifyContent: "flex-end",
  },
  /** The lines of the finding. */
  stack: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
  },
  // A warning is on the ground, in ink, with a warn icon.
  warning: {
    backgroundColor: color.ground,
    borderBottomColor: color.rule,
    color: color.ink,
  },
  // crit / crit-bg: red-700 on red-50, red-400 on red-950 (night).
  error: {
    backgroundColor: color.critBg,
    color: color.crit,
  },
  // ink-muted on panel: stone-600 on stone-50, stone-400 on stone-900.
  notice: {
    backgroundColor: color.ground,
    borderBottomColor: color.rule,
    color: color.inkMuted,
  },
  warnIcon: {
    color: color.warn,
  },
  noticeIcon: {
    color: color.inkMuted,
  },
  link: {
    backgroundColor: "transparent",
    borderWidth: 0,
    // water: sky-700, sky-400 (night).
    color: color.water,
    // After the hard stop, `aria-disabled` gives the not-allowed cursor.
    cursor: { default: "pointer", ":is([aria-disabled=true])": "not-allowed" },
    flexShrink: 0,
    font: "inherit",
    padding: 0,
    textDecorationLine: "underline",
    textUnderlineOffset: 2,
  },
  /** The disclosure of the list. */
  toggle: {
    alignItems: "center",
    display: "inline-flex",
    fontVariantNumeric: "tabular-nums",
    textDecorationLine: "none",
    whiteSpace: "nowrap",
  },
  chevron: {
    display: "flex",
    transitionDuration: { default: "150ms", "@media (prefers-reduced-motion: reduce)": "0s" },
    transitionProperty: "transform",
  },
  chevronOpen: {
    transform: "rotate(90deg)",
  },
  /** The second line of the hard stop is a consequence, not the error. */
  consequence: {
    color: color.ink,
  },
  /** The example, on one line. CutPath takes the free width, so its width does
   *  not depend on its text. */
  example: {
    color: color.inkMuted,
    columnGap: 4,
    display: "flex",
  },
  exampleLabel: {
    flexShrink: 0,
  },
  /** After the hard stop, as the other controls that are off. */
  panel: {
    containerType: "inline-size",
    borderBottomColor: "color-mix(in srgb, currentColor 20%, transparent)",
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    flexShrink: 0,
    // The list takes the free height of the pane, down to about five table
    // rows below it, so it shows whole findings.
    maxHeight: "max(120px, calc(100% - 220px))",
    overflowY: "auto",
    // A shadow at the bottom edge while more findings are below it. The
    // first layer scrolls with the list and covers the shadow at the end.
    backgroundAttachment: "local, scroll",
    backgroundColor: color.ground,
    backgroundImage: `linear-gradient(to top, ${color.ground} 40%, transparent), radial-gradient(farthest-side at 50% 100%, color-mix(in srgb, ${color.ink} 18%, transparent), transparent)`,
    backgroundPosition: "bottom, bottom",
    backgroundRepeat: "no-repeat",
    backgroundSize: "100% 24px, 100% 10px",
  },
  /** The same five table rows below the list at COARSE_ROW_HEIGHT: 60 px
   *  more. */
  panelCoarse: {
    maxHeight: "max(120px, calc(100% - 280px))",
  },
  /** The left edge is the gutter of the strip. */
  list: {
    listStyle: "none",
    margin: 0,
    padding: "4px 12px",
  },
  /** Label, text and link. The panel is a container, so its width and not the
   *  width of the window chooses the form: the link docks in its own column
   *  when there is room, and a narrow item is one block with an inline label. */
  item: {
    alignItems: "baseline",
    columnGap: 12,
    display: { default: "grid", [LIST_NARROW]: "block" },
    gridTemplateColumns: {
      default: "64px minmax(0, 1fr)",
      [LIST_WIDE]: "64px minmax(0, 1fr) max-content",
    },
    // A touch screen gets items of at least 36 px, so the hit areas of two
    // "Show entry" links do not overlap.
    paddingBlock: { default: 4, [COARSE]: 8 },
  },
  label: {
    display: { default: "block", [LIST_NARROW]: "inline" },
    fontSize: textSize.label,
    letterSpacing: "0.04em",
    marginInlineEnd: { default: 0, [LIST_NARROW]: 8 },
    textTransform: "uppercase",
  },
  labelError: {
    color: color.crit,
    fontWeight: 700,
  },
  labelWarning: {
    color: color.warn,
    fontWeight: 500,
  },
  itemText: {
    display: { default: "block", [LIST_NARROW]: "inline" },
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  errorText: {
    fontWeight: 500,
  },
  /** Below the text; docked at the end of the first line when there is room. */
  itemLink: {
    display: "block",
    gridColumnStart: { default: 2, [LIST_WIDE]: 3 },
    justifySelf: "start",
  },
});
