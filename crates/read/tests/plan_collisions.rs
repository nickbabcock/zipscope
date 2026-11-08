//! No two rows of a plan get the same output path. The names collide only
//! after the cut to 255 bytes, NFC, case folding, the reserved-name
//! renames, the replaced characters and the suffixes. The test checks the
//! final paths as a case-insensitive, normalization-insensitive file system
//! sees them.

use std::collections::HashSet;

use unicode_normalization::UnicodeNormalization;
use zipscope_core::text::has_control;
use zipscope_read::sanitize::{Added, MAX_SEGMENT_BYTES, Planner, renamed};

/// The NFD for the planner.
fn nfd(text: &str) -> String {
    text.nfd().collect()
}

/// The path as a file system that ignores case and normalization sees it.
/// This oracle does not use the fold of the planner: as APFS, it works on
/// NFD, and it applies the upper case and then the lower case of std
/// until nothing changes, which puts `µ` with `μ`, `ς` with `σ`, `ſ` with
/// `s` and `ẞ` with `ss`. It maps the dotless `ı` to `i`, as NTFS.
fn folded(path: &str) -> String {
    let mut text: String = path.nfd().collect::<String>().replace('\u{131}', "i");
    loop {
        let next: String = text.to_uppercase().to_lowercase().nfd().collect();
        if next == text {
            return text;
        }
        text = next;
    }
}

/// Plans `names` and checks that the output paths are all different, that
/// no file path is also a folder path, that each segment fits, and that no
/// output path has a character that shows as a mark on the screen (an
/// invisible character, a control, or a joiner that does not attach).
fn check(names: &[String]) {
    let mut planner = Planner::new("", nfd).unwrap();
    let mut added = 0;
    for (row, name) in names.iter().enumerate() {
        let nfc: String = name.nfc().collect();
        let result = planner
            .add(u32::try_from(row).unwrap(), name, &nfc, 0, 8, 0)
            .unwrap();
        if result == Added::File {
            added += 1;
        }
    }
    // Each file row has its own output file: none replaces another.
    assert_eq!(planner.files().len(), added);
    let mut seen = HashSet::new();
    for file in planner.files() {
        let path = planner.folder_path(file.folder) + &file.name;
        for segment in path.split('/') {
            assert!(segment.len() <= MAX_SEGMENT_BYTES, "{segment:?}");
        }
        assert!(!has_control(&path), "{path:?} has a mark");
        assert!(seen.insert(folded(&path)), "two rows write {path:?}");
    }
    for index in 1..planner.folders().len() {
        let path = planner.folder_path(u32::try_from(index).unwrap());
        let path = path.trim_end_matches('/');
        assert!(
            !seen.contains(&folded(path)),
            "{path:?} is a file and a folder"
        );
    }
}

const ENDS: &[&str] = &[
    "\u{B5}", "\u{3BC}", "\u{3C2}", "\u{3C3}", "\u{17F}", "s", "\u{3D0}", "\u{3B2}", "\u{DF}",
    "ss", "\u{1E9E}", "\u{131}", "i", "\u{130}", "\u{212A}", "k", "\u{E9}", "e\u{301}", "\u{E8}",
    "e\u{300}", "\u{C9}", "E\u{301}", "CON", "con", ".", " ", ":", "*", "\u{FF0F}", "", "a", "A",
];
const EXTENSIONS: &[&str] = &["", ".txt", ".TXT", " (2).txt", ".t\u{E9}"];
const FOLDERS: &[&str] = &["", "d/", "D/", "d\u{E9}/", "de\u{301}/", "con/"];

#[test]
fn names_that_collide_after_the_cut_and_normalization_get_different_paths() {
    let mut names = Vec::new();
    for length in [0, 1, 248, 250, 251, 252, 253, 254, 255, 256, 260] {
        for end in ENDS {
            for extension in EXTENSIONS {
                for folder in FOLDERS {
                    names.push(format!("{folder}{}{end}{extension}", "a".repeat(length)));
                }
            }
        }
    }
    // Each name two times, so that the duplicates get suffixes too.
    let twice: Vec<String> = names.iter().chain(names.iter()).cloned().collect();
    check(&twice);
}

