//! Safe output paths for extraction.
//!
//! Every name in an archive is attacker-controlled. Before Zipscope
//! writes an entry to a folder or to a new zip, it makes the name safe:
//!
//! - It skips a name with a `..` segment, an absolute path, a drive
//!   letter or a NUL byte (zip-slip), and a symbolic link.
//! - It replaces characters that a file system does not accept, or that
//!   a Windows code page maps to a separator (the "best fit" mapping of
//!   a fullwidth solidus, for example).
//! - It replaces the characters that show as a mark on the screen: the
//!   controls, the bidirectional controls and the invisible characters,
//!   such as U+200B and U+FEFF (see `zipscope_marks`). Joiners and
//!   variation selectors stay where they attach to characters that are
//!   not ASCII, as real names need.
//! - It renames Windows reserved names (`CON`, `NUL`, `COM1`...) and names
//!   that end with a dot or a space.
//! - It renames a name that is the same as an earlier name in the same
//!   folder when case and Unicode normalization are ignored, so that
//!   no file replaces another file on a case-insensitive file system.
//!   The caller gives the NFC form of each name (JavaScript has
//!   `String.prototype.normalize`), so the read wasm needs no
//!   normalization tables. The output names come from the NFC form, and
//!   each collision key comes from the full case fold of the final output
//!   name (after the cleaning, the cut and the suffix), so two rows never
//!   get the same output path.
//!
//! [`Planner`] applies these rules to the rows of one folder and keeps
//! the result: the folders and the files to write, and the rows that it
//! skipped, each with a reason for the extraction report.
//!
//! The tables of the planner grow with fallible reservations, so a full
//! memory gives an error, not a trap. The small allocations of one row
//! come from the free heap that the read worker makes sure of before each
//! step (see `heap::probe`).

use std::collections::TryReserveError;
use std::collections::{HashMap, HashSet};
use std::hash::BuildHasher;

use foldhash::fast::FixedState;
use unicase::UniCase;

/// Why the planner skipped a row. The read worker adds the codes from
/// [`Skip::LocalHeader`] on, which it finds when it decodes the row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Skip {
    /// A segment is `..`, or looks like `..` or `.` (see [`lookalike`]).
    Traversal = 1,
    /// The name starts with `/` or `\`.
    Absolute = 2,
    /// The name starts with a drive letter, such as `C:`.
    DriveLetter = 3,
    /// The name has a NUL byte.
    Nul = 4,
    /// The entry is a symbolic link or another link.
    Link = 5,
    /// The path is longer than [`MAX_PATH_BYTES`].
    TooLong = 6,
    /// The path has more than [`MAX_DEPTH`] segments.
    TooDeep = 7,
    /// The name has no segment that can be a file name.
    NoName = 8,
    /// The entry is encrypted.
    Encrypted = 9,
    /// Zipscope cannot decode the compression method.
    Method = 10,
    /// The local header does not agree with the central directory.
    LocalHeader = 11,
    /// The data did not verify: wrong size, wrong CRC-32 or bad data.
    Verify = 12,
    /// The browser did not write the file.
    Write = 13,
    /// The memory limit left no room.
    Memory = 14,
    /// The user stopped the extraction before this row.
    Cancelled = 15,
}

/// Bits of a rename: why the output name is not the name in the archive.
pub mod renamed {
    /// A Windows reserved name, such as `CON` or `com1.txt`.
    pub const RESERVED: u8 = 1;
    /// Characters that a file system does not accept, or that do not
    /// show, were replaced.
    pub const CHARACTERS: u8 = 1 << 1;
    /// The name ended with a dot or a space.
    pub const TRAILING: u8 = 1 << 2;
    /// The name was longer than [`super::MAX_SEGMENT_BYTES`].
    pub const TRUNCATED: u8 = 1 << 3;
    /// An earlier name in the folder is the same when case and Unicode
    /// normalization are ignored (or is exactly the same).
    pub const COLLISION: u8 = 1 << 4;
}

/// The most UTF-8 bytes in one output segment. Most file systems accept
/// 255 bytes or 255 UTF-16 units; 255 bytes satisfies both.
pub const MAX_SEGMENT_BYTES: usize = 255;
/// The most UTF-8 bytes in one output path, below the output folder.
pub const MAX_PATH_BYTES: usize = 4096;
/// The most segments in one output path, below the output folder.
pub const MAX_DEPTH: usize = 128;
/// The longest extension that a truncation keeps.
const MAX_EXTENSION_BYTES: usize = 32;

/// Unix file types in the high 16 bits of the external attributes.
const UNIX_TYPE_MASK: u32 = 0o170_000;
const UNIX_SYMLINK: u32 = 0o120_000;
/// The DOS attribute of a reparse point (a Windows link).
const DOS_REPARSE_POINT: u32 = 0x400;

