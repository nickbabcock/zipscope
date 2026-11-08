import { expect, test } from "vitest";
import { spreadsheetText } from "./tsv";

test("text that a spreadsheet reads as a formula gets a quote", () => {
  for (const name of ["=1+1", "+1", "-2", "@SUM(A1)", "\tx", "\rx", '=HYPERLINK("x")']) {
    expect(spreadsheetText(name)).toBe(`'${name}`);
  }
});

test("other text stays", () => {
  for (const name of ["a=1", "docs/", "1+1", "'quoted", "", "名前.txt"]) {
    expect(spreadsheetText(name)).toBe(name);
  }
});
