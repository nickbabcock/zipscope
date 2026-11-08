// Extraction of hostile archives with the real workers and wasm: unsafe
// paths, reserved names, links, names that do not agree, corrupt data and
// claims that need confirmation. Each folder test runs to a folder of the
// folder picker and to one zip (the download).
import { deflateRawSync } from "node:zlib";
import { describe, expect } from "vitest";
import { PROGRESS_BYTES } from "../src/contracts";
import type {
  ExtractItem,
  ExtractPlanInfo,
  ExtractReport,
  ExtractSink,
  ExtractTarget,
} from "../src/contracts";
import { itemLead, itemReason, itemStatus, needsConfirmation, warnings } from "../src/extract/text";
import { hostileZip, readDownload, unicodePath } from "../e2e/hostile-zip";
import type { HostileEntry } from "../e2e/hostile-zip";
import { outputFolder, test as base } from "./fixtures";
import type { Archive } from "./fixtures";

const body = (name: string, value = name): HostileEntry => ({ name, body: Buffer.from(value) });

/** `zip` opens the archive of the entries, and checks that it lists. */
const test = base.extend("zip", async ({ open }) => async (entries: HostileEntry[]) => {
  const archive = await open(hostileZip(entries));
  expect(archive.outcome.kind).toBe("complete");
  return archive;
});

/** Plans an extraction and runs it to the sink that `sink` gives for the
 *  plan, as the dialog does after the user confirms. */
async function extract(
  archive: Archive,
  target: ExtractTarget,
  sink: (plan: ExtractPlanInfo) => ExtractSink,
) {
  const plan = await archive.read!.plan(target);
  const progress = new SharedArrayBuffer(PROGRESS_BYTES);
  return { plan, report: await archive.read!.extract(plan.id, sink(plan), progress) };
}

/** The item of a row in the report. */
const item = (report: ExtractReport, row: number) =>
  report.items.find((candidate) => candidate.row === row);

/** The text of the reason cell of a report row. */
const reason = (entry: ExtractItem) => `${itemLead(entry)}${itemReason(entry)}`;

function skipped(report: ExtractReport, row: number, pattern: RegExp) {
  const entry = item(report, row);
  expect(entry, `row ${row}`).toBeDefined();
  expect(itemStatus(entry!)).toBe("skipped");
  expect(reason(entry!)).toMatch(pattern);
}

type Route = "directory" | "zip";

/** Extracts a folder (the whole archive at "") and returns the written
 *  files, with their paths below the output folder. */
async function folderOutput(archive: Archive, route: Route, path = "") {
  const out = outputFolder();
  const { plan, report } = await extract(archive, { kind: "folder", path }, (planned) =>
    route === "directory" ? out.directory(planned.name) : { kind: "blob" },
  );
  if (route === "zip") {
    const files = readDownload(Buffer.from(await report.blob!.arrayBuffer()));
    return { report, files: files.filter((entry) => !entry.name.endsWith("/")) };
  }
  for (const file of out.files) expect(file.opens, file.path).toBe(1);
  const prefix = `${plan.name}/`;
  const files = out.files
    .filter((file) => file.closed && !file.aborted && !file.removed)
    .map((file) => {
      expect(file.path.startsWith(prefix)).toBe(true);
      return { name: file.path.slice(prefix.length), body: Buffer.from(file.bytes) };
    });
  return { report, files };
}

function safePath(path: string) {
  expect(path).not.toMatch(/^[\\/]|[\0\\:]/);
  const segments = path.split("/");
  expect(segments).not.toContain("..");
  for (const segment of segments) {
    expect(segment).not.toMatch(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i);
  }
}

