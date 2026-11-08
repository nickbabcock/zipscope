//! Decodes names and comments to UTF-8. The arenas keep only UTF-8.

use std::borrow::Cow;

use zipscope_marks::marked;

use crate::contract::NameSource;

/// CP437 characters for the bytes 0x80 to 0xff. The bytes below 0x80 are
/// ASCII.
const CP437_HIGH: [char; 128] = [
    '\u{00C7}', '\u{00FC}', '\u{00E9}', '\u{00E2}', '\u{00E4}', '\u{00E0}', '\u{00E5}', '\u{00E7}',
    '\u{00EA}', '\u{00EB}', '\u{00E8}', '\u{00EF}', '\u{00EE}', '\u{00EC}', '\u{00C4}', '\u{00C5}',
    '\u{00C9}', '\u{00E6}', '\u{00C6}', '\u{00F4}', '\u{00F6}', '\u{00F2}', '\u{00FB}', '\u{00F9}',
    '\u{00FF}', '\u{00D6}', '\u{00DC}', '\u{00A2}', '\u{00A3}', '\u{00A5}', '\u{20A7}', '\u{0192}',
    '\u{00E1}', '\u{00ED}', '\u{00F3}', '\u{00FA}', '\u{00F1}', '\u{00D1}', '\u{00AA}', '\u{00BA}',
    '\u{00BF}', '\u{2310}', '\u{00AC}', '\u{00BD}', '\u{00BC}', '\u{00A1}', '\u{00AB}', '\u{00BB}',
    '\u{2591}', '\u{2592}', '\u{2593}', '\u{2502}', '\u{2524}', '\u{2561}', '\u{2562}', '\u{2556}',
    '\u{2555}', '\u{2563}', '\u{2551}', '\u{2557}', '\u{255D}', '\u{255C}', '\u{255B}', '\u{2510}',
    '\u{2514}', '\u{2534}', '\u{252C}', '\u{251C}', '\u{2500}', '\u{253C}', '\u{255E}', '\u{255F}',
    '\u{255A}', '\u{2554}', '\u{2569}', '\u{2566}', '\u{2560}', '\u{2550}', '\u{256C}', '\u{2567}',
    '\u{2568}', '\u{2564}', '\u{2565}', '\u{2559}', '\u{2558}', '\u{2552}', '\u{2553}', '\u{256B}',
    '\u{256A}', '\u{2518}', '\u{250C}', '\u{2588}', '\u{2584}', '\u{258C}', '\u{2590}', '\u{2580}',
    '\u{03B1}', '\u{00DF}', '\u{0393}', '\u{03C0}', '\u{03A3}', '\u{03C3}', '\u{00B5}', '\u{03C4}',
    '\u{03A6}', '\u{0398}', '\u{03A9}', '\u{03B4}', '\u{221E}', '\u{03C6}', '\u{03B5}', '\u{2229}',
    '\u{2261}', '\u{00B1}', '\u{2265}', '\u{2264}', '\u{2320}', '\u{2321}', '\u{00F7}', '\u{2248}',
    '\u{00B0}', '\u{2219}', '\u{00B7}', '\u{221A}', '\u{207F}', '\u{00B2}', '\u{25A0}', '\u{00A0}',
];

/// Decodes CP437 bytes. Each byte is one character, so this never fails.
#[must_use]
pub fn cp437(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&byte| match byte {
            0..0x80 => char::from(byte),
            _ => CP437_HIGH[usize::from(byte - 0x80)],
        })
        .collect()
}

/// Returns the UTF-8 text of an Info-ZIP Unicode Path (`0x7075`) or Unicode
/// Comment (`0x6375`) extra field.
///
/// The field must have version 1, a CRC-32
/// that matches `raw` (the text in the record), and text that is UTF-8 and
/// not empty. If not, it returns `None`, and the raw text applies.
#[must_use]
pub fn unicode_field<'a>(field: &'a [u8], raw: &[u8]) -> Option<&'a str> {
    let (&version, rest) = field.split_first()?;
    if version != 1 || rest.len() < 4 {
        return None;
    }
    let (crc, text) = rest.split_at(4);
    if u32::from_le_bytes([crc[0], crc[1], crc[2], crc[3]]) != rawzip::crc32(raw) {
        return None;
    }
    std::str::from_utf8(text)
        .ok()
        .filter(|text| !text.is_empty())
}

/// Decodes a name or a comment. The order is: the Unicode extra field, then
/// the raw bytes when the UTF-8 flag is set or when they are UTF-8, then
/// CP437.
#[must_use]
pub fn decode<'a>(
    raw: &'a [u8],
    utf8_flag: bool,
    unicode: Option<&'a [u8]>,
) -> (Cow<'a, str>, NameSource) {
    if let Some(text) = unicode.and_then(|field| unicode_field(field, raw)) {
        return (Cow::Borrowed(text), NameSource::UnicodePath);
    }
    match std::str::from_utf8(raw) {
        Ok(text) if utf8_flag => (Cow::Borrowed(text), NameSource::Utf8Flag),
        Ok(text) => (Cow::Borrowed(text), NameSource::Utf8),
        Err(_) if utf8_flag => (String::from_utf8_lossy(raw), NameSource::Lossy),
        Err(_) => (Cow::Owned(cp437(raw)), NameSource::Cp437),
    }
}