/// True when the external attributes mark a symbolic link (Unix mode) or
/// a reparse point (DOS attributes).
#[must_use]
pub fn is_link(external_attributes: u32) -> bool {
    (external_attributes >> 16) & UNIX_TYPE_MASK == UNIX_SYMLINK
        || external_attributes & DOS_REPARSE_POINT != 0
}

fn is_separator(c: char) -> bool {
    c == '/' || c == '\\'
}

/// The raw segments of a name, as the folder tree splits it: on `/` and
/// `\`, without empty segments.
pub fn raw_segments(name: &str) -> impl Iterator<Item = &str> {
    name.split(is_separator).filter(|part| !part.is_empty())
}

/// True when the name is a folder entry: it ends with a separator.
#[must_use]
pub fn is_folder_name(name: &str) -> bool {
    name.ends_with(is_separator)
}

/// The ASCII character of a lookalike, or `None`.
///
/// It is the character that the Unicode compatibility mapping (NFKC) or
/// the "best fit" mapping of a Windows code page gives, for the lookalikes
/// of separators, dots and the characters that Windows does not accept. Such a
/// mapping makes `..／` from `．．／`.
#[must_use]
pub fn lookalike(c: char) -> Option<char> {
    let code = u32::from(c);
    match code {
        // Fullwidth forms of ASCII 0x21..=0x7E.
        0xFF01..=0xFF5E => char::from_u32(code - 0xFEE0),
        // Small form variants.
        0xFE52 | 0x2024 => Some('.'),
        0xFE55 | 0x2236 | 0xA789 => Some(':'),
        0xFE56 => Some('?'),
        0xFE61 => Some('*'),
        0xFE64 => Some('<'),
        0xFE65 => Some('>'),
        0xFE68 | 0x29F5 | 0x29F9 => Some('\\'),
        // Slashes that a code page maps to `/`.
        0x2044 | 0x2215 | 0x29F8 => Some('/'),
        _ => None,
    }
}

/// True when a file system does not accept the printable character `c` in
/// a name (Windows is the strictest), or when `c` is a [`lookalike`] of
/// such a character or of a separator. The controls follow
/// [`zipscope_marks::marked`].
fn is_bad_char(c: char) -> bool {
    let bad = |c: char| is_separator(c) || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*');
    bad(c) || lookalike(c).is_some_and(bad)
}

/// Replaces with `_` each character that a file system does not accept
/// ([`is_bad_char`]) and each character that shows as a mark on the screen
/// ([`zipscope_marks::marked`]): the controls, the bidirectional controls,
/// the invisible characters such as U+200B and U+FEFF, and a joiner or a
/// variation selector that does not attach to a character that is not
/// ASCII. Thus `setup.p<U+200B>df` becomes `setup.p_df`. A replaced
/// character is ASCII for the context of the characters next to it.
/// Returns true when it replaced a character.
fn replace_characters(segment: &str, name: &mut String) -> bool {
    let mut replaced = false;
    // True when the last output character is not ASCII.
    let mut attached = false;
    let mut chars = segment.chars().peekable();
    while let Some(c) = chars.next() {
        let next = match chars.peek() {
            Some(&next) if !is_bad_char(next) => u32::from(next),
            _ => 0,
        };
        if is_bad_char(c) || zipscope_marks::marked(u32::from(c), attached, next) {
            name.push('_');
            replaced = true;
            attached = false;
        } else {
            name.push(c);
            attached = !c.is_ascii();
        }
    }
    replaced
}

/// True when a segment is `.` or `..` after the [`lookalike`] mapping
/// (with the one and two dot leaders, U+2024 and U+2025).
fn looks_like_dots(segment: &str) -> bool {
    let mut dots = 0;
    for c in segment.chars() {
        match c {
            '.' => dots += 1,
            '\u{2025}' => dots += 2,
            _ if lookalike(c) == Some('.') => dots += 1,
            _ => return false,
        }
        if dots > 2 {
            return false;
        }
    }
    dots > 0
}

/// Windows reserved device names. A name with an extension is also
/// reserved (`con.txt`).
fn is_reserved(segment: &str) -> bool {
    let base = segment
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ');
    let upper = base.to_ascii_uppercase();
    match upper.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" => true,
        _ => {
            let mut chars = upper.chars();
            let prefix: String = chars.by_ref().take(3).collect();
            let rest: String = chars.collect();
            (prefix == "COM" || prefix == "LPT")
                && matches!(
                    rest.as_str(),
                    "0" | "1"
                        | "2"
                        | "3"
                        | "4"
                        | "5"
                        | "6"
                        | "7"
                        | "8"
                        | "9"
                        | "\u{B9}"
                        | "\u{B2}"
                        | "\u{B3}"
                )
        }
    }
}

/// Splits a name into its base and its extension (with the dot). A name
/// that starts with its only dot has no extension.
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(at) if at > 0 && name.len() - at <= MAX_EXTENSION_BYTES => name.split_at(at),
        _ => (name, ""),
    }
}

