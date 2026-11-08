//! The characters of a name that show as a mark.
//!
//! A name comes from the archive, so an attacker can choose it. The functions
//! of this crate give the classes. The core module uses this rule for the Control name
//! finding, and the read module uses it to rename characters in the names
//! of an extraction. `web/src/label.ts` has the same rule for the screen.

/// True for a code point that shows as a mark in each context.
///
/// These are the controls, the bidirectional controls and the invisible
/// format characters.
#[must_use]
pub const fn always_marked(code: u32) -> bool {
    matches!(
        code,
        0..=0x1f
            | 0x7f..=0x9f
            | 0xad
            | 0x34f
            | 0x61c
            | 0x115f..=0x1160
            | 0x17b4..=0x17b5
            | 0x180e
            | 0x200b
            | 0x200e..=0x200f
            | 0x2028..=0x202e
            | 0x2060..=0x206f
            | 0x3164
            | 0xfeff
            | 0xffa0
            | 0xfff0..=0xfffb
            | 0x1bca0..=0x1bca3
            | 0x1d173..=0x1d17a
            | 0xe0000..=0xe00ff
            | 0xe01f0..=0xe0fff
    )
}

/// True for a joiner. It stays only between two characters that are not
/// ASCII (Persian, Indic scripts, emoji).
#[must_use]
pub const fn is_joiner(code: u32) -> bool {
    matches!(code, 0x200c..=0x200d)
}

/// True for a variation selector. It stays only after a character that is
/// not ASCII (emoji, CJK, Mongolian).
#[must_use]
pub const fn is_variation(code: u32) -> bool {
    matches!(
        code,
        0x180b..=0x180d | 0x180f | 0xfe00..=0xfe0f | 0xe0100..=0xe01ef
    )
}

/// True when the code point `code` shows as a mark in its context.
///
/// `attached` is true when the character before it is not ASCII and does
/// not show as a mark. `next` is the code point after it, or 0 at the end.
/// A joiner stays between two characters that are not ASCII and that are
/// not marked, joiners or variation selectors. A variation selector stays
/// when `attached` is true. Thus `.ex<U+200D>e` does not read as `.exe`.
#[must_use]
pub const fn marked(code: u32, attached: bool, next: u32) -> bool {
    if always_marked(code) {
        return true;
    }
    if is_variation(code) {
        return !attached;
    }
    if is_joiner(code) {
        let next_stays =
            next >= 0x80 && !always_marked(next) && !is_joiner(next) && !is_variation(next);
        return !attached || !next_stays;
    }
    false
}
