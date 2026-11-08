// The column picker: a popover with a check box for each optional column.
import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";
import { COLUMNS, OPTIONAL_COLUMNS } from "../grid/columns";
import type { ColumnKey, HiddenColumns } from "../grid/columns";
import { color, textSize } from "../theme/tokens.stylex";
import { controls } from "./controls";
import { Icon } from "./icons";

const LABELS = new Map<ColumnKey, string>(COLUMNS.map((column) => [column.key, column.label]));

export interface ColumnPickerProps {
  hidden: HiddenColumns;
  /** Hidden columns that have no room to show. A column that the user
   *  chose shows again when the window gets wider or the preview closes. */
  blocked: HiddenColumns;
  onChange: (key: ColumnKey, show: boolean) => void;
  /** True when the listing has no rows, so the columns can do nothing. */
  off: boolean;
}

export function ColumnPicker(props: ColumnPickerProps) {
  let button!: HTMLButtonElement;
  let popover!: HTMLDivElement;

  // Put the popover below the button, with its right edges aligned. The
  // popover is in the top layer, so its position is in the viewport.
  const place = (event: ToggleEvent) => {
    if (event.newState !== "open") {
      return;
    }
    const anchor = button.getBoundingClientRect();
    const width = popover.offsetWidth;
    const left = Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8));
    popover.style.left = `${left}px`;
    popover.style.top = `${anchor.bottom + 4}px`;
  };

  return (
    <>
      <button
        ref={(el) => (button = el)}
        id="column-picker-button"
        type="button"
        aria-label="Columns"
        title="Columns"
        disabled={props.off}
        popovertarget="column-picker"
        {...stylex.attrs(controls.iconButton, controls.focusRing)}
      >
        <Icon name="columns" />
      </button>
      <div
        ref={(el) => (popover = el)}
        id="column-picker"
        popover="auto"
        onToggle={place}
        {...stylex.attrs(styles.popover, controls.fadeIn)}
      >
        <fieldset {...stylex.attrs(styles.fieldset)}>
          <legend {...stylex.attrs(controls.label, styles.legend)}>Columns</legend>
          {OPTIONAL_COLUMNS.map((key) => (
            <label {...stylex.attrs(styles.option)}>
              <input
                type="checkbox"
                name={key}
                checked={!props.hidden.has(key)}
                disabled={props.blocked.has(key)}
                aria-describedby={props.blocked.has(key) ? "column-picker-note" : undefined}
                onChange={(event) => props.onChange(key, event.currentTarget.checked)}
                {...stylex.attrs(styles.check)}
              />
              {LABELS.get(key)}
            </label>
          ))}
        </fieldset>
        <Show when={props.blocked.size > 0}>
          <p id="column-picker-note" {...stylex.attrs(styles.note)}>
            No room for all columns. Make the window wider or close the preview.
          </p>
        </Show>
      </div>
    </>
  );
}

const styles = stylex.create({
  popover: {
    backgroundColor: color.overlay,
    borderColor: color.overlayRule,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: color.shadow,
    color: color.ink,
    font: "inherit",
    inset: "auto",
    margin: 0,
    minWidth: 168,
    padding: 4,
    position: "fixed",
  },
  fieldset: {
    borderStyle: "none",
    margin: 0,
    padding: 0,
  },
  legend: {
    paddingBlock: 6,
    paddingInline: 8,
  },
  option: {
    alignItems: "center",
    borderRadius: 4,
    columnGap: 8,
    cursor: "pointer",
    display: "flex",
    height: 28,
    paddingInline: 8,
    backgroundColor: { default: "transparent", ":hover": color.raised },
  },
  note: {
    color: color.inkMuted,
    fontSize: textSize.small,
    margin: 0,
    maxWidth: 200,
    paddingBlock: 6,
    paddingInline: 8,
  },
  check: {
    accentColor: color.water,
    margin: 0,
  },
});