/// The longest prefix of `text` with at most `bytes` bytes, at a character
/// boundary.
fn prefix_bytes(text: &str, bytes: usize) -> &str {
    if text.len() <= bytes {
        return text;
    }
    let mut end = bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Makes `base + suffix + extension` fit in [`MAX_SEGMENT_BYTES`] by
/// making the base shorter. A base that then ends with a dot or a space
/// gets `_`, so that the name does not change on Windows. A base that then
/// ends with a joiner also gets `_`, because the joiner is then before
/// ASCII (see [`replace_characters`]).
fn fit(base: &str, suffix: &str, extension: &str) -> String {
    let room = MAX_SEGMENT_BYTES.saturating_sub(suffix.len() + extension.len());
    let mut kept = prefix_bytes(base, room).to_string();
    if kept.len() < base.len() && kept.ends_with(['.', ' ', '\u{200C}', '\u{200D}']) {
        kept.pop();
        kept.push('_');
    }
    kept + suffix + extension
}

/// Cleans one segment that is not `.`, `..` or empty. Returns the safe
/// name and the `renamed` bits.
#[must_use]
pub fn clean_segment(segment: &str) -> (String, u8) {
    let mut bits = 0;
    let mut name = String::with_capacity(segment.len());
    if replace_characters(segment, &mut name) {
        bits |= renamed::CHARACTERS;
    }
    // Windows removes a trailing dot or space, so `a.` and `a` would be
    // the same file.
    if name.ends_with(['.', ' ']) {
        name.push('_');
        bits |= renamed::TRAILING;
    }
    if is_reserved(&name) {
        let (base, extension) = match name.find('.') {
            Some(at) => name.split_at(at),
            None => (name.as_str(), ""),
        };
        name = format!("{}_{extension}", base.trim_end_matches(' '));
        bits |= renamed::RESERVED;
    }
    if name.len() > MAX_SEGMENT_BYTES {
        let (base, extension) = split_extension(&name);
        name = fit(base, "", extension);
        bits |= renamed::TRUNCATED;
    }
    (name, bits)
}

/// The canonical decomposition (NFD) of a text. The read wasm uses
/// `String.prototype.normalize` of JavaScript, so it needs no
/// normalization tables; the native tests give a Rust NFD.
pub type Nfd = fn(&str) -> String;

/// The key of a final output name for collisions: NFD of the full Unicode
/// case fold (CaseFolding.txt, status C and F) of NFD of the name, with
/// the Turkish dotless `ı` as `i` (see [`dotless`]). This is the way that
/// APFS compares names, so canonically equivalent folds (`ΐ` and `Ϊ́`)
/// have one key. Two names with the same key are the same file on a file
/// system that ignores case (Windows, macOS) or Unicode normalization
/// (macOS). Two keys can be the same for different names (a hash); that
/// renames one more name, which is safe. Two equal names always have the
/// same key.
fn collision_key(nfd: Nfd, name: &str) -> u64 {
    let state = FixedState::with_seed(0x5a17_5c09_e12d_0001);
    let decomposed = nfd(&dotless(name));
    let folded = UniCase::unicode(decomposed.as_str()).to_folded_case();
    state.hash_one(nfd(&folded))
}

/// Maps the Turkish dotless small i (U+0131) to `i`. Case folding keeps
/// it apart from `i`, but the upper case table of NTFS makes `ı` the same
/// as `i`, so the key is wider than the fold. A wider key only renames
/// one more name, which is safe. The dotted capital I (U+0130) needs no
/// map: its fold is `i` and U+0307, as on APFS, and NTFS keeps it apart.
fn dotless(text: &str) -> std::borrow::Cow<'_, str> {
    if text.contains('\u{131}') {
        std::borrow::Cow::Owned(text.replace('\u{131}', "i"))
    } else {
        std::borrow::Cow::Borrowed(text)
    }
}

/// A name that is safe to write, as segments below the output folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanPath {
    /// Each segment, cleaned from the NFC form of the name, with its
    /// `renamed` bits.
    pub segments: Vec<(String, u8)>,
    /// True for a folder entry.
    pub folder: bool,
}

