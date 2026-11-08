import { describe, expect, test } from "vitest";
import {
  alwaysMarked,
  commentText,
  countsInFinding,
  directed,
  isJoiner,
  isPlainName,
  isVariation,
  MARK,
  nameLabel,
  nameText,
  nameTitle,
} from "./label";

const LRI = "\u2067";
const PDI = "\u2069";

describe("marks", () => {
  test("a bidi override shows in the true order, and the extension is true", () => {
    expect(nameText("invoice\u202Efdp.exe")).toBe(`invoice${MARK}fdp.exe`);
    expect(nameTitle("invoice\u202Efdp.exe")).toBe("invoice[U+202E]fdp.exe");
  });

  test("isolates, the implicit marks and a line separator show", () => {
    expect(nameText("a\u2066b\u2069\u200E\u200F\u061C\u2028.txt")).toBe(
      `a${MARK}b${MARK}${MARK}${MARK}${MARK}${MARK}.txt`,
    );
  });

  test("C0, DEL and C1 show as the mark", () => {
    expect(nameText("a\nb\0c\td\x7fe\x85f\x9f")).toBe(
      `a${MARK}b${MARK}c${MARK}d${MARK}e${MARK}f${MARK}`,
    );
    expect(nameTitle("a\nb")).toBe("a[U+000A]b");
    expect(nameTitle("\u{e0041}")).toBe("[U+E0041]");
  });

  test("invisible format characters show", () => {
    for (const hidden of [
      "\u00AD",
      "\u034F",
      "\u115F",
      "\u17B4",
      "\u180E",
      "\u200B",
      "\u2060",
      "\u2064",
      "\u206A",
      "\u3164",
      "\uFEFF",
      "\uFFA0",
      "\uFFF9",
      "\u{1BCA0}",
      "\u{1D173}",
      "\u{E0001}",
      "\u{E0041}",
      "\u{E0FFF}",
    ]) {
      expect(nameText(`a${hidden}b`), hidden.codePointAt(0)!.toString(16)).toBe(`a${MARK}b`);
    }
  });

  test("real names, lookalikes and visible spaces stay", () => {
    for (const name of [
      "plain/name-1.txt",
      "日本語/ファイル.txt",
      "café�.txt",
      "no break",
      "wide　space",
      "fullwidth．txt",
      "cyrillic-а.txt",
      "private.txt",
      "￼.txt",
    ]) {
      expect(nameText(name), name).toBe(name);
      expect(nameTitle(name), name).toBe(name);
    }
  });

  test("a joiner stays only between two characters that are not ASCII", () => {
    const persian = "می\u200Cخواهم.pdf";
    expect(nameText(persian)).toBe(persian);
    const devanagari = "क्\u200Dष.txt";
    expect(nameText(devanagari)).toBe(devanagari);
    const family = "\u{1F468}\u200D\u{1F469}.png";
    expect(nameText(family)).toBe(family);
    const fire = "❤\uFE0F\u200D\u{1F525}.png";
    expect(nameText(fire)).toBe(fire);
    expect(nameText("ex\u200De")).toBe(`ex${MARK}e`);
    expect(nameText("م\u200C.pdf")).toBe(`م${MARK}.pdf`);
    expect(nameText(".\u200Cم")).toBe(`.${MARK}م`);
    expect(nameText("م\u200C")).toBe(`م${MARK}`);
    expect(nameText("\u200Dم")).toBe(`${MARK}م`);
    expect(nameText("م\u200C\u200Cم")).toBe(`م${MARK}${MARK}م`);
    expect(nameText("م\u200C/م")).toBe(`م${MARK}/م`);
    expect(nameText("م\u200C\u202E")).toBe(`م${MARK}${MARK}`);
  });

  test("a variation selector stays only after a character that is not ASCII", () => {
    const heart = "❤\uFE0F.png";
    expect(nameText(heart)).toBe(heart);
    const glyph = "葛\u{E0100}.txt";
    expect(nameText(glyph)).toBe(glyph);
    const mongolian = "ᠠ\u180B.txt";
    expect(nameText(mongolian)).toBe(mongolian);
    expect(nameText("ex\uFE0Fe")).toBe(`ex${MARK}e`);
    expect(nameText("\uFE0F")).toBe(MARK);
    expect(nameText("\u202E\uFE0F")).toBe(`${MARK}${MARK}`);
    expect(nameText(".e\u{E0100}")).toBe(`.e${MARK}`);
  });

  test("the fast scan finds each marked code point", () => {
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      if (alwaysMarked(code) || isJoiner(code) || isVariation(code)) {
        if (isPlainName(`a${String.fromCodePoint(code)}b`)) {
          throw new Error(`U+${code.toString(16)} is missed`);
        }
      }
    }
  });

  test("a surrogate with no pair does not throw", () => {
    expect(nameText("a\ud800b")).toBe("a\ud800b");
    expect(nameText("\u202E\udc00")).toBe(`${MARK}\udc00`);
  });
});

