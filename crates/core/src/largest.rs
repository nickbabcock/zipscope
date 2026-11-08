//! The largest files below a folder: one ranked query on the
//! store, for the space below a short listing.
//!
//! The query ranks the files in the subtree of the listed folder by their
//! uncompressed size, from the largest. Files with the same size stay in
//! archive order (the lower row first). A file is an entry row (not the
//! explicit row of a folder) whose size is more than 0. A second folder
//! entry is an entry of its folder (see the tree), so it is a file too. A
//! file of 0 bytes uses no space, so it is not a largest file.
//!
//! When the listed folder changes, a scan visits the folders of the subtree
//! and the direct entries of each folder, in steps. The scan needs no
//! memory: it walks the child and sibling links of the tree. It skips the
//! entries of a folder when the largest direct entry of that folder is
//! smaller than the last ranked file. Rows that arrive after the scan
//! started go to the ranking one time each, in `take_rows`: thus the scan
//! reads only the rows below the row count at its start.
//!
//! The result that shows belongs to the folder of the published listing.
//! While a new listing or its scan is not complete, the result of the
//! folder that shows stays, or no result shows. Thus a result never has a
//! file from outside the folder that the table lists.

use std::cmp::Ordering;

use crate::contract::{Column, FOLDER_TAG, LARGEST_FILES, NONE};
use crate::store::Store;
use crate::tree::{ROOT, Tree};

/// The largest files that a query found, from the largest.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Ranked {
    rows: [u32; LARGEST_FILES],
    sizes: [f64; LARGEST_FILES],
    length: usize,
}

impl Default for Ranked {
    fn default() -> Self {
        Ranked {
            rows: [NONE; LARGEST_FILES],
            sizes: [0.0; LARGEST_FILES],
            length: 0,
        }
    }
}

impl Ranked {
    fn rows(&self) -> &[u32] {
        &self.rows[..self.length]
    }

    /// Returns true when `(size, row)` ranks before `(other_size,
    /// other_row)`: a larger size, or the same size and a lower row.
    fn before(size: f64, row: u32, other_size: f64, other_row: u32) -> bool {
        match size.partial_cmp(&other_size) {
            Some(Ordering::Greater) => true,
            Some(Ordering::Equal) => row < other_row,
            _ => false,
        }
    }

    /// Returns the size and the row of the last file, or `None` when the
    /// ranking is not full. Only a file that ranks before it can go in.
    fn floor(&self) -> Option<(f64, u32)> {
        (self.length == LARGEST_FILES)
            .then(|| (self.sizes[LARGEST_FILES - 1], self.rows[LARGEST_FILES - 1]))
    }

    /// Puts a file into the ranking when it ranks before the last file.
    /// A row must go in one time only.
    fn offer(&mut self, row: u32, size: f64) {
        let mut at = self.length;
        while at > 0 && Self::before(size, row, self.sizes[at - 1], self.rows[at - 1]) {
            at -= 1;
        }
        if at >= LARGEST_FILES {
            return;
        }
        let end = self.length.min(LARGEST_FILES - 1);
        self.rows.copy_within(at..end, at + 1);
        self.sizes.copy_within(at..end, at + 1);
        self.rows[at] = row;
        self.sizes[at] = size;
        self.length = (self.length + 1).min(LARGEST_FILES);
    }
}

/// A scan of the rows of a subtree in steps, in the order of the tree.
#[derive(Debug, Clone, Copy)]
struct Scan {
    /// The folder whose entries the scan reads.
    at: u32,
    /// The next entry row of `at` to read, or `NONE` when the scan goes to
    /// the next folder.
    entry: u32,
    /// The scan reads only rows below this row. Later rows go to the
    /// ranking in `take_rows`.
    end: u32,
}