/// Returns true when the `CONTROL_NAME` finding counts a decoded name.
///
/// The name has a character that shows as a mark, not counting a base name
/// of exactly `Icon<CR>` or `._Icon<CR>`. A Mac folder with a custom icon has
/// this file, so it shows its mark and gives no warning. `web/src/label.ts`
/// has the same rule.
#[must_use]
pub fn counts_as_control(name: &str) -> bool {
    let folder = name
        .strip_suffix("Icon\r")
        .map(|rest| rest.strip_suffix("._").unwrap_or(rest))
        .filter(|rest| rest.is_empty() || rest.ends_with(['/', '\\']));
    has_control(folder.unwrap_or(name))
}

/// True when a character with this first UTF-8 byte can show as a mark. All
/// other characters that are not ASCII need no more work.
const fn lead_can_mark(byte: u8) -> bool {
    matches!(
        byte,
        0xc2 | 0xcd | 0xd8 | 0xe1 | 0xe2 | 0xe3 | 0xef | 0xf0 | 0xf3
    )
}

/// Returns true when a decoded name has a character that shows as a mark.
/// This is the check of the `CONTROL_NAME` finding.
///
/// It reads each byte one time and allocates nothing. A name with only
/// printable ASCII costs a compare of 16 bytes at a time.
#[must_use]
pub fn has_control(name: &str) -> bool {
    let bytes = name.as_bytes();
    let printable = bytes.chunks(16).all(|chunk| {
        chunk
            .iter()
            .fold(true, |all, byte| all & (0x20..0x7f).contains(byte))
    });
    if printable {
        return false;
    }
    // True when the last character is not ASCII. The scan ends at the
    // first mark, so that character did not show as a mark.
    let mut attached = false;
    let mut at = 0;
    while let Some(&byte) = bytes.get(at) {
        if byte < 0x80 {
            if byte < 0x20 || byte == 0x7f {
                return true;
            }
            attached = false;
            at += 1;
            continue;
        }
        if !lead_can_mark(byte) {
            attached = true;
            at += match byte {
                0x80..=0xdf => 2,
                0xe0..=0xef => 3,
                _ => 4,
            };
            continue;
        }
        // The step above follows the first byte, so `at` is at a character.
        let mut chars = name.get(at..).unwrap_or_default().chars();
        let Some(c) = chars.next() else {
            return false;
        };
        let next = chars.next().map_or(0, u32::from);
        if marked(u32::from(c), attached, next) {
            return true;
        }
        attached = true;
        at += c.len_utf8();
    }
    false
}

#[cfg(test)]
mod tests {
    use zipscope_marks::{always_marked, is_joiner, is_variation};

    use super::*;

    fn field(version: u8, crc: u32, text: &[u8]) -> Vec<u8> {
        let mut field = vec![version];
        field.extend_from_slice(&crc.to_le_bytes());
        field.extend_from_slice(text);
        field
    }

    #[test]
    fn cp437_matches_the_code_page() {
        assert_eq!(cp437(b"abc/~\\"), "abc/~\\");
        assert_eq!(cp437(b"\x80\x81\x9b\xe1\xff"), "Çü¢ß\u{a0}");
        assert_eq!(cp437(b"\xb3\xc4\xdb"), "│─█");
        let all: Vec<u8> = (0x80..=0xff).collect();
        let decoded = cp437(&all);
        assert_eq!(decoded.chars().count(), 128);
        assert!(decoded.chars().all(|c| !c.is_ascii()));
    }

    #[test]
    fn prefers_a_unicode_field_with_a_matching_crc() {
        let raw = b"caf\x82.txt";
        let good = field(1, rawzip::crc32(raw), "café.txt".as_bytes());
        assert_eq!(
            decode(raw, false, Some(&good)),
            (Cow::Borrowed("café.txt"), NameSource::UnicodePath)
        );
    }

    #[test]
    fn ignores_a_unicode_field_that_is_not_valid() {
        let raw = b"caf\x82.txt";
        let crc = rawzip::crc32(raw);
        let cases = [
            field(1, crc ^ 1, b"other.txt"),
            field(2, crc, b"other.txt"),
            field(1, crc, b"bad\xff"),
            field(1, crc, b""),
            vec![1, 0, 0],
            vec![],
        ];
        for case in cases {
            assert_eq!(
                decode(raw, false, Some(&case)),
                (Cow::Owned::<str>("caf\u{e9}.txt".into()), NameSource::Cp437),
                "{case:?}"
            );
        }
    }