describe("direction", () => {
  test("a name with no right-to-left text stays the same string", () => {
    expect(directed("plain/name.tar.gz")).toBe("plain/name.tar.gz");
    expect(nameLabel("plain/name.tar.gz")).toBe("plain/name.tar.gz");
  });

  test("the extension stays outside the isolate", () => {
    expect(nameLabel("تقرير المبيعات.pdf")).toBe(`${LRI}تقرير المبيعات${PDI}.pdf`);
    expect(nameLabel("דוח שנתי.pdf")).toBe(`${LRI}דוח שנתי${PDI}.pdf`);
    expect(nameLabel("تقرير.7z")).toBe(`${LRI}تقرير${PDI}.7z`);
    expect(nameLabel("تقرير.001")).toBe(`${LRI}تقرير${PDI}.001`);
    expect(nameLabel("נתונים 2024.tar.gz")).toBe(`${LRI}נתונים 2024${PDI}.tar.gz`);
    expect(nameLabel("م.pdf.م.exe")).toBe(`${LRI}م.pdf.م${PDI}.exe`);
    expect(nameLabel("report-م.pdf")).toBe(`report-${LRI}م${PDI}.pdf`);
    expect(nameLabel("تقرير (1).pdf")).toBe(`${LRI}تقرير${PDI} (1).pdf`);
    expect(nameLabel("\u{10900}\u{10901}.txt")).toBe(`${LRI}\u{10900}\u{10901}${PDI}.txt`);
  });

  test("each path segment has its own isolate", () => {
    expect(nameLabel("مجلد/تقرير.pdf")).toBe(`${LRI}مجلد${PDI}/${LRI}تقرير${PDI}.pdf`);
    expect(nameLabel("a/מסמכים/")).toBe(`a/${LRI}מסמכים${PDI}/`);
  });

  test("a pair of brackets or quotes stays whole", () => {
    for (const [name, inside, after] of [
      ["דוח (סופי).docx", "דוח (סופי)", ".docx"],
      ["تقرير (نهائي).pdf", "تقرير (نهائي)", ".pdf"],
      ["تقرير (نهائي) 2024.xlsx", "تقرير (نهائي) 2024", ".xlsx"],
      ["דוח [סופי].pdf", "דוח [סופי]", ".pdf"],
      ["דוח {סופי}.pdf", "דוח {סופי}", ".pdf"],
      ['דוח "שנתי".pdf', 'דוח "שנתי"', ".pdf"],
      ["تقرير «نهائي».pdf", "تقرير «نهائي»", ".pdf"],
      ["דוח (א (ב)).pdf", "דוח (א (ב))", ".pdf"],
    ] as const) {
      expect(nameLabel(name), name).toBe(`${LRI}${inside}${PDI}${after}`);
    }
    // In the other direction.
    expect(nameLabel("(مسودة) تقرير.pdf")).toBe(`${LRI}(مسودة) تقرير${PDI}.pdf`);
    expect(nameLabel('"مسودة" تقرير.pdf')).toBe(`${LRI}"مسودة" تقرير${PDI}.pdf`);
    expect(nameLabel("x (a (מ) ב.pdf")).toBe(`x (a ${LRI}(מ) ב${PDI}.pdf`);
    // Each segment has its own pairs.
    expect(nameLabel("مجلد (قديم)/ملف (جديد).pdf")).toBe(
      `${LRI}مجلد (قديم)${PDI}/${LRI}ملف (جديد)${PDI}.pdf`,
    );
  });

  test("a pair that is already whole stays as it was", () => {
    expect(nameLabel("تقرير (1).pdf")).toBe(`${LRI}تقرير${PDI} (1).pdf`);
    expect(nameLabel("(נוסח סופי).pdf")).toBe(`(${LRI}נוסח סופי${PDI}).pdf`);
    expect(nameLabel("דוח (2024) סופי.docx")).toBe(`${LRI}דוח (2024) סופי${PDI}.docx`);
    expect(nameLabel("Report (نهائي).pdf")).toBe(`Report (${LRI}نهائي${PDI}).pdf`);
    expect(nameLabel('דו"ח.pdf')).toBe(`${LRI}דו"ח${PDI}.pdf`);
  });

  test("a number at the end goes into the isolate, and the dot stays out", () => {
    expect(nameLabel("ملف 1 من 3.docx")).toBe(`${LRI}ملف 1 من 3${PDI}.docx`);
    expect(nameLabel("דוח 2024.pdf")).toBe(`${LRI}דוח 2024${PDI}.pdf`);
    expect(nameLabel("דוח 2024")).toBe(`${LRI}דוח 2024${PDI}`);
    expect(nameLabel("דוח 2024/x")).toBe(`${LRI}דוח 2024${PDI}/x`);
    expect(nameLabel("م 1.exe")).toBe(`${LRI}م 1${PDI}.exe`);
    expect(nameLabel("تقرير (نهائي) 2024.xlsx")).toBe(`${LRI}تقرير (نهائي) 2024${PDI}.xlsx`);
    // A number with a dot stays whole, and the isolate does not take it: a date,
    // a version, a time.
    for (const [word, rest] of [
      ["م", " 1.2.exe"],
      ["ملف", " 3.7z"],
      ["גרסה", " 1.5.docx"],
      ["דוח", " 1.2.2024.pdf"],
      ["تقرير", " 15.03.2024.pdf"],
      ["دليل", " 2.0.pdf"],
      ["תמונה", " 12.30.jpg"],
    ] as const) {
      expect(nameLabel(word + rest), word + rest).toBe(`${LRI}${word}${PDI}${rest}`);
    }
    // After a pair too.
    expect(nameLabel("تقرير (نهائي) 1.2.pdf")).toBe(`${LRI}تقرير (نهائي)${PDI} 1.2.pdf`);
    // The rule of `.7z` and `.001` stays.
    expect(nameLabel("تقرير.7z")).toBe(`${LRI}تقرير${PDI}.7z`);
    expect(nameLabel("تقرير.001")).toBe(`${LRI}تقرير${PDI}.001`);
    // A number that goes on as Latin text reads left to right. Spaces with no
    // number stay out.
    expect(nameLabel("נתונים 2024 abc.txt")).toBe(`${LRI}נתונים${PDI} 2024 abc.txt`);
    expect(nameLabel("م 1a.txt")).toBe(`${LRI}م${PDI} 1a.txt`);
    expect(nameLabel("م   .exe")).toBe(`${LRI}م${PDI}   .exe`);
    expect(nameLabel("م 1  .exe")).toBe(`${LRI}م 1${PDI}  .exe`);
  });

  test("a bracket never takes the true end of a name into the isolate", () => {
    for (const [name, label] of [
      ["م(.exe", `${LRI}م${PDI}(.exe`],
      ["م).pdf.exe", `${LRI}م${PDI}).pdf.exe`],
      ["م(م.exe)", `${LRI}م(م${PDI}.exe)`],
      ["م(م.pdf).exe", `${LRI}م(م${PDI}.pdf).exe`],
      ["م(م).pdf.exe", `${LRI}م(م)${PDI}.pdf.exe`],
      ['م"م.exe"', `${LRI}م"م${PDI}.exe"`],
      ['م"م.pdf".exe', `${LRI}م"م${PDI}.pdf".exe`],
      // To the left, the search stops at a dot too.
      ["(a.pdf م) م.exe", `(a.pdf ${LRI}م) م${PDI}.exe`],
      // The search stops at a slash in both directions.
      ["م(م/).exe", `${LRI}م(م${PDI}/).exe`],
      ["(/م)م.exe", `(/${LRI}م)م${PDI}.exe`],
      // A bracket of another kind is not the pair.
      ["م(م].exe", `${LRI}م(م${PDI}].exe`],
      // Pairs outside the part stay outside.
      ["(م).exe", `(${LRI}م${PDI}).exe`],
      ["م().exe", `${LRI}م${PDI}().exe`],
    ] as const) {
      expect(nameLabel(name), name).toBe(label);
    }
  });

  test("a mark inside a right-to-left name stays inside the isolate", () => {
    expect(nameLabel("تق\u202Eرير.pdf")).toBe(`${LRI}تق${MARK}رير${PDI}.pdf`);
  });
});