/// Checks a whole name for the rules that skip it.
///
/// `nfc` is the NFC form of the name. The checks apply to both forms; the
/// output segments come from the NFC form. `skip_segments` raw segments
/// at the start (the folder that the user extracts) are checked but not
/// kept. Returns the cleaned segments after them.
///
/// # Errors
///
/// Returns the reason when the name must not be written.
pub fn clean_path(name: &str, nfc: &str, skip_segments: usize) -> Result<CleanPath, Skip> {
    if name.contains('\0') {
        return Err(Skip::Nul);
    }
    if name.starts_with(is_separator) {
        return Err(Skip::Absolute);
    }
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(Skip::DriveLetter);
    }
    // NFC does not change separators, so both forms have the same
    // segments. A caller that gives another string falls back to the name.
    let nfc = if raw_segments(nfc).count() == raw_segments(name).count() {
        nfc
    } else {
        name
    };
    if nfc.contains('\0') {
        return Err(Skip::Nul);
    }
    let mut segments = Vec::new();
    let mut length = 0usize;
    for (index, (raw, folded)) in raw_segments(name).zip(raw_segments(nfc)).enumerate() {
        if raw == "." {
            continue;
        }
        for form in [raw, folded] {
            if form == ".." {
                return Err(Skip::Traversal);
            }
            // A drive letter in any segment (`a/C:x`): Windows reads `C:x` as an alternate
            // data stream or as a drive path.
            let segment = form.as_bytes();
            if segment.len() >= 2 && segment[0].is_ascii_alphabetic() && segment[1] == b':' {
                return Err(Skip::DriveLetter);
            }
            // A segment of lookalike dots, such as two fullwidth full
            // stops, is `..` after a "best fit" mapping.
            if looks_like_dots(form) {
                return Err(Skip::Traversal);
            }
        }
        if index < skip_segments || folded == "." {
            continue;
        }
        let (clean, bits) = clean_segment(folded);
        length += clean.len() + 1;
        segments.push((clean, bits));
        if segments.len() > MAX_DEPTH {
            return Err(Skip::TooDeep);
        }
        if length > MAX_PATH_BYTES + 1 {
            return Err(Skip::TooLong);
        }
    }
    Ok(CleanPath {
        segments,
        folder: is_folder_name(name),
    })
}

/// Returns a safe file name for one entry that the user saves on its own:
/// the last segment of its name, cleaned. `fallback` is the name when no
/// segment can be a file name.
#[must_use]
pub fn file_name(name: &str, fallback: &str) -> (String, u8) {
    let last = raw_segments(name)
        .filter(|part| *part != "." && *part != "..")
        .last()
        .map(|part| part.replace('\0', "_"));
    match last {
        Some(part) => clean_segment(&part),
        None => clean_segment(fallback),
    }
}

/// The root folder of a plan.
pub const ROOT: u32 = 0;
/// No row.
pub const NO_ROW: u32 = u32::MAX;

/// One output folder of a plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Folder {
    pub parent: u32,
    pub name: String,
    /// The `renamed` bits of the folder name.
    pub renamed: u8,
    /// The folder entry of the folder, or the first row below it.
    pub row: u32,
    /// The path of the folder in the archive (raw segments joined with
    /// `/`, with a `/` at the end) when the folder is renamed, else empty.
    pub source: String,
}

/// One output file of a plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct File {
    pub row: u32,
    pub folder: u32,
    pub name: String,
    /// The `renamed` bits of the file name. The renames of its folders are
    /// on the folders.
    pub renamed: u8,
}

/// What [`Planner::add`] did with a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Added {
    /// The row is not in the folder.
    Outside,
    /// The row is a file of the plan.
    File,
    /// The row is a folder entry. It makes a folder, or it is the folder
    /// that the user extracts.
    Folder,
    /// The row is in the folder, but it is skipped.
    Skipped(Skip),
}

/// The output folders and files of one folder of an archive.
#[derive(Debug)]
pub struct Planner {
    /// The raw segments of the folder that the user extracts.
    prefix: Vec<String>,
    folders: Vec<Folder>,
    /// The folder for each parent and exact clean name.
    by_name: HashMap<(u32, String), u32>,
    /// The collision keys that each folder uses.
    used: HashSet<(u32, u64)>,
    /// The next suffix to try for each folder and key, so that many
    /// collisions with one name do not try each suffix again.
    next_suffix: HashMap<(u32, u64), u32>,
    files: Vec<File>,
    skipped: Vec<(u32, Skip)>,
    /// The UTF-8 bytes of all output paths, for the size of a zip.
    path_bytes: u64,
    /// The NFD of the collision keys.
    nfd: Nfd,
}

/// Room for the small allocations of one row, with four times its names.
const ROW_PROBE_BYTES: usize = 64 * 1024;

/// A `TryReserveError` for a probe that failed. The standard library makes
/// one only from a refused reservation.
fn no_room() -> TryReserveError {
    Vec::<u8>::new()
        .try_reserve(usize::MAX)
        .expect_err("a reservation of usize::MAX bytes fails")
}

fn reserve<T>(vector: &mut Vec<T>) -> Result<(), TryReserveError> {
    vector.try_reserve(1)
}

fn owned(text: &str) -> Result<String, TryReserveError> {
    let mut copy = String::new();
    copy.try_reserve_exact(text.len())?;
    copy.push_str(text);
    Ok(copy)
}

