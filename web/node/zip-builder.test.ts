// The zip builder of the hostile extraction tests and the reader of their
// output agree, and the reader refuses output that does not verify.
import { expect, test } from "vitest";
import { hostileZip, readDownload, unicodePath } from "../e2e/hostile-zip";

for (const method of [0, 8, 20, 93]) {
  test(`the byte fixture and output reader agree on method ${method}`, () => {
    const body = Buffer.from("PK\x03\x04 PK\x07\x08 PK\x01\x02 data\n".repeat(10));
    const bytes = hostileZip([
      { name: "data", body, method },
      { name: "empty", body: Buffer.alloc(0), method },
      { name: "signed", body, method, descriptor: "signed" },
      { name: "unsigned", body, method, descriptor: "unsigned" },
    ]);
    expect(readDownload(bytes).map((entry) => [entry.name, entry.body])).toEqual([
      ["data", body],
      ["empty", Buffer.alloc(0)],
      ["signed", body],
      ["unsigned", body],
    ]);
  });
}

test("the output reader rejects a false CRC", () => {
  const bytes = hostileZip([{ name: "bad", body: Buffer.from("bad"), method: 8, crc: 0xdeadbeef }]);
  expect(() => readDownload(bytes)).toThrow("Output did not verify");
});

test("the output reader rejects unequal local and central names", () => {
  const bytes = hostileZip([
    { name: "listed", localName: Buffer.from("hidden"), body: Buffer.from("bad") },
  ]);
  expect(() => readDownload(bytes)).toThrow("Output names differ");
});

test("the output reader accepts CP437 and Unicode Path names", () => {
  const raw = Buffer.from("plain");
  const bytes = hostileZip([
    { name: Buffer.from("caf\x82.txt", "latin1"), flags: 0, body: Buffer.from("cp437") },
    { name: raw, flags: 0, extra: unicodePath(raw, "日本語.txt"), body: Buffer.from("unicode") },
  ]);
  expect(readDownload(bytes).map((entry) => entry.name)).toEqual(["café.txt", "日本語.txt"]);
});
