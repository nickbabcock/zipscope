// The text of the archive lifecycle: the choice for a second file, the
// new-tab handoff, a file launch and the update notice. Kept in one module
// for a later translation.

export const lifecycle = {
  /** The title of the choice when a second file comes. */
  choiceTitle: (name: string) => `Open “${name}”`,
  /** The current archive stays when the user opens the file in a new tab. */
  choiceText: (open: string) =>
    `“${open}” is open in this tab. Zipscope shows one archive in each tab.`,
  /** A job that writes files stops when its archive closes. */
  choiceWriting: "Replace cancels the extraction or zstd copy in progress.",
  /** The title of the browser dialog when the choice did not load during
   *  a job. The file did not open, so the title does not say "Open". */
  choiceKeptTitle: (name: string) => `“${name}” did not open`,
  /** The browser dialog when the choice did not load during a job. */
  choiceKept: (open: string) =>
    `“${open}” stays open, because an extraction or zstd copy is in progress. To replace it, cancel the job, and then drop or choose the file again.`,
  cancel: "Cancel",
  newTab: "Open in new tab",
  replace: "Replace",
  /** The new tab while it waits for the file from the other tab. */
  receiving: "Opening the file from the other tab…",
  /** The window of a file launch while it waits for the file. */
  launching: "Opening the file…",
} as const;
