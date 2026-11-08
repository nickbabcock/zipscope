// CSS anchor positioning at the browser floor. Firefox 147 and Safari 26
// have `position-area`. Chrome has it from version 129. Chrome 125 to 128
// use the old name `inset-area`, so there the row menu and the DOS note
// card place themselves with script.

/** True when the browser has `position-area`. */
export const ANCHORS = typeof CSS !== "undefined" && CSS.supports("position-area: block-end");
