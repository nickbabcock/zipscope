// A sentence with a file name in quotes, for the dialogs.
import * as stylex from "@stylexjs/stylex";
import { dialogStyle } from "./dialog";

/** Shows `text`. A name in “quotes” does not break inside: it goes to the
 *  next line whole, and breaks only when it is wider than the dialog. The
 *  caller gives each name through `nameLabel`. */
export function FileText(props: { text: string }) {
  return (
    <>
      {props.text.split(/(“[^”]*”)/).map((part) =>
        part.startsWith("“") ? (
          <span dir="ltr" {...stylex.attrs(dialogStyle.fileName)}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