describe("the Mac icon file", () => {
  test("it keeps its mark and does not count", () => {
    for (const name of [
      "Icon\r",
      "._Icon\r",
      "Pictures/Icon\r",
      "__MACOSX/a/._Icon\r",
      "a\\Icon\r",
    ]) {
      expect(nameText(name), name).toContain(MARK);
      expect(countsInFinding(name), name).toBe(false);
    }
    expect(nameTitle("a/Icon\r")).toBe("a/Icon[U+000D]");
  });

  test("all names near it count", () => {
    for (const name of [
      "xIcon\r",
      "a/xIcon\r",
      "a/x._Icon\r",
      "Icon\r\r",
      "Icon\n",
      "icon\r",
      "Icon\r/",
      "Icon\r.txt",
      "a\u202E/Icon\r",
      "a\nb/._Icon\r",
    ]) {
      expect(countsInFinding(name), name).toBe(true);
    }
    expect(countsInFinding("plain/name.txt")).toBe(false);
    expect(countsInFinding("\u0645.pdf")).toBe(false);
  });
});

describe("comments", () => {
  test("line breaks and tabs stay, and the other characters show", () => {
    expect(commentText("one\ntwo\r\nthree\rfour\tend")).toBe("one\ntwo\nthree\nfour\tend");
    expect(commentText("a\u202Eb\x07c\u2028d\n")).toBe(`a${MARK}b${MARK}c${MARK}d\n`);
  });

  test("plain text and right-to-left prose stay the same", () => {
    expect(commentText("Line one\nLine two")).toBe("Line one\nLine two");
    const arabic = "تعليق عربي\nسطر ثان";
    expect(commentText(arabic)).toBe(arabic);
  });
});