impl Planner {
    /// Starts a plan for the folder at `folder` (its path, as the tree
    /// shows it). An empty path is the whole archive. `nfd` gives the
    /// canonical decomposition for the collision keys.
    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit leaves no room.
    pub fn new(folder: &str, nfd: Nfd) -> Result<Planner, TryReserveError> {
        let mut prefix = Vec::new();
        for segment in raw_segments(folder) {
            reserve(&mut prefix)?;
            prefix.push(owned(segment)?);
        }
        let mut folders = Vec::new();
        reserve(&mut folders)?;
        folders.push(Folder {
            parent: NO_ROW,
            name: String::new(),
            renamed: 0,
            row: NO_ROW,
            source: String::new(),
        });
        Ok(Planner {
            prefix,
            folders,
            by_name: HashMap::new(),
            used: HashSet::new(),
            next_suffix: HashMap::new(),
            files: Vec::new(),
            skipped: Vec::new(),
            path_bytes: 0,
            nfd,
        })
    }

    /// True when `name` is below the folder of the plan.
    fn inside(&self, name: &str) -> bool {
        if self.prefix.is_empty() {
            return true;
        }
        let mut segments = raw_segments(name);
        for expected in &self.prefix {
            if segments.next() != Some(expected.as_str()) {
                return false;
            }
        }
        // The folder entry of the folder itself is inside only as a folder.
        segments.next().is_some() || is_folder_name(name)
    }

    fn skip(&mut self, row: u32, reason: Skip) -> Result<Added, TryReserveError> {
        reserve(&mut self.skipped)?;
        self.skipped.push((row, reason));
        Ok(Added::Skipped(reason))
    }

    /// Returns a name in `folder` that no other name of the folder uses,
    /// and marks it as used. Returns true when it is not `name`. Each key
    /// comes from the final name that it marks.
    fn unique(&mut self, folder: u32, name: &str) -> Result<(String, bool), TryReserveError> {
        let key = collision_key(self.nfd, name);
        self.used.try_reserve(1)?;
        if self.used.insert((folder, key)) {
            return Ok((owned(name)?, false));
        }
        self.next_suffix.try_reserve(1)?;
        let mut number = self.next_suffix.get(&(folder, key)).copied().unwrap_or(2);
        let (base, extension) = split_extension(name);
        loop {
            let candidate = fit(base, &format!(" ({number})"), extension);
            number = number.saturating_add(1);
            if self
                .used
                .insert((folder, collision_key(self.nfd, &candidate)))
            {
                self.next_suffix.insert((folder, key), number);
                return Ok((candidate, true));
            }
        }
    }

    /// Returns the folder `name` in `parent`, and makes it when it is new.
    fn folder(
        &mut self,
        parent: u32,
        name: &str,
        bits: u8,
        row: u32,
        source: impl FnOnce() -> String,
    ) -> Result<u32, TryReserveError> {
        let key = (parent, owned(name)?);
        if let Some(&id) = self.by_name.get(&key) {
            return Ok(id);
        }
        let (unique, renamed_now) = self.unique(parent, name)?;
        let id = u32::try_from(self.folders.len()).unwrap_or(u32::MAX);
        reserve(&mut self.folders)?;
        self.by_name.try_reserve(1)?;
        self.path_bytes += unique.len() as u64 + 1;
        let renamed = bits | if renamed_now { renamed::COLLISION } else { 0 };
        self.folders.push(Folder {
            parent,
            name: unique,
            renamed,
            row,
            source: if renamed == 0 {
                String::new()
            } else {
                source()
            },
        });
        self.by_name.insert(key, id);
        Ok(id)
    }

