// Extraction with the real workers and wasm: the confirmation of large
// claims, and the summary of a job whose report does not list all items.
import { expect } from "vitest";
import { contentZip } from "../e2e/content-zip";
import type { ContentEntry } from "../e2e/content-zip";
import { LINK, text } from "../e2e/extract-zip";
import { PROGRESS_BYTES } from "../src/contracts";
import type { ExtractSink, ExtractTarget } from "../src/contracts";
import { itemCounts, itemText, needsConfirmation, summary, warnings } from "../src/extract/text";
import { outputFolder, test as base } from "./fixtures";
import type { Archive } from "./fixtures";

/** `listed` opens the archive of the entries, and checks that it lists. */
const test = base.extend("listed", async ({ open }) => async (entries: ContentEntry[]) => {
  const archive = await open(contentZip(entries));
  expect(archive.outcome.kind).toBe("complete");
  return archive;
});

/** Plans an extraction and runs it to the sink for the plan name, as the
 *  dialog does after the user confirms. */
async function extract(
  archive: Archive,
  target: ExtractTarget,
  sink: (name: string) => ExtractSink,
) {
  const plan = await archive.read!.plan(target);
  const progress = new SharedArrayBuffer(PROGRESS_BYTES);
  return { plan, report: await archive.read!.extract(plan.id, sink(plan.name), progress) };
}

/** The written files below the folder of the picker, by path. */
function written(out: ReturnType<typeof outputFolder>): Record<string, string> {
  return Object.fromEntries(
    out.files
      .filter((file) => file.closed && !file.aborted && !file.removed)
      .map((file) => [file.path, new TextDecoder().decode(file.bytes)]),
  );
}

test("a declared size over 1 GiB needs confirmation, and short data fails", async ({ listed }) => {
  const archive = await listed([{ name: "claims.bin", data: text(100_000), size: 2 ** 31 }]);
  const out = outputFolder();
  const { plan, report } = await extract(
    archive,
    { kind: "entry", row: archive.names.indexOf("claims.bin") },
    () => out.file("claims.bin"),
  );
  expect(needsConfirmation(plan)).toBe(true);
  expect(warnings(plan).join(" ")).toMatch(/more than 1\sGiB/);
  expect(summary(plan, report)).toContain("did not extract");
  expect(report.items.map(itemText).join(" ")).toContain("ended after");
  expect(written(out)).toEqual({});
});

test("a folder that claims more than 1 GiB in total needs confirmation", async ({ listed }) => {
  const archive = await listed([
    { name: "f/a.bin", data: text(1000), size: 2 ** 29 + 1 },
    { name: "f/b.bin", data: text(1000), size: 2 ** 29 + 1 },
    { name: "top.txt", data: text(10) },
  ]);
  const plan = await archive.read!.plan({ kind: "folder", path: "f/" });
  expect(needsConfirmation(plan)).toBe(true);
  expect(warnings(plan).join(" ")).toMatch(/in total, more than 1\sGiB/);
});

test("the summary counts the files of the job when the report does not list all items", async ({
  listed,
}) => {
  // 10,000 skipped links fill the report (`MAX_REPORT_ITEMS`), so the
  // file that does not verify is only in `more`.
  const links: ContentEntry[] = Array.from({ length: 10_000 }, (_, index) => ({
    name: `c/link${index}`,
    data: Buffer.from("/etc/passwd"),
    method: 0,
    ...LINK,
  }));
  const archive = await listed([
    ...links,
    { name: "c/good.txt", data: Buffer.from("good") },
    { name: "c/bad.txt", data: Buffer.from("bad crc data"), crc: 0x12345678 },
    // A second top item, so that the list shows the folder.
    { name: "top.txt", data: Buffer.from("t") },
  ]);
  const out = outputFolder();
  const { plan, report } = await extract(archive, { kind: "folder", path: "c/" }, out.directory);
  expect(summary(plan, report)).toBe(
    "Extracted 1 of 2 files (4 B written) to “c”. Each written file verified.",
  );
  // The links are skips of the plan, not files of the plan, so the counts
  // line keeps them apart from the files that are not written.
  expect(itemCounts(report)).toBe("10,000 items skipped, 1 more item not listed.");
  expect(written(out)).toEqual({ "c/good.txt": "good" });
});