/// The query and its result.
#[derive(Debug)]
pub struct Largest {
    /// The folder of the query, or `NONE` before the first query.
    folder: u32,
    ranked: Ranked,
    /// The rows that the ranking has seen: all rows below it went to the
    /// ranking or to the scan.
    seen: u32,
    scan: Option<Scan>,
    /// The last complete result of an earlier folder. It shows while the
    /// listing of that folder shows.
    previous: Option<(u32, Ranked)>,
    /// The folder of the listing at the last `show`.
    listing: u32,
    /// The result that shows.
    shown: [u32; LARGEST_FILES],
    shown_length: usize,
    version: u32,
}

impl Default for Largest {
    fn default() -> Self {
        Self::new()
    }
}

/// Returns the size of a row when the row is a file that can go into the
/// ranking: more than 0 bytes and before `floor`, and not the explicit row
/// of a folder. The size comes first: it is the cheapest test, and in a
/// full ranking most rows fail it.
fn file_size(tree: &Tree, store: &Store, row: u32, floor: Option<(f64, u32)>) -> Option<f64> {
    let size = store.value(row as usize, Column::UncompressedSize);
    let positive = size.partial_cmp(&0.0) == Some(Ordering::Greater);
    if !positive || floor.is_some_and(|(last, at)| !Ranked::before(size, row, last, at)) {
        return None;
    }
    (tree.row_folder(row) & FOLDER_TAG == 0).then_some(size)
}

/// Returns true when the folder of an entry row is `folder` or below it.
/// A parent has a smaller id than its child, so the walk up stops at the
/// first id that is not larger than `folder`.
fn is_below(tree: &Tree, row: u32, folder: u32) -> bool {
    if folder == ROOT {
        return true;
    }
    let mut at = tree.row_folder(row);
    while at != NONE && at > folder {
        at = tree.parent(at);
    }
    at == folder
}

/// Converts a row count. A store has fewer than 2^32 rows: a row index
/// is a `u32` (see `FOLDER_TAG`).
fn row_word(rows: usize) -> u32 {
    u32::try_from(rows).unwrap_or(u32::MAX)
}

impl Largest {
    #[must_use]
    pub fn new() -> Self {
        Largest {
            folder: NONE,
            ranked: Ranked::default(),
            seen: 0,
            scan: None,
            previous: None,
            listing: NONE,
            shown: [NONE; LARGEST_FILES],
            shown_length: 0,
            version: 0,
        }
    }

    /// Returns the result that shows: the store rows of the largest files
    /// below the folder of the published listing, from the largest.
    #[must_use]
    pub fn rows(&self) -> &[u32] {
        &self.shown[..self.shown_length]
    }

    /// Returns the ranking of the folder of the query: its largest files,
    /// from the largest. It is complete only when no scan runs.
    #[must_use]
    pub fn ranked(&self) -> &[u32] {
        self.ranked.rows()
    }

    /// Returns a number that changes when `rows` changes.
    #[must_use]
    pub fn version(&self) -> u32 {
        self.version
    }

    /// Makes `take_rows` read all rows again. Only for time measurements.
    #[cfg(test)]
    pub(crate) fn rewind(&mut self) {
        self.seen = 0;
    }

    /// Returns true while a scan waits for `step`.
    #[must_use]
    pub fn scanning(&self) -> bool {
        self.scan.is_some()
    }

    /// Starts a new query when the listed folder changed. The scan starts
    /// at the rows that the store has now.
    pub fn follow(&mut self, tree: &Tree, store: &Store, folder: u32) {
        if folder == self.folder {
            return;
        }
        // Keep the ranking only when it is the one that shows. A ranking
        // whose listing did not show yet must not replace the result that
        // shows.
        if self.scan.is_none() && self.folder != NONE && self.folder == self.listing {
            self.previous = Some((self.folder, self.ranked));
        }
        let end = row_word(store.rows());
        self.folder = folder;
        self.ranked = Ranked::default();
        self.seen = end;
        self.scan = Some(Scan {
            at: folder,
            entry: tree.first_entry(folder),
            end,
        });
    }

