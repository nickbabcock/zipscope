import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { Encryption, TimeKind } from "./contracts";
import {
  copiedRatio,
  count,
  exactBytes,
  formatMethod,
  formatModified,
  formatRatio,
  formatSize,
} from "./format";

describe("formatSize", () => {
  test("uses binary units", () => {
    expect(formatSize(0)).toBe("0\u00a0B");
    expect(formatSize(1023)).toBe("1023\u00a0B");
    expect(formatSize(1024)).toBe("1.0\u00a0KiB");
    expect(formatSize(1536)).toBe("1.5\u00a0KiB");
    expect(formatSize(412.6 * 1024 * 1024)).toBe("412.6\u00a0MiB");
    expect(formatSize(1.84 * 1024 ** 3)).toBe("1.84\u00a0GiB");
    expect(formatSize(10.2 * 1024 ** 3)).toBe("10.2\u00a0GiB");
    expect(formatSize(3 * 1024 ** 4)).toBe("3.00\u00a0TiB");
    expect(formatSize(2 ** 64)).toBe("16.0\u00a0EiB");
  });

  test("moves to the next unit when rounding gives 1024", () => {
    expect(formatSize(1024 * 1024 - 1)).toBe("1.0\u00a0MiB");
    expect(formatSize(1024 ** 3 - 1)).toBe("1.00\u00a0GiB");
  });

  test("has no group marks, so that a size keeps its width", () => {
    expect(formatSize(1023.4 * 1024)).toBe("1023.4\u00a0KiB");
    expect(formatSize(2 ** 70)).toBe("1024.0\u00a0EiB");
  });

  test("gives the exact bytes for hover", () => {
    expect(exactBytes(1)).toBe("1 byte");
    expect(exactBytes(1_234_567)).toBe("1,234,567 bytes");
    expect(exactBytes(2 ** 53 + 2)).toBe("About 9,007,199,254,740,994 bytes");
  });
});

describe("formatRatio", () => {
  test("is compressed ÷ uncompressed", () => {
    expect(formatRatio(0, 0)).toBe("—");
    expect(formatRatio(5, 0)).toBe("—");
    expect(formatRatio(41.9, 412.6)).toBe("10.2%");
    expect(formatRatio(100, 100)).toBe("100.0%");
    expect(formatRatio(150, 100)).toBe("150.0%");
    expect(formatRatio(12_345, 1)).toBe("1234500.0%");
  });

  test("rounds a half-way value as the copied form does", () => {
    // 0.15% is a little below 0.15 in binary, so toFixed gives 0.1.
    expect(formatRatio(3, 2000)).toBe("0.1%");
    expect(copiedRatio(3, 2000)).toBe("0.1%");
  });

  test("has one fixed form for copied text", () => {
    expect(copiedRatio(0, 0)).toBe("—");
    expect(copiedRatio(41.9, 412.6)).toBe("10.2%");
    expect(copiedRatio(12_345, 1)).toBe("1234500.0%");
  });
});

describe("count", () => {
  test("groups the digits and takes the noun for the count", () => {
    expect(count(1, "file")).toBe("1 file");
    expect(count(65_539, "file")).toBe("65,539 files");
    expect(count(2, "entry", "entries")).toBe("2 entries");
  });
});

describe("formatMethod", () => {
  test("shows the method and the encryption", () => {
    expect(formatMethod(8, Encryption.NONE, 0).text).toBe("Deflate");
    expect(formatMethod(0, Encryption.NONE, 0).text).toBe("Stored");
    expect(formatMethod(77, Encryption.NONE, 0).text).toBe("Method 77");
    expect(formatMethod(8, Encryption.ZIP_CRYPTO, 0).text).toBe("ZipCrypto · Deflate");
    const aes = formatMethod(99, Encryption.AES_256 | Encryption.AE2, 8);
    expect(aes).toEqual({ text: "AES-256 · Deflate", title: "AES-256 (AE-2), method 8" });
    expect(formatMethod(99, Encryption.AES_128, 93).text).toBe("AES-128 · Zstandard");
    expect(formatMethod(99, Encryption.AES_UNKNOWN, 0).text).toBe("AES");
    expect(formatMethod(8, Encryption.OTHER, 0).text).toBe("Encrypted · Deflate");
  });
});

describe("formatModified", () => {
  beforeAll(() => {
    // UTC+05:30, so that local and UTC text differ.
    vi.stubEnv("TZ", "Asia/Kolkata");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  const ms = Date.UTC(2026, 9, 28, 9, 13, 6);

  test("shows UTC times in the viewer's time zone", () => {
    expect(formatModified(ms, TimeKind.EXTENDED)).toEqual({
      text: "2026-10-28 14:43",
      title: "2026-10-28 09:13:06 UTC",
      noTimeZone: false,
    });
    expect(formatModified(ms, TimeKind.NTFS).text).toBe("2026-10-28 14:43");
  });

  test("shows DOS times as written, with a marker", () => {
    expect(formatModified(ms, TimeKind.DOS)).toEqual({
      text: "2026-10-28 09:13",
      title: "No time zone: DOS time as written, 2026-10-28 09:13:06",
      noTimeZone: true,
    });
  });

  test("shows a dash for no time", () => {
    expect(formatModified(Number.NaN, TimeKind.NONE).text).toBe("—");
    expect(formatModified(1e20, TimeKind.EXTENDED).text).toBe("—");
  });
});