    /// Adds one row. `name` is its name in the archive and `nfc` the NFC
    /// form of it; `attributes`, `method` and `flags` come from its
    /// central-directory record.
    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit leaves no room.
    pub fn add(
        &mut self,
        row: u32,
        name: &str,
        nfc: &str,
        attributes: u32,
        method: u16,
        flags: u16,
    ) -> Result<Added, TryReserveError> {
        // The small allocations of one row (the segments, the names, the
        // keys) come from this room, so a full memory gives an error, not
        // a trap. The tables reserve their growth on their own.
        crate::heap::probe(4 * (name.len() + nfc.len()) + ROW_PROBE_BYTES)
            .map_err(|_full| no_room())?;
        if !self.inside(name) {
            return Ok(Added::Outside);
        }
        let path = match clean_path(name, nfc, self.prefix.len()) {
            Ok(path) => path,
            Err(reason) => return self.skip(row, reason),
        };
        if is_link(attributes) {
            return self.skip(row, Skip::Link);
        }
        let Some((last, parents)) = path.segments.split_last() else {
            // The folder entry of the folder itself, or `a/./`.
            return if path.folder {
                Ok(Added::Folder)
            } else {
                self.skip(row, Skip::NoName)
            };
        };
        if !path.folder {
            if flags & 1 != 0 || method == 99 {
                return self.skip(row, Skip::Encrypted);
            }
            if !crate::stream::supported(method) {
                return self.skip(row, Skip::Method);
            }
        }
        // The raw segments in the order of `path.segments`: the folder of
        // the plan, then the kept segments (`clean_path` drops `.`).
        // `folderSource()` in `web/src/read/extract.ts` makes the same
        // path for a folder that is not renamed. If you change this
        // closure, change that function too.
        let prefix = self.prefix.len();
        let source = |depth: usize| {
            let raw: Vec<&str> = raw_segments(name)
                .enumerate()
                .filter(|(index, part)| *index < prefix || *part != ".")
                .map(|(_, part)| part)
                .take(prefix + depth + 1)
                .collect();
            raw.join("/") + "/"
        };
        let mut parent = ROOT;
        for (depth, (segment, bits)) in parents.iter().enumerate() {
            parent = self.folder(parent, segment, *bits, row, || source(depth))?;
        }
        let (last, bits) = last;
        if path.folder {
            let depth = parents.len();
            self.folder(parent, last, *bits, row, || source(depth))?;
            return Ok(Added::Folder);
        }
        let (name, collided) = self.unique(parent, last)?;
        reserve(&mut self.files)?;
        self.path_bytes += self.path_length(parent) + name.len() as u64;
        self.files.push(File {
            row,
            folder: parent,
            name,
            renamed: *bits | if collided { renamed::COLLISION } else { 0 },
        });
        Ok(Added::File)
    }

    /// The bytes of the path of a folder, with a separator after each
    /// segment.
    fn path_length(&self, folder: u32) -> u64 {
        let mut length = 0;
        let mut current = folder;
        while current != ROOT {
            let entry = &self.folders[current as usize];
            length += entry.name.len() as u64 + 1;
            current = entry.parent;
        }
        length
    }

    /// The path of a folder below the output folder, with a `/` after
    /// each segment. The root is empty.
    #[must_use]
    pub fn folder_path(&self, folder: u32) -> String {
        let mut names = Vec::new();
        let mut current = folder;
        while current != ROOT {
            let entry = &self.folders[current as usize];
            names.push(entry.name.as_str());
            current = entry.parent;
        }
        let mut path = String::new();
        for name in names.iter().rev() {
            path.push_str(name);
            path.push('/');
        }
        path
    }

    /// The output folders. Index 0 is the root. A parent always comes
    /// before its children.
    #[must_use]
    pub fn folders(&self) -> &[Folder] {
        &self.folders
    }

    /// The output files, in archive order.
    #[must_use]
    pub fn files(&self) -> &[File] {
        &self.files
    }

    /// The skipped rows with their reasons, in archive order.
    #[must_use]
    pub fn skipped(&self) -> &[(u32, Skip)] {
        &self.skipped
    }