    /// Puts the rows that arrived since the last call into the ranking.
    /// Each row costs a walk up from its folder to the folder of the
    /// query, at most.
    pub fn take_rows(&mut self, tree: &Tree, store: &Store) {
        let rows = row_word(store.rows());
        if self.folder == NONE {
            self.seen = rows;
            return;
        }
        for row in self.seen..rows {
            if let Some(size) = file_size(tree, store, row, self.ranked.floor())
                && is_below(tree, row, self.folder)
            {
                self.ranked.offer(row, size);
            }
        }
        self.seen = rows;
    }

    /// Makes one step of the scan, for about `budget` units of work: one
    /// unit for each row and each folder that it reads. Returns true when
    /// the scan ended in this call.
    pub fn step(&mut self, tree: &Tree, store: &Store, budget: usize) -> bool {
        let Some(mut scan) = self.scan.take() else {
            return false;
        };
        let budget = budget.max(1);
        let mut spent = 0;
        while spent < budget {
            if scan.entry != NONE && scan.entry < scan.end {
                spent += 1;
                if let Some(size) = file_size(tree, store, scan.entry, self.ranked.floor()) {
                    self.ranked.offer(scan.entry, size);
                }
                scan.entry = tree.next_entry(scan.entry);
                continue;
            }
            // The entries of `at` are done. Go to the next folder of the
            // subtree in tree order: the first child, else the next
            // sibling of the folder or of one of its ancestors below the
            // folder of the query.
            spent += 1;
            let mut next = tree.first_child(scan.at);
            let mut up = scan.at;
            while next == NONE {
                if up == self.folder {
                    return true;
                }
                next = tree.next_sibling(up);
                up = tree.parent(up);
            }
            scan.at = next;
            // A folder whose largest direct entry ranks after the last file
            // has no entry that can go into a full ranking.
            let skip = self
                .ranked
                .floor()
                .is_some_and(|(last, _)| tree.largest_entry(next) < last);
            scan.entry = if skip { NONE } else { tree.first_entry(next) };
        }
        self.scan = Some(scan);
        false
    }

    /// Makes the result that shows for the folder of the published
    /// listing (`NONE` for search results, which have no result). Returns
    /// true when the result changed.
    pub fn show(&mut self, listing_folder: u32) -> bool {
        self.listing = listing_folder;
        if listing_folder == self.folder && self.scan.is_none() {
            // The listing of the query shows: the earlier result is old.
            self.previous = None;
        }
        let ranked = if listing_folder == NONE {
            None
        } else if listing_folder == self.folder && self.scan.is_none() {
            Some(&self.ranked)
        } else {
            self.previous
                .as_ref()
                .filter(|(folder, _)| *folder == listing_folder)
                .map(|(_, ranked)| ranked)
        };
        let rows = ranked.map_or(&[][..], Ranked::rows);
        if rows == self.rows() {
            return false;
        }
        self.shown[..rows.len()].copy_from_slice(rows);
        self.shown_length = rows.len();
        self.version = self.version.wrapping_add(1);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ranking_keeps_the_largest_in_order_and_ties_in_row_order() {
        let mut ranked = Ranked::default();
        for (row, size) in [(0, 5.0), (1, 9.0), (2, 5.0), (3, 1.0), (4, 9.0)] {
            ranked.offer(row, size);
        }
        assert_eq!(ranked.rows(), &[1, 4, 0, 2, 3]);
        for row in 5..20 {
            ranked.offer(row, 2.0);
        }
        assert_eq!(ranked.rows(), &[1, 4, 0, 2, 5, 6, 7, 8, 9, 10]);
        assert_eq!(ranked.floor(), Some((2.0, 10)));
        // An equal size with a higher row ranks after the last file.
        ranked.offer(20, 2.0);
        assert_eq!(ranked.rows()[9], 10);
        // The order of the offers does not change the result.
        let mut reversed = Ranked::default();
        for row in (0..20).rev() {
            let size = match row {
                0 | 2 => 5.0,
                1 | 4 => 9.0,
                3 => 1.0,
                _ => 2.0,
            };
            reversed.offer(row, size);
        }
        assert_eq!(reversed.rows(), ranked.rows());
    }
}
