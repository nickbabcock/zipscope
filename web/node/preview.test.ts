// The read of an entry for its preview, with the real workers and wasm.
import { zstdCompressSync } from "node:zlib";
import { expect } from "vitest";
import { contentZip, skippableFrame } from "../e2e/content-zip";
import type { ContentEntry } from "../e2e/content-zip";
import { LocalMismatch } from "../src/contracts";
import { localHeaderFindings } from "../src/health/findings";
import { test as base } from "./fixtures";
import type { Archive } from "./fixtures";

/** `listed` opens the archive of the entries, and checks that it lists. */
const test = base.extend("listed", async ({ open }) => async (entries: ContentEntry[]) => {
  const archive = await open(contentZip(entries));
  expect(archive.outcome.kind).toBe("complete");
  return archive;
});

/** Reads the first MiB of an entry, as the preview does. */
const preview = (archive: Archive, name: string) =>
  archive.read!.read(archive.names.indexOf(name), 0, 1 << 20);

test("flags a local header that names another file", async ({ listed }) => {
  const archive = await listed([
    { name: "invoice.pdf", localName: "setup.exe", data: Buffer.from("not a pdf") },
    { name: "ok.txt", data: Buffer.from("fine") },
  ]);
  const flagged = await preview(archive, "invoice.pdf");
  expect(flagged.check.mismatches & LocalMismatch.NAME).not.toBe(0);
  expect(flagged.check.localName).toBe("setup.exe");
  // The health list gets the finding of the checked row.
  const checked = new Map([[flagged.row, flagged.check.mismatches]]);
  expect(localHeaderFindings(checked)[0]?.text).toMatch(/local header that does not agree/);
  const ok = await preview(archive, "ok.txt");
  expect(new TextDecoder().decode(ok.bytes)).toBe("fine");
  expect(ok.check.mismatches).toBe(0);
});

test("decodes Zstandard data with more than one frame", async ({ listed }) => {
  const frames = Buffer.concat([
    skippableFrame(4),
    zstdCompressSync(Buffer.from("hello")),
    skippableFrame(0),
    zstdCompressSync(Buffer.from(" world")),
  ]);
  const archive = await listed([
    { name: "frames.txt", data: Buffer.from("hello world"), method: 93, compressed: frames },
  ]);
  const chunk = await preview(archive, "frames.txt");
  expect(new TextDecoder().decode(chunk.bytes)).toBe("hello world");
  expect(chunk.state).toBe("verified");
});
