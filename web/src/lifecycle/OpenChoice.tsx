// The choice when a second file comes while an archive is open: replace the open archive, or open the file in a new
// tab. One tab has one archive, which gives each archive its own process
// and memory.
//
// Replace is the primary action and has the focus. When a job writes
// files, Replace cancels it: that view asks to accept a loss, so it has no
// primary button, and Cancel has the focus (DESIGN.md, Buttons and dialogs).
import * as stylex from "@stylexjs/stylex";
import { onSettled, Show } from "solid-js";
import { controls } from "../shell/controls";
import { dialogStyle } from "../shell/dialog";
import { FileText } from "../shell/FileText";
import { Icon } from "../shell/icons";
import { lifecycle } from "./strings";
import { nameLabel } from "../label";

export interface OpenChoiceProps {
  /** The name of the file that came. */
  name: string;
  /** The name of the open archive. */
  open: string;
  /** True while a job of the open archive writes files. */
  writing: boolean;
  onReplace: () => void;
  onNewTab: () => void;
  onCancel: () => void;
}

export function OpenChoice(props: OpenChoiceProps) {
  let dialog!: HTMLDialogElement;
  onSettled(() => {
    dialog.showModal();
    return () => dialog.close();
  });
  return (
    <dialog
      ref={(el) => (dialog = el)}
      id="open-choice"
      aria-labelledby="open-choice-title"
      aria-describedby="open-choice-text"
      onCancel={(event) => {
        event.preventDefault();
        props.onCancel();
      }}
      {...stylex.attrs(dialogStyle.frame, controls.fadeIn)}
    >
      <h2 id="open-choice-title" {...stylex.attrs(dialogStyle.title)}>
        <FileText text={lifecycle.choiceTitle(nameLabel(props.name))} />
      </h2>
      <p id="open-choice-text" {...stylex.attrs(dialogStyle.text)}>
        <FileText text={lifecycle.choiceText(nameLabel(props.open))} />
      </p>
      <Show when={props.writing}>
        <p
          id="open-choice-writing"
          role="alert"
          {...stylex.attrs(dialogStyle.banner, dialogStyle.warn)}
        >
          <Icon name="alert" />
          <span {...stylex.attrs(dialogStyle.bannerBody)}>{lifecycle.choiceWriting}</span>
        </p>
      </Show>
      <div {...stylex.attrs(dialogStyle.footer)}>
        <button
          id="open-choice-cancel"
          type="button"
          autofocus={props.writing}
          onClick={() => props.onCancel()}
          {...stylex.attrs(controls.button, dialogStyle.button)}
        >
          {lifecycle.cancel}
        </button>
        <button
          id="open-choice-new-tab"
          type="button"
          onClick={() => props.onNewTab()}
          {...stylex.attrs(controls.button, dialogStyle.button)}
        >
          <Icon name="popout" />
          {lifecycle.newTab}
        </button>
        <button
          id="open-choice-replace"
          type="button"
          autofocus={!props.writing}
          onClick={() => props.onReplace()}
          {...stylex.attrs(controls.button, dialogStyle.button, !props.writing && controls.primary)}
        >
          <Icon name="archive" />
          {lifecycle.replace}
        </button>
      </div>
    </dialog>
  );
}