for (const method of [0, 8, 20, 93]) {
  test(`one entry verifies method ${method} and saves exact bytes to the save picker and to a download`, async ({
    zip,
  }) => {
    const data = Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 251));
    const archive = await zip([{ name: "one.bin", body: data, method }]);
    const out = outputFolder();
    const saved = await extract(archive, { kind: "entry", row: 0 }, () => out.file("one.bin"));
    expect(saved.report.outcome).toBe("complete");
    expect(out.files).toHaveLength(1);
    expect(out.files[0]).toMatchObject({ closed: true, aborted: false });
    expect(Buffer.from(out.files[0]!.bytes)).toEqual(data);
    const downloaded = await extract(archive, { kind: "entry", row: 0 }, () => ({ kind: "blob" }));
    expect(downloaded.report.output).toBe("one.bin");
    expect(Buffer.from(await downloaded.report.blob!.arrayBuffer())).toEqual(data);
  });
}

for (const route of ["directory", "zip"] as const) {
  describe(route, () => {
    test("a folder skips traversal, roots, drives and NUL and keeps the safe siblings", async ({
      zip,
    }) => {
      const unsafe = [
        "../escape",
        "a/../../escape",
        "a/../escape",
        "..\\escape",
        "a\\..\\escape",
        "a/..\\escape",
        "/absolute",
        "\\absolute",
        "//server/share/x",
        "\\\\server\\share\\x",
        "C:/escape",
        "c:\\escape",
        "C:relative",
        "a/C:relative",
        "\\\\?\\C:\\escape",
        "zero\0tail",
        "a/zero\0tail",
        "../",
        "a/../",
        "/",
        "C:",
        `${"d/".repeat(32_000)}../escape`,
        "../<img id=extraction-injected src=x onerror=alert(1)>",
      ];
      const safe = ["ok.txt", ".../ok", "..hidden", "x..y", "deep/a/b.txt"];
      // A segment that ends with a dot gets "_" (renamed, TRAILING), because
      // Windows removes trailing dots. Thus ".../ok" is written as "..._/ok".
      const output = (name: string) => name.replace(/^\.\.\.\//, "..._/");
      const archive = await zip([
        ...unsafe.map((name) => body(name)),
        ...safe.map((name) => body(name)),
      ]);
      const { report, files } = await folderOutput(archive, route);
      expect(files.map((file) => file.name).sort()).toEqual(safe.map(output).sort());
      for (const file of files) expect(output(file.body.toString())).toBe(file.name);
      for (let row = 0; row < unsafe.length; row++) {
        skipped(report, row, /path|travers|absolute|drive|NUL|invalid|unsafe/i);
      }
    });

    test("a folder renames devices and collisions and overwrites no payload", async ({ zip }) => {
      const names = [
        "CON",
        "con.txt",
        "NUL",
        "aux.log",
        "PRN",
        "COM1.bin",
        "lpt9.txt",
        "nested/CON",
        "NUL/sub/data",
        "A.txt",
        "a.TXT",
        "A.txt",
        "a (1).txt",
        "a_1.txt",
        "Dir/x",
        "dir/X",
        "file",
        "file/child",
        "COM10.txt",
        "console.txt",
        "back\\slash.txt",
        "back/slash.txt",
        "É.txt",
        "é.TXT",
      ];
      const archive = await zip(names.map((name, row) => body(name, `payload ${row}`)));
      const { report, files } = await folderOutput(archive, route);
      expect(files).toHaveLength(names.length);
      expect(files.map((file) => file.body.toString()).sort()).toEqual(
        names.map((_, row) => `payload ${row}`).sort(),
      );
      const paths = files.map((file) => file.name.toLowerCase());
      expect(new Set(paths).size).toBe(paths.length);
      for (const path of paths) {
        safePath(path);
        expect(paths.some((other) => other.startsWith(`${path}/`))).toBe(false);
      }
      // A row that keeps its path has no report item. Its path is its name
      // with "/" for "\\", below the renamed folders of the report (row -1).
      const folders: [string, string][] = [];
      for (const folder of report.items.filter((entry) => entry.row === -1)) {
        expect(itemStatus(folder)).toBe("renamed");
        expect(reason(folder)).toMatch(/renam|collis|reserv|conflict|exists/i);
        folders.push([folder.name, folder.path ?? ""]);
      }
      const plainPath = (name: string) => {
        let path = name
          .split(/[/\\]/)
          .filter((part) => part !== "")
          .join("/");
        for (const [from, to] of folders.sort((a, b) => b[0].length - a[0].length)) {
          if (path.startsWith(from)) path = to + path.slice(from.length);
        }
        return path;
      };
      for (let row = 0; row < names.length; row++) {
        const listed = item(report, row);
        const path = listed === undefined ? plainPath(names[row]!) : listed.path;
        expect(path).toBeDefined();
        expect(files.find((file) => file.name === path)?.body.toString()).toBe(`payload ${row}`);
        if (listed === undefined) {
          // A row without a report item kept its own name.
          expect(path!.split("/").at(-1)).toBe(names[row]!.split(/[/\\]/).at(-1));
        } else {
          expect(itemStatus(listed)).toBe("renamed");
          expect(reason(listed)).toMatch(/renam|collis|reserv|conflict|exists/i);
        }
      }
      expect(files.some((file) => file.name === "COM10.txt")).toBe(true);
      expect(files.some((file) => file.name === "console.txt")).toBe(true);
    });

    test("a folder renames invisible characters and keeps the joiners that real names need", async ({
      zip,
    }) => {
      // [archive name, output name, renamed]
      const names: [string, string, boolean][] = [
        ["setup.p​df", "setup.p_df", true],
        ["﻿", "_", true],
        ["﻿a.txt", "_a.txt", true],
        ["a.txt", "a.txt", false],
        // The same name as the output name of the BOM row.
        ["_a.txt", "_a (2).txt", true],
        [".ex‍e", ".ex_e", true],
        ["x️.txt", "x_.txt", true],
        ["می‌خ.pdf", "می‌خ.pdf", false],
        ["❤️‍\u{1f525}.png", "❤️‍\u{1f525}.png", false],
      ];
      const archive = await zip(names.map(([name], row) => body(name, `payload ${row}`)));
      const { report, files } = await folderOutput(archive, route);
      expect(files.map((file) => [file.name, file.body.toString()]).sort()).toEqual(
        names.map(([, output], row) => [output, `payload ${row}`]).sort(),
      );
      for (const [row, [, output, renamed]] of names.entries()) {
        const listed = item(report, row);
        if (!renamed) {
          expect(listed).toBeUndefined();
          continue;
        }
        expect(itemStatus(listed!)).toBe("renamed");
        expect(listed!.path).toBe(output);
        expect(reason(listed!)).toMatch(row === 4 ? /case/ : /do not show/);
      }
    });

    test("symbolic links are skipped and never become output links", async ({ zip }) => {
      const archive = await zip([
        { ...body("link", "../../outside"), attributes: (0o120777 << 16) >>> 0 },
        { ...body("linkdir/", "../outside"), attributes: (0o120777 << 16) >>> 0 },
        body("real.txt", "real"),
      ]);
      const { report, files } = await folderOutput(archive, route);
      expect(files.map((file) => [file.name, file.body.toString()])).toEqual([
        ["real.txt", "real"],
      ]);
      skipped(report, 0, /sym.*link|symbolic.*link/i);
      skipped(report, 1, /sym.*link|symbolic.*link/i);
    });

    test("decoded names control path safety and CP437 names stay readable", async ({ zip }) => {
      const raw = Buffer.from("safe.txt");
      const archive = await zip([
        {
          name: Buffer.from([0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74]),
          body: Buffer.from("cp437"),
          flags: 0,
        },
        {
          name: raw,
          body: Buffer.from("escape"),
          flags: 0,
          extra: unicodePath(raw, "../outside"),
        },
        {
          name: Buffer.from("plain"),
          body: Buffer.from("unicode"),
          flags: 0,
          extra: unicodePath(Buffer.from("plain"), "日本語.txt"),
        },
      ]);
      const { report, files } = await folderOutput(archive, route);
      expect(files.map((file) => [file.name, file.body.toString()]).sort()).toEqual(
        [
          ["café.txt", "cp437"],
          ["日本語.txt", "unicode"],
        ].sort(),
      );
      skipped(report, 1, /path|travers|unsafe/i);
    });

    test("a local header name or size that does not agree is skipped before a write", async ({
      zip,
    }) => {
      const archive = await zip([
        { ...body("listed.txt"), localName: Buffer.from("hidden.exe") },
        { ...body("size.txt"), localSize: 123n },
        { ...body("compressed.txt"), localCompressed: 123n },
        { ...body("missing.txt"), localOffset: 0x7fff_ffff },
        body("ok.txt", "ok"),
      ]);
      const out = outputFolder();
      const { plan, report } = await extract(archive, { kind: "folder", path: "" }, (planned) =>
        route === "directory" ? out.directory(planned.name) : { kind: "blob" },
      );
      const files =
        route === "zip"
          ? readDownload(Buffer.from(await report.blob!.arrayBuffer())).map((file) => file.name)
          : out.files.map((file) => file.path.slice(plan.name.length + 1));
      // A folder job opens no file for a skipped row.
      expect(files).toEqual(["ok.txt"]);
      for (let row = 0; row < 4; row++)
        skipped(report, row, /local|header|name|size|offset|found/i);
    });

    test("a folder keeps empty files and valid signed and unsigned descriptors", async ({
      zip,
    }) => {
      const entries: HostileEntry[] = [
        { ...body("empty", ""), method: 8 },
        { ...body("signed.txt", "PK\x03\x04 PK\x07\x08"), method: 8, descriptor: "signed" },
        { ...body("unsigned.txt", "data"), method: 8, descriptor: "unsigned" },
        body("sub/", ""),
        body("sub/child", "child"),
      ];
      const { files } = await folderOutput(await zip(entries), route);
      expect(files.map((file) => [file.name, file.body.toString()]).sort()).toEqual(
        entries
          .filter((entry) => !String(entry.name).endsWith("/"))
          .map((entry) => [String(entry.name), entry.body.toString()])
          .sort(),
      );
    });

    test("a selected folder has its descendants and not its prefix siblings", async ({ zip }) => {
      const archive = await zip([
        body("pick/a", "a"),
        body("pick/sub/b", "b"),
        body("picky/c", "c"),
        body("outside", "d"),
      ]);
      const { files } = await folderOutput(archive, route, "pick/");
      expect(files.map((file) => file.body.toString()).sort()).toEqual(["a", "b"]);
      for (const file of files) safePath(file.name);
    });
  });
}

for (const [label, corrupt] of [
  ["a false CRC", { ...body("bad.txt", "false CRC"), method: 8, crc: 0xdeadbeef }],
  ["excess output", { ...body("bad.txt", "abc".repeat(20_000)), method: 8, size: 7n }],
  ["an early end", { ...body("bad.txt", "short"), method: 8, size: 500n }],
  [
    "truncated deflate",
    { ...body("bad.txt", "12345".repeat(100)), method: 8, data: Buffer.from([0x03]) },
  ],
  ["encryption", { ...body("bad.txt", "ciphertext"), flags: 1 }],
  ["AES without the encrypted flag", { ...body("bad.txt", "ciphertext"), method: 99 }],
  ["an unsupported method", { ...body("bad.txt", "opaque data"), method: 12 }],
] as const) {
  for (const selection of ["one", "folder"] as const) {
    for (const route of ["picker", "download"] as const) {
      test(`${selection === "one" ? "one entry" : "a folder"} to the ${route} never completes output for ${label}`, async ({
        zip,
      }) => {
        const archive = await zip([corrupt]);
        const out = outputFolder();
        const { report } = await extract(
          archive,
          selection === "one" ? { kind: "entry", row: 0 } : { kind: "folder", path: "" },
          (plan) =>
            route === "download"
              ? { kind: "blob" }
              : selection === "one"
                ? out.file("bad.txt")
                : out.directory(plan.name),
        );
        const entry = item(report, 0);
        expect(entry).toBeDefined();
        expect(itemStatus(entry!)).toMatch(/^(failed|skipped)$/);
        expect(`${reason(entry!)} ${report.error ?? ""}`).toMatch(
          /CRC|checksum|size|longer|ended|decod|encrypt|invalid|deflate|method|unsupported/i,
        );
        expect(report.written).toBe(0);
        expect(out.files.every((file) => !file.closed || file.aborted)).toBe(true);
        if (label === "excess output") {
          for (const file of out.files) expect(file.bytes.length).toBeLessThanOrEqual(7);
        }
        if (report.blob !== undefined) {
          // A folder can finish an empty zip after it skips the entry.
          expect(selection).toBe("folder");
          expect(readDownload(Buffer.from(await report.blob.arrayBuffer()))).toEqual([]);
        }
      });
    }
  }
}

for (const selection of ["one", "folder"] as const) {
  const target = (archive: Archive, name: string) =>
    selection === "one"
      ? ({ kind: "entry", row: archive.names.indexOf(name) } as const)
      : ({ kind: "folder", path: "" } as const);

  test(`${selection === "one" ? "one entry" : "a folder"} with a high ratio asks before it writes`, async ({
    zip,
  }) => {
    // The ratio rule needs at least 16 MiB, so the file has 17 MiB of "a".
    const archive = await zip([{ ...body("ratio.txt", "a".repeat(17 * 1024 * 1024)), method: 8 }]);
    const plan = await archive.read!.plan(target(archive, "ratio.txt"));
    expect(needsConfirmation(plan)).toBe(true);
    expect(warnings(plan).join(" ")).toMatch(/100 times/);
    // Cancel drops the plan, and no job starts.
    await archive.read!.dropPlan(plan.id);
  });

  test(`${selection === "one" ? "one entry" : "a folder"} with a huge zip64 claim asks before it writes`, async ({
    zip,
  }) => {
    const archive = await zip([{ ...body("huge.bin", "x"), size: 1n << 60n }]);
    const plan = await archive.read!.plan(target(archive, "huge.bin"));
    expect(needsConfirmation(plan)).toBe(true);
    expect(warnings(plan).join(" ")).toMatch(/more than 1\sGiB/);
    await archive.read!.dropPlan(plan.id);
  });
}

test("a disk error aborts the entry and does not report success", async ({ zip }) => {
  const archive = await zip([body("entry.txt", "content")]);
  const out = outputFolder({ failWrite: true });
  const { report } = await extract(archive, { kind: "entry", row: 0 }, () => out.file("entry.txt"));
  const entry = item(report, 0);
  expect(entry).toBeDefined();
  expect(itemStatus(entry!)).toBe("failed");
  expect(reason(entry!)).toMatch(/disk|full|write/i);
  expect(out.files.every((file) => !file.closed)).toBe(true);
});

test("a folder zip keeps valid deflate data as it is", async ({ zip }) => {
  const data = Buffer.from("pass-through payload\n".repeat(20));
  const compressed = deflateRawSync(data, { level: 1 });
  const archive = await zip([{ name: "entry.txt", body: data, method: 8, data: compressed }]);
  const { report } = await extract(archive, { kind: "folder", path: "" }, () => ({
    kind: "blob",
  }));
  const entries = readDownload(Buffer.from(await report.blob!.arrayBuffer()));
  expect(entries).toHaveLength(1);
  expect(entries[0]!.body).toEqual(data);
  expect(entries[0]!.method).toBe(8);
  expect(entries[0]!.compressed).toEqual(compressed);
});
