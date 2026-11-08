import { describe, expect, test } from "vitest";
import {
  chunkLines,
  decodeText,
  extension,
  hexDump,
  imageType,
  lineCount,
  looksBinary,
  previewKind,
} from "./sniff";

const bytes = (...values: number[]) => new Uint8Array(values);
const utf8 = (text: string) => new TextEncoder().encode(text);

describe("decodeText", () => {
  test("decodes UTF-8", () => {
    expect(decodeText(utf8("naïve café ✓"), true)).toEqual({
      text: "naïve café ✓",
      encoding: "utf-8",
    });
  });

  test("falls back to Windows-1252 for bytes that are not UTF-8", () => {
    // "café €5" in Windows-1252.
    const data = bytes(0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35);
    expect(decodeText(data, true)).toEqual({ text: "café €5", encoding: "windows-1252" });
  });

  test("keeps a UTF-8 sequence that the end of a chunk cuts", () => {
    const data = utf8("ab✓");
    const cut = data.subarray(0, data.length - 1);
    expect(decodeText(cut, false)).toEqual({ text: "ab", encoding: "utf-8" });
    // At the end of the entry, a cut sequence is invalid.
    expect(decodeText(cut, true).encoding).toBe("windows-1252");
  });

  test("decodes UTF-16 with a byte order mark", () => {
    expect(decodeText(bytes(0xff, 0xfe, 0x68, 0, 0x69, 0), true)).toEqual({
      text: "hi",
      encoding: "utf-16le",
    });
    expect(decodeText(bytes(0xfe, 0xff, 0, 0x68, 0, 0x69, 0), false).text).toBe("hi");
  });

  test("shows HTML as text", () => {
    const html = "<script>alert(1)</script><b>x</b>";
    expect(decodeText(utf8(html), true).text).toBe(html);
    expect(previewKind("index.html", utf8(html))).toBe("text");
  });
});

describe("looksBinary", () => {
  test("text is not binary", () => {
    expect(looksBinary(utf8("line one\r\nline two\tTab\n"))).toBe(false);
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });

  test("a NUL byte is binary", () => {
    expect(looksBinary(bytes(0x41, 0x42, 0x00, 0x43))).toBe(true);
  });

  test("Windows-1252 text is not binary", () => {
    const text = "Le café est très bon, à côté de la gare. ".repeat(20);
    const data = Uint8Array.from(text, (char) => char.charCodeAt(0));
    expect(looksBinary(data)).toBe(false);
  });

  test("a short Windows-1252 text is not binary", () => {
    expect(looksBinary(bytes(0x63, 0x61, 0x66, 0xe9, 0x20, 0x80))).toBe(false);
  });

  test("random high bytes are binary", () => {
    let seed = 7;
    const data = Uint8Array.from({ length: 4096 }, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return 0x80 | ((seed >> 16) % 0x80);
    });
    expect(looksBinary(data)).toBe(true);
  });

  test("control characters are binary", () => {
    const data = Uint8Array.from({ length: 100 }, (_, i) => (i % 4 === 0 ? 0x01 : 0x41));
    expect(looksBinary(data)).toBe(true);
  });

  test("a UTF-8 sequence cut at the end of the sample is not counted", () => {
    const data = utf8("✓".repeat(2731)).subarray(0, 8192);
    expect(looksBinary(data)).toBe(false);
  });
});

describe("imageType", () => {
  test("finds raster images by their bytes", () => {
    expect(imageType("a", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(imageType("a.dat", bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(imageType("a", utf8("GIF89a..."))).toBe("image/gif");
    expect(imageType("a", utf8("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  });

  test("needs the extension for weak signatures", () => {
    expect(imageType("a.bmp", utf8("BM...."))).toBe("image/bmp");
    expect(imageType("BMW.txt", utf8("BMW is a car"))).toBeUndefined();
  });

  test("finds SVG only with the extension and an svg element", () => {
    const svg = utf8('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(imageType("logo.svg", svg)).toBe("image/svg+xml");
    expect(imageType("logo.xml", svg)).toBeUndefined();
    expect(imageType("logo.svg", utf8("not an image"))).toBeUndefined();
  });

  test("binary data without a signature shows as hex", () => {
    expect(previewKind("a.bin", bytes(1, 2, 3, 0, 5))).toBe("hex");
    expect(previewKind("a.png", utf8("plain text"))).toBe("text");
  });
});

describe("hexDump", () => {
  test("shows offsets, hex and printable characters", () => {
    const dump = hexDump(utf8("Hello, world!\n\0\x7f0123"), 0x100);
    expect(dump.split("\n")).toEqual([
      "00000100  48 65 6c 6c 6f 2c 20 77  6f 72 6c 64 21 0a 00 7f  |Hello, world!...|",
      "00000110  30 31 32 33                                       |0123|",
    ]);
  });

  test("can show 8 bytes on each line, for a narrow pane", () => {
    expect(hexDump(utf8("Hello, world!"), 0, 8).split("\n")).toEqual([
      "00000000  48 65 6c 6c  6f 2c 20 77  |Hello, w|",
      "00000008  6f 72 6c 64  21           |orld!|",
    ]);
  });

  test("is empty for no bytes", () => {
    expect(hexDump(new Uint8Array(0))).toBe("");
  });
});

describe("chunkLines", () => {
  test("joins each group of lines, and the last group can be shorter", () => {
    expect(chunkLines(["a", "b", "c", "d", "e"], 2)).toEqual(["a\nb", "c\nd", "e"]);
    expect(chunkLines(["a", "b", "c", "d"], 2)).toEqual(["a\nb", "c\nd"]);
    expect(chunkLines(["a"], 256)).toEqual(["a"]);
  });

  test("keeps all the lines in order", () => {
    const lines = Array.from({ length: 1000 }, (_, line) => String(line));
    const chunks = chunkLines(lines, 256);
    expect(chunks).toHaveLength(4);
    expect(chunks.join("\n")).toBe(lines.join("\n"));
  });

  test("is empty for no lines", () => {
    expect(chunkLines([], 256)).toEqual([]);
  });
});

describe("helpers", () => {
  test("lineCount counts a last line without a line feed", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\n")).toBe(1);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("\n\n")).toBe(2);
  });

  test("extension takes the last part of the last segment", () => {
    expect(extension("dir.v1/Logo.SVG")).toBe("svg");
    expect(extension("dir.v1/README")).toBe("");
    expect(extension(".hidden")).toBe("");
  });
});