    #[test]
    fn uses_utf8_with_and_without_the_flag() {
        let raw = "naïve/日本.txt".as_bytes();
        assert_eq!(decode(raw, true, None).1, NameSource::Utf8Flag);
        assert_eq!(decode(raw, false, None).1, NameSource::Utf8);
        assert_eq!(decode(raw, false, None).0, "naïve/日本.txt");
        assert_eq!(decode(b"plain.txt", false, None).1, NameSource::Utf8);
    }

    #[test]
    fn replaces_bad_utf8_when_the_flag_is_set() {
        assert_eq!(
            decode(b"caf\xe9.txt", true, None),
            (
                Cow::Owned::<str>("caf\u{fffd}.txt".into()),
                NameSource::Lossy
            )
        );
    }

    #[test]
    fn falls_back_to_cp437() {
        assert_eq!(
            decode(b"caf\xe9.txt", false, None),
            (Cow::Owned::<str>("cafΘ.txt".into()), NameSource::Cp437)
        );
    }

    #[test]
    fn has_control_finds_the_classes_and_leaves_real_names() {
        for name in [
            "invoice\u{202e}fdp.exe",
            "a\u{2066}b\u{2069}.txt",
            "line\nbreak.txt",
            "del\u{7f}.txt",
            "c1\u{85}.txt",
            "setup.p\u{200b}df",
            "soft\u{ad}hyphen.txt",
            "\u{feff}bom.txt",
            "pad\u{3164}.exe",
            "tag\u{e0041}.txt",
            "\u{1d173}music",
            // A joiner next to ASCII, at an end or beside another joiner.
            "ex\u{200d}e",
            "\u{645}\u{200c}.pdf",
            ".\u{200c}\u{645}",
            "\u{645}\u{200c}",
            "\u{200d}\u{645}",
            "\u{645}\u{200c}\u{200c}\u{645}",
            "\u{645}\u{200c}\u{202e}",
            // A variation selector with no base that is not ASCII.
            "\u{fe0f}",
            "ex\u{fe0f}e",
            "\u{e0100}.txt",
        ] {
            assert!(has_control(name), "{name:?}");
        }
        for name in [
            "",
            "plain/name-1.txt",
            "تقرير المبيعات.pdf",
            "דוח שנתי.pdf",
            "日本語/ファイル.txt",
            "caf\u{e9}\u{fffd}.txt",
            "\u{a0}no break",
            "fullwidth\u{ff0e}txt",
            // Persian, Devanagari and emoji use these characters.
            "\u{645}\u{6cc}\u{200c}\u{62e}.pdf",
            "\u{915}\u{94d}\u{200d}\u{937}.txt",
            "\u{2764}\u{fe0f}.png",
            "\u{2764}\u{fe0f}\u{200d}\u{1f525}.png",
            "\u{1f468}\u{200d}\u{1f469}.png",
            "\u{845b}\u{e0100}.txt",
        ] {
            assert!(!has_control(name), "{name:?}");
        }
    }

    #[test]
    fn a_mac_icon_file_does_not_count_and_all_other_names_do() {
        for name in [
            "Icon\r",
            "._Icon\r",
            "Pictures/Icon\r",
            "__MACOSX/Pictures/._Icon\r",
            "a\\Icon\r",
        ] {
            assert!(has_control(name), "{name:?}");
            assert!(!counts_as_control(name), "{name:?}");
        }
        for name in [
            "xIcon\r",
            "a/xIcon\r",
            "a/x._Icon\r",
            "Icon\r\r",
            "Icon\n",
            "icon\r",
            "Icon\r/",
            "Icon\r.txt",
            // Another character in the folders still counts.
            "a\u{202e}/Icon\r",
            "a\nb/._Icon\r",
        ] {
            assert!(counts_as_control(name), "{name:?}");
        }
        assert!(!counts_as_control("plain/name.txt"));
    }

    #[test]
    fn the_lead_bytes_cover_each_character_that_can_show_as_a_mark() {
        for code in 0x80..=0x10_ffff {
            let Some(c) = char::from_u32(code) else {
                continue;
            };
            if always_marked(code) || is_joiner(code) || is_variation(code) {
                let mut buffer = [0; 4];
                c.encode_utf8(&mut buffer);
                assert!(lead_can_mark(buffer[0]), "U+{code:04X}");
            }
        }
    }

    #[test]
    fn has_control_reads_a_long_name_in_each_chunk() {
        for at in [0, 15, 16, 17, 60_000, 64_999] {
            let mut name = vec![b'a'; 65_000];
            name[at] = b'\n';
            assert!(has_control(std::str::from_utf8(&name).unwrap()), "{at}");
        }
        assert!(!has_control(&"a".repeat(65_000)));
    }
}