describe("cost", () => {
  // Linear work: the time for a hostile name of 60,000 characters is near
  // ten times the time for 6,000. Counted by the characters that the walk
  // reads, not by a clock.
  test("a hostile name keeps its length, so the work is linear", () => {
    const hostile = "\u202E".repeat(60_000);
    expect(nameText(hostile)).toBe(MARK.repeat(60_000));
    // The title of a hostile name stops near the room of a tooltip.
    expect(nameTitle("\u202E".repeat(21_845)).length).toBeLessThan(4_200);
    expect(nameTitle("a\u202E".repeat(100))).toBe("a[U+202E]".repeat(100));
    const joiners = "م\u200C".repeat(30_000);
    expect(nameText(joiners)).toHaveLength(60_000);
    const rightToLeft = `م${"x".repeat(60_000)}`;
    expect(directed(rightToLeft)).toBe(`${LRI}م${PDI}${"x".repeat(60_000)}`);
    // Many brackets with no pair: each search reads each character one time.
    const opens = "(".repeat(30_000);
    const closes = "]".repeat(30_000);
    expect(directed(`م${opens}م${closes}.exe`)).toBe(`${LRI}م${opens}م${PDI}${closes}.exe`);
    expect(directed(`${opens}م${closes}م.exe`)).toBe(`${opens}${LRI}م${closes}م${PDI}.exe`);
    const pairs = "()".repeat(15_000);
    expect(directed(`م(${"م".repeat(30_000)}${pairs}).exe`)).toMatch(/\u2069\.exe$/);
  });
});
