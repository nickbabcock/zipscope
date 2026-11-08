//! Helpers for the largest-files tests: archive builders, a slow reference
//! for "the ten largest files under a folder", and the checks.
//!
//! The reference does not use the query. It reads only this public API:
//! `Tree::row_folder`, `Tree::parent` and the uncompressed size column.

use super::zip::{Entry, archive, field, open, u64le};
use zipscope_core::contract::{Column, FOLDER_TAG, NONE};
use zipscope_core::ingest::{Ingest, Status};
use zipscope_core::tree::ROOT;

/// The block shows ten files.
pub const LARGEST: usize = 10;

pub fn file(name: impl AsRef<[u8]>, size: u32) -> Entry {
    Entry {
        size,
        compressed: size,
        ..Entry::new(name)
    }
}

/// An entry with its sizes in a zip64 extra field.
pub fn zip64(name: impl AsRef<[u8]>, size: u64, compressed: u64) -> Entry {
    let mut body = Vec::new();
    u64le(&mut body, size);
    u64le(&mut body, compressed);
    Entry {
        size: u32::MAX,
        compressed: u32::MAX,
        extra: field(0x0001, &body),
        ..Entry::new(name)
    }
}

pub fn bytes(entries: &[Entry]) -> Vec<u8> {
    let hint = u16::try_from(entries.len()).unwrap_or(u16::MAX);
    archive(entries, hint, None).bytes
}

pub fn start(entries: &[Entry]) -> Ingest<Vec<u8>> {
    open(bytes(entries))
}

pub fn parsed(entries: &[Entry]) -> Ingest<Vec<u8>> {
    let mut ingest = start(entries);
    while *ingest.status() == Status::Parsing {
        ingest.parse(4096);
        ingest.refresh_views();
    }
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(ingest.store().rows(), entries.len());
    ingest.settle_views();
    ingest
}

/// A small deterministic random source (xorshift64*).
#[derive(Debug)]
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    pub fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }

    pub fn small(&mut self, bound: u32) -> u32 {
        u32::try_from(self.below(u64::from(bound))).unwrap()
    }

    pub fn index(&mut self, bound: usize) -> usize {
        usize::try_from(self.below(bound as u64)).unwrap()
    }
}

pub fn size(ingest: &Ingest<Vec<u8>>, row: u32) -> f64 {
    ingest.store().value(row as usize, Column::UncompressedSize)
}

/// True when `folder` is `inner` or an ancestor of `inner`.
pub fn contains(ingest: &Ingest<Vec<u8>>, folder: u32, inner: u32) -> bool {
    let mut at = inner;
    let mut steps = 0;
    while at != NONE {
        if at == folder {
            return true;
        }
        at = ingest.tree().parent(at);
        steps += 1;
        assert!(steps <= 1 << 23, "the parent chain does not end");
    }
    false
}

/// The folder that lists a file row, or `None` for an explicit folder row
/// or an unknown row.
pub fn file_folder(ingest: &Ingest<Vec<u8>>, row: u32) -> Option<u32> {
    let folder = ingest.tree().row_folder(row);
    (folder != NONE && folder & FOLDER_TAG == 0).then_some(folder)
}

/// The reference: the file rows below `rows` in the subtree of `folder`,
/// by uncompressed size from the largest, equal sizes in row order. It
/// gives all of them, not only ten, so a check can also see the zero-size
/// tail.
pub fn reference_all(ingest: &Ingest<Vec<u8>>, folder: u32, rows: usize) -> Vec<u32> {
    let mut found: Vec<u32> = (0..u32::try_from(rows).unwrap())
        .filter(|&row| file_folder(ingest, row).is_some_and(|at| contains(ingest, folder, at)))
        .collect();
    found.sort_by(|&a, &b| size(ingest, b).total_cmp(&size(ingest, a)).then(a.cmp(&b)));
    found
}

pub fn reference(ingest: &Ingest<Vec<u8>>, folder: u32, rows: usize) -> Vec<u32> {
    let mut found = reference_all(ingest, folder, rows);
    found.truncate(LARGEST);
    found
}

/// True when `actual` is a correct answer for the first `rows` rows.
///
/// The rule does not say if a file of 0 bytes shows. Thus a correct
/// answer is the reference cut after all its files that are not empty and
/// before any number of the empty files that follow them (also none).
pub fn agrees(ingest: &Ingest<Vec<u8>>, folder: u32, rows: usize, actual: &[u32]) -> bool {
    let expected = reference(ingest, folder, rows);
    let full = expected
        .iter()
        .take_while(|&&row| size(ingest, row) > 0.0)
        .count();
    actual.len() >= full && actual.len() <= expected.len() && expected[..actual.len()] == *actual
}

/// Asks for the largest files of `folder` and checks the answer against
/// all rows that are parsed now.
pub fn check(ingest: &mut Ingest<Vec<u8>>, folder: u32) -> Vec<u32> {
    let rows = ingest.store().rows();
    let actual = ingest
        .largest_files(folder)
        .unwrap_or_else(|| panic!("no answer for folder {folder}"));
    shape(ingest, folder, rows, &actual);
    assert!(
        agrees(ingest, folder, rows, &actual),
        "folder {folder}: got {actual:?}, expected {:?} (sizes {:?})",
        reference(ingest, folder, rows),
        actual
            .iter()
            .map(|&row| size(ingest, row))
            .collect::<Vec<_>>(),
    );
    actual
}

/// The rules that each answer must obey, also while parsing.
pub fn shape(ingest: &Ingest<Vec<u8>>, folder: u32, rows: usize, actual: &[u32]) {
    assert!(actual.len() <= LARGEST, "more than ten rows: {actual:?}");
    let mut seen = std::collections::BTreeSet::new();
    for (index, &row) in actual.iter().enumerate() {
        assert_eq!(row & FOLDER_TAG, 0, "a folder item {row:#x} is not a file");
        assert!(
            (row as usize) < rows,
            "row {row} is not parsed (rows {rows})"
        );
        assert!(seen.insert(row), "row {row} shows two times");
        let at = file_folder(ingest, row)
            .unwrap_or_else(|| panic!("row {row} is the explicit row of a folder"));
        assert!(
            contains(ingest, folder, at),
            "row {row} is outside folder {folder}"
        );
        if index > 0 {
            let before = actual[index - 1];
            let order = size(ingest, before)
                .total_cmp(&size(ingest, row))
                .then(row.cmp(&before));
            assert!(order.is_gt(), "rows {before} and {row} are out of order");
        }
    }
}

/// The full path of a folder, with `/` between the folder names.
pub fn path(ingest: &Ingest<Vec<u8>>, folder: u32) -> String {
    let mut names = Vec::new();
    let mut at = folder;
    while at != ROOT {
        names.push(
            String::from_utf8_lossy(ingest.tree().name(ingest.store().names(), at)).into_owned(),
        );
        at = ingest.tree().parent(at);
    }
    names.reverse();
    names.join("/")
}

/// The id of the folder at `wanted` ("" for the root), if it exists.
pub fn find(ingest: &Ingest<Vec<u8>>, wanted: &str) -> Option<u32> {
    (0..u32::try_from(ingest.tree().folder_count()).unwrap())
        .find(|&folder| path(ingest, folder) == wanted)
}

pub fn folder(ingest: &Ingest<Vec<u8>>, wanted: &str) -> u32 {
    find(ingest, wanted).unwrap_or_else(|| panic!("no folder {wanted:?}"))
}