#[test]
fn random_names_never_share_an_output_path() {
    // A fixed xorshift generator, so a failure repeats.
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let pieces: &[&str] = &[
        "a",
        "A",
        "\u{E9}",
        "e",
        "\u{301}",
        "\u{300}",
        ".",
        " ",
        "/",
        "\\",
        "CON",
        "nul",
        ":",
        "\u{FF0E}",
        "(2)",
        "-",
        "\u{202E}",
        "\u{1F600}",
        "_",
        "\u{645}",
        "\u{200B}",
        "\u{FEFF}",
        "\u{200C}",
        "\u{200D}",
        "\u{FE0F}",
    ];
    for _ in 0..40 {
        let names: Vec<String> = (0..400)
            .map(|_| {
                let pad = "a".repeat(usize::try_from(next() % 260).unwrap());
                let mut name = pad;
                for _ in 0..(next() % 6) {
                    let index = usize::try_from(next() % pieces.len() as u64).unwrap();
                    name.push_str(pieces[index]);
                }
                if next() % 2 == 0 {
                    name.insert_str(
                        0,
                        ["x/", "X/", "con/"][usize::try_from(next() % 3).unwrap()],
                    );
                }
                name
            })
            .collect();
        check(&names);
    }
}

#[test]
fn accents_at_the_cut_keep_both_names() {
    let first = format!("{}e\u{301}", "a".repeat(253));
    let second = format!("{}e\u{300}", "a".repeat(253));
    check(&[first.clone(), second.clone()]);
    let longer = |end: &str| format!("{}{end}", "a".repeat(254));
    check(&[longer("e\u{301}"), longer("e\u{300}")]);
}

/// Pairs that a case-insensitive file system treats as one name. The
/// table is fixed, so it does not depend on the fold of the planner.
const SAME: &[(&str, &str)] = &[
    ("\u{B5}", "\u{3BC}"),  // micro sign, small mu
    ("\u{3C2}", "\u{3C3}"), // final sigma, sigma
    ("\u{3A3}", "\u{3C2}"), // capital sigma, final sigma
    ("\u{17F}", "s"),       // long s
    ("\u{3D0}", "\u{3B2}"), // beta symbol, beta
    ("\u{DF}", "ss"),       // sharp s
    ("\u{1E9E}", "ss"),     // capital sharp s
    ("\u{1E9E}", "\u{DF}"),
    ("\u{131}", "i"),        // Turkish dotless i (NTFS upper case)
    ("\u{130}", "i\u{307}"), // Turkish dotted capital I, i with dot above
    // The folds of these pairs differ only in composition.
    ("\u{390}", "\u{3AA}\u{301}"),
    ("\u{3B0}", "\u{3AB}\u{301}"),
    ("\u{1FD2}", "\u{3AA}\u{300}"),
    ("I", "i"),
    ("\u{212A}", "k"),      // Kelvin sign
    ("\u{212B}", "\u{E5}"), // Angstrom sign
    ("\u{1C5}", "\u{1C6}"), // title case dz with caron
    ("\u{FB03}", "ffi"),    // ligature ffi
    ("\u{C4}", "a\u{308}"), // NFC and NFD
];

/// Pairs that stay two names.
const DIFFERENT: &[(&str, &str)] = &[
    ("a", "b"),
    ("\u{E9}", "e"),
    ("ss", "s"),
    ("\u{3C3}", "o"),
    // NTFS and APFS keep the dotted capital I apart from a plain i.
    ("\u{130}", "i"),
];

fn renamed_second(first: &str, second: &str) -> bool {
    let names = [format!("p/{first}.txt"), format!("p/{second}.txt")];
    second_renamed(&names, false)
}

/// Plans `names`; true when the second file, or the second folder, has a
/// collision suffix.
fn second_renamed(names: &[String], folder: bool) -> bool {
    let mut planner = Planner::new("", nfd).unwrap();
    for (row, name) in names.iter().enumerate() {
        let nfc: String = name.nfc().collect();
        planner
            .add(u32::try_from(row).unwrap(), name, &nfc, 0, 8, 0)
            .unwrap();
    }
    if folder {
        planner.folders()[2].renamed & renamed::COLLISION != 0
    } else {
        planner.files()[1].renamed & renamed::COLLISION != 0
    }
}

#[test]
fn folders_that_a_case_insensitive_file_system_joins_get_a_suffix() {
    for (first, second) in SAME {
        let names = [format!("{first}/a.txt"), format!("{second}/b.txt")];
        assert!(second_renamed(&names, true), "{first:?}/ and {second:?}/");
    }
}

#[test]
fn names_that_a_case_insensitive_file_system_joins_get_a_suffix() {
    for (first, second) in SAME {
        assert!(renamed_second(first, second), "{first:?} and {second:?}");
        assert!(renamed_second(second, first), "{second:?} and {first:?}");
    }
    for (first, second) in DIFFERENT {
        assert!(!renamed_second(first, second), "{first:?} and {second:?}");
    }
}
