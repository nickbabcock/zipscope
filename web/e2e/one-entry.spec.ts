// Opens an archive with one entry and checks that the cells of the first
// row get the pointer. Unused pool rows are hidden, and a hidden row must
// not cover a visible row (it blocks the hover text).
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openArchive, waitForOutcome } from "./listing";
import { storedZip } from "./stored-zip";

test("hidden pool rows do not cover the row of a one-entry archive", async ({ page }) => {
  const file = test.info().outputPath("one.zip");
  writeFileSync(file, storedZip([["only.txt", 5]]));
  await page.goto("/");
  await openArchive(page, file);
  const result = await waitForOutcome(page);
  expect(result.outcome, result.status).toBe("complete");
  // Let the frame loop draw the row.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  // For each cell of row 0, the cell key when the cell is not the element
  // at its center.
  const covered = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('#list-viewport [data-row="0"]');
    if (row === null || row.hidden) {
      return ["row 0 is not shown"];
    }
    const problems: string[] = [];
    for (const cell of row.children) {
      // A column with no value in this view has
      // no box.
      if ((cell as HTMLElement).hidden) continue;
      const box = cell.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (hit === null || !cell.contains(hit)) {
        problems.push((cell as HTMLElement).dataset.cell ?? "?");
      }
    }
    return problems;
  });
  expect(covered).toEqual([]);
});
