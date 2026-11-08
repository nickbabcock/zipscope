// Row text for a spreadsheet: "Copy row" gives tab-separated values.

/** Returns a text cell that a spreadsheet does not read as a formula: a
 *  cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return
 *  gets a `'` first (the OWASP rule for CSV injection). */
export function spreadsheetText(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}