    /// The UTF-8 bytes of all output paths.
    #[must_use]
    pub fn path_bytes(&self) -> u64 {
        self.path_bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_nfd(text: &str) -> String {
        use unicode_normalization::UnicodeNormalization;
        text.nfd().collect()
    }

    /// The NFC form of the names of the tests: only `e` and U+0301.
    fn nfc(name: &str) -> String {
        name.replace("e\u{301}", "\u{E9}")
    }

    fn plan(folder: &str, names: &[&str]) -> Planner {
        let mut planner = Planner::new(folder, test_nfd).unwrap();
        for (row, name) in names.iter().enumerate() {
            planner
                .add(u32::try_from(row).unwrap(), name, &nfc(name), 0, 8, 0)
                .unwrap();
        }
        planner
    }

    fn paths(planner: &Planner) -> Vec<String> {
        planner
            .files()
            .iter()
            .map(|file| planner.folder_path(file.folder) + &file.name)
            .collect()
    }

    #[test]
    fn skips_traversal_absolute_drive_and_nul() {
        for (name, reason) in [
            ("../evil.txt", Skip::Traversal),
            ("a/../../evil.txt", Skip::Traversal),
            ("a\\..\\evil.txt", Skip::Traversal),
            ("/etc/passwd", Skip::Absolute),
            ("\\\\server\\share\\x", Skip::Absolute),
            ("C:/Windows/x.dll", Skip::DriveLetter),
            ("c:x.txt", Skip::DriveLetter),
            ("a/C:relative", Skip::DriveLetter),
            ("a\0b.txt", Skip::Nul),
            ("a/\u{FF0E}\u{FF0E}/x", Skip::Traversal),
            ("a/\u{2025}/x", Skip::Traversal),
            ("\u{FE52}", Skip::Traversal),
        ] {
            assert_eq!(clean_path(name, name, 0), Err(reason), "{name:?}");
        }
    }

    #[test]
    fn drops_dot_and_empty_segments() {
        let path = clean_path("a/./b//c.txt", "a/./b//c.txt", 0).unwrap();
        let names: Vec<&str> = path
            .segments
            .iter()
            .map(|(name, _)| name.as_str())
            .collect();
        assert_eq!(names, ["a", "b", "c.txt"]);
        assert!(path.segments.iter().all(|(_, bits)| *bits == 0));
    }

    #[test]
    fn renames_reserved_names_and_trailing_dots() {
        assert_eq!(clean_segment("CON"), ("CON_".into(), renamed::RESERVED));
        assert_eq!(
            clean_segment("com1.txt"),
            ("com1_.txt".into(), renamed::RESERVED)
        );
        assert_eq!(
            clean_segment("LPT\u{B9}"),
            ("LPT\u{B9}_".into(), renamed::RESERVED)
        );
        assert_eq!(clean_segment("console.txt").1, 0);
        assert_eq!(clean_segment("COM10").1, 0);
        assert_eq!(clean_segment("a."), ("a._".into(), renamed::TRAILING));
        assert_eq!(clean_segment("a "), ("a _".into(), renamed::TRAILING));
    }

    #[test]
    fn replaces_bad_and_lookalike_characters() {
        assert_eq!(
            clean_segment("a:b*c?.txt"),
            ("a_b_c_.txt".into(), renamed::CHARACTERS)
        );
        // A right-to-left override, a fullwidth solidus and a fullwidth
        // colon.
        assert_eq!(clean_segment("x\u{202E}txt.exe").0, "x_txt.exe".to_string());
        assert_eq!(clean_segment("a\u{FF0F}b").0, "a_b");
        assert_eq!(clean_segment("C\u{FF1A}x").0, "C_x");
        assert_eq!(clean_segment("tab\there").0, "tab_here");
        // Other characters stay.
        assert_eq!(clean_segment("café 日本.txt"), ("café 日本.txt".into(), 0));
    }

    #[test]
    fn replaces_invisible_characters_and_keeps_attached_joiners() {
        for (name, clean) in [
            ("setup.p\u{200B}df", "setup.p_df"),
            ("\u{FEFF}", "_"),
            ("\u{FEFF}a.txt", "_a.txt"),
            ("soft\u{AD}hyphen.txt", "soft_hyphen.txt"),
            ("a\u{2028}b", "a_b"),
            ("pad\u{3164}.exe", "pad_.exe"),
            ("tag\u{E0041}.txt", "tag_.txt"),
            // A joiner next to ASCII, at an end or beside another joiner.
            (".ex\u{200D}e", ".ex_e"),
            ("\u{645}\u{200C}.pdf", "\u{645}_.pdf"),
            ("\u{200D}\u{645}", "_\u{645}"),
            ("\u{645}\u{200C}\u{200C}\u{645}", "\u{645}__\u{645}"),
            // A joiner before a character that the planner replaces.
            ("\u{645}\u{200C}\u{FF1A}", "\u{645}__"),
            // A variation selector with no base that is not ASCII.
            ("ex\u{FE0F}e", "ex_e"),
            ("\u{FF0F}\u{FE0F}", "__"),
            ("\u{E0100}.txt", "_.txt"),
        ] {
            assert_eq!(
                clean_segment(name),
                (clean.into(), renamed::CHARACTERS),
                "{name:?}"
            );
        }
        // Persian, Devanagari, emoji and CJK use these characters.
        for name in [
            "\u{645}\u{6CC}\u{200C}\u{62E}.pdf",
            "\u{915}\u{94D}\u{200D}\u{937}.txt",
            "\u{2764}\u{FE0F}.png",
            "\u{2764}\u{FE0F}\u{200D}\u{1F525}.png",
            "\u{1F468}\u{200D}\u{1F469}.png",
            "\u{845B}\u{E0100}.txt",
        ] {
            assert_eq!(clean_segment(name), (name.into(), 0), "{name:?}");
        }
    }

    #[test]
    fn a_cut_does_not_leave_a_joiner_before_the_extension() {
        // The room of the base is 251 bytes: it ends just after the joiner.
        let base = format!("{}\u{645}\u{200C}\u{645}", "a".repeat(246));
        let (clean, bits) = clean_segment(&format!("{base}.txt"));
        assert_eq!(clean, format!("{}\u{645}_.txt", "a".repeat(246)));
        assert_eq!(bits, renamed::TRUNCATED);
    }

    #[test]
    fn a_replaced_invisible_character_is_a_collision_like_others() {
        let planner = plan("", &["\u{FEFF}a.txt", "a.txt", "_a.txt", "\u{200B}a.txt"]);
        assert_eq!(
            paths(&planner),
            ["_a.txt", "a.txt", "_a (2).txt", "_a (3).txt"]
        );
        let bits: Vec<u8> = planner.files().iter().map(|file| file.renamed).collect();
        assert_eq!(
            bits,
            [
                renamed::CHARACTERS,
                0,
                renamed::COLLISION,
                renamed::CHARACTERS | renamed::COLLISION
            ]
        );
    }

    #[test]
    fn truncates_long_names_and_keeps_the_extension() {
        let long = format!("{}.txt", "é".repeat(200));
        let (name, bits) = clean_segment(&long);
        assert_eq!(bits, renamed::TRUNCATED);
        assert!(name.len() <= MAX_SEGMENT_BYTES);
        assert_eq!(&name[name.len() - 4..], ".txt");
    }

    #[test]
    fn skips_paths_that_are_too_deep_or_too_long() {
        let deep = "d/".repeat(MAX_DEPTH + 1) + "f";
        assert_eq!(clean_path(&deep, &deep, 0), Err(Skip::TooDeep));
        let long = format!("{}/f", vec!["x".repeat(250); 20].join("/"));
        assert_eq!(clean_path(&long, &long, 0), Err(Skip::TooLong));
    }

    #[test]
    fn renames_case_and_normalization_collisions() {
        let planner = plan(
            "",
            &[
                "Readme.txt",
                "README.TXT",
                "readme.txt",
                "caf\u{E9}",
                "cafe\u{301}",
                "a.txt",
                "a.txt",
            ],
        );
        assert_eq!(
            paths(&planner),
            [
                "Readme.txt",
                "README (2).TXT",
                "readme (3).txt",
                "caf\u{E9}",
                // The output name comes from the NFC form.
                "caf\u{E9} (2)",
                "a.txt",
                "a (2).txt"
            ]
        );
        assert_eq!(planner.files()[1].renamed, renamed::COLLISION);
        assert_eq!(planner.files()[0].renamed, 0);
    }

    #[test]
    fn a_suffix_does_not_take_a_name_that_exists() {
        let planner = plan("", &["a (2).txt", "a.txt", "a.txt"]);
        assert_eq!(paths(&planner), ["a (2).txt", "a.txt", "a (3).txt"]);
    }

    #[test]
    fn a_file_and_a_folder_with_one_name_get_two_names() {
        let planner = plan("", &["a", "a/b.txt", "A/c.txt"]);
        assert_eq!(paths(&planner), ["a", "a (2)/b.txt", "A (3)/c.txt"]);
        assert_eq!(planner.folders()[1].renamed, renamed::COLLISION);
        assert_eq!(planner.folders()[1].source, "a/");
        let planner = plan("x/", &["x/./NUL/sub/f", "x/ok/f"]);
        assert_eq!(planner.folders()[1].source, "x/NUL/");
        assert_eq!(planner.folders()[3].source, "");
    }

    #[test]
    fn keeps_only_the_rows_of_the_folder() {
        let planner = plan(
            "docs/guide/",
            &[
                "docs/guide/",
                "docs/guide/a.md",
                "docs\\guide\\b.md",
                "docs/guide2/c.md",
                "docs/guide",
                "/docs/guide/d.md",
                "docs/guide/sub/",
            ],
        );
        assert_eq!(paths(&planner), ["a.md", "b.md"]);
        assert_eq!(planner.skipped(), [(5, Skip::Absolute)]);
        assert_eq!(planner.folders().len(), 2);
        assert_eq!(planner.folders()[1].name, "sub");
    }

    #[test]
    fn skips_links_encrypted_entries_and_unknown_methods() {
        let mut planner = Planner::new("", test_nfd).unwrap();
        let link = 0o120_777 << 16;
        assert_eq!(
            planner.add(0, "link", "link", link, 0, 0).unwrap(),
            Added::Skipped(Skip::Link)
        );
        assert_eq!(
            planner.add(1, "secret", "secret", 0, 8, 1).unwrap(),
            Added::Skipped(Skip::Encrypted)
        );
        assert_eq!(
            planner.add(2, "aes", "aes", 0, 99, 0).unwrap(),
            Added::Skipped(Skip::Encrypted)
        );
        assert_eq!(
            planner.add(3, "bzip", "bzip", 0, 12, 0).unwrap(),
            Added::Skipped(Skip::Method)
        );
        assert_eq!(
            planner
                .add(4, "file", "file", 0o100_644 << 16, 8, 0)
                .unwrap(),
            Added::File
        );
        assert!(is_link(0x400));
    }

    #[test]
    fn many_duplicates_take_linear_time() {
        let mut planner = Planner::new("", test_nfd).unwrap();
        for row in 0..20_000 {
            planner.add(row, "same.txt", "same.txt", 0, 8, 0).unwrap();
        }
        assert_eq!(planner.files().last().unwrap().name, "same (20000).txt");
    }

    #[test]
    fn gives_a_safe_file_name_for_one_entry() {
        assert_eq!(file_name("a/b/CON.txt", "entry").0, "CON_.txt");
        assert_eq!(file_name("../..", "entry").0, "entry");
        assert_eq!(file_name("x/y\0z", "entry").0, "y_z");
    }
}
