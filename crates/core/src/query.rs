//! Sort and search of the listing: the sort order of rows and folders, the
//! search needle, and the merge that adds sorted rows to a sorted listing.
//!
//! The order is total: when two items have the same key, the smaller row
//! or folder id comes first. Thus a listing that is sorted in steps is the
//! same as a listing that is sorted in one step.

use std::cell::{Cell, RefCell};
use std::cmp::Ordering;

use memchr::memmem::Finder;
use memchr::memrchr2;
use zipscope_heap::{Full, Room};

use crate::contract::{Column, NONE};
use crate::store::Store;
use crate::tree::{Tree, is_separator};

/// The work of a sort or a search step is counted in units.
///
/// One unit is about the time to compare two short names. A comparison or a
/// match of a long name costs more units, from the bytes that it reads.
/// Byte loops read about `BYTES_PER_UNIT` bytes in one unit. The common
/// prefix of two names is read 8 bytes at a time, thus faster.
pub const BYTES_PER_UNIT: usize = 64;
pub const PREFIX_BYTES_PER_UNIT: usize = 512;

/// The sort columns. The values are the codes of `SortColumn` in
/// `web/src/contracts.ts`.
#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SortColumn {
    /// Archive order: folders by id, rows by row.
    #[default]
    Archive = 0,
    Name = 1,
    Size = 2,
    Compressed = 3,
    Ratio = 4,
    Method = 5,
    Modified = 6,
}

impl SortColumn {
    /// Returns the column for a code, or `None` for an unknown code.
    #[must_use]
    pub fn from_code(code: u32) -> Option<SortColumn> {
        Some(match code {
            0 => SortColumn::Archive,
            1 => SortColumn::Name,
            2 => SortColumn::Size,
            3 => SortColumn::Compressed,
            4 => SortColumn::Ratio,
            5 => SortColumn::Method,
            6 => SortColumn::Modified,
            _ => return None,
        })
    }

    /// Returns true when a new row can change the key of a folder row: a
    /// rollup grows, or a late folder entry gives the folder its explicit
    /// row and thus its modified time.
    #[must_use]
    pub fn folder_keys_change(self) -> bool {
        matches!(
            self,
            SortColumn::Size | SortColumn::Compressed | SortColumn::Ratio | SortColumn::Modified
        )
    }
}

/// A sort order of the listing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Sort {
    pub column: SortColumn,
    pub descending: bool,
}

/// The order of a listing when the user chose no sort.
///
/// It is the largest first, with folders first.
/// This is the only place of this choice. The best-match order uses it inside
/// a tier.
pub const DEFAULT_SORT: Sort = Sort {
    column: SortColumn::Size,
    descending: true,
};

impl Sort {
    /// Returns true for the archive order. New rows then go at the end,
    /// so they need no merge.
    #[must_use]
    pub fn is_archive(self) -> bool {
        self.column == SortColumn::Archive && !self.descending
    }
}

/// How well a name matches a query, from the best. See `Needle::rank_counted`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    /// The base name is the query.
    Exact,
    /// The base name starts with the query.
    Prefix,
    /// The base name contains the query.
    Within,
    /// The base name does not contain the query, but the path does.
    Folder,
}

/// The place of a matching row in the best-match order: its tier, and if its
/// name ends with a separator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rank {
    pub tier: Tier,
    pub folder: bool,
}

/// The number of parts of a best-match listing: a part for the folder rows
/// and a part for the other rows of each tier.
pub const BUCKETS: usize = 8;

impl Rank {
    /// Returns the part of a best-match listing that holds this rank. A lower
    /// part comes first, and each part is in the order of `DEFAULT_SORT`.
    #[must_use]
    pub fn bucket(self) -> usize {
        self.tier as usize * 2 + usize::from(!self.folder)
    }
}

/// Returns the range of the base name of a name: the last segment. Separators
/// at the end are not part of it. A name with no segments is its own base
/// name, as in its label. A separator is one byte, also in UTF-8 names.
fn base_name(name: &[u8]) -> (usize, usize) {
    let mut end = name.len();
    while end > 0 && is_separator(name[end - 1]) {
        end -= 1;
    }
    if end == 0 {
        return (0, name.len());
    }
    let start = memrchr2(b'/', b'\\', &name[..end]).map_or(0, |at| at + 1);
    (start, end)
}

/// A search needle. It matches a name that contains it. ASCII letters
/// match in either case. Other bytes match only themselves.
///
/// The match folds the name to lower case in a buffer, then finds the
/// needle with `memchr::memmem`, which has linear worst-case work. Thus a
/// name and a query that repeat one byte cannot make a slow match.
#[derive(Debug, Clone)]
pub struct Needle {
    lower: Vec<u8>,
    /// The length of the needle without the separators at its end.
    core: usize,
    /// True when `lower[..core]` has a separator, so the needle is a part of a
    /// path. No base name can contain it.
    is_path: bool,
    finder: Finder<'static>,
    folded: RefCell<Vec<u8>>,
}

impl PartialEq for Needle {
    fn eq(&self, other: &Self) -> bool {
        self.lower == other.lower
    }
}

impl Eq for Needle {}

impl Needle {
    #[must_use]
    pub fn new(query: &[u8]) -> Self {
        let lower = query.to_ascii_lowercase();
        let core = lower
            .iter()
            .rposition(|byte| !is_separator(*byte))
            .map_or(0, |at| at + 1);
        Needle {
            finder: Finder::new(&lower).into_owned(),
            core,
            is_path: lower[..core].iter().any(|byte| is_separator(*byte)),
            lower,
            folded: RefCell::new(Vec::new()),
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.lower.is_empty()
    }

    /// Returns the allocated name bytes.
    #[must_use]
    pub fn allocated_bytes(&self) -> usize {
        self.lower.capacity()
    }

    /// Returns true when every name that this needle matches also matches
    /// `other`.
    #[must_use]
    pub fn narrows(&self, other: &Needle) -> bool {
        other.finder.find(&self.lower).is_some()
    }

    /// Returns true when `name` contains the needle.
    #[must_use]
    pub fn matches(&self, name: &[u8]) -> bool {
        self.matches_counted(name).0
    }

    /// Returns true when `name` contains the needle, and the work in
    /// units: one, and one for each `BYTES_PER_UNIT` bytes of the name.
    #[must_use]
    pub fn matches_counted(&self, name: &[u8]) -> (bool, usize) {
        if self.lower.is_empty() {
            return (true, 1);
        }
        if name.len() < self.lower.len() {
            return (false, 1);
        }
        let mut folded = self.folded.borrow_mut();
        folded.clear();
        folded.extend(name.iter().map(u8::to_ascii_lowercase));
        let hit = self.finder.find(&folded).is_some();
        (hit, 1 + name.len() / BYTES_PER_UNIT)
    }

    /// Returns the rank of `name` when it contains the needle, else `None`,
    /// and the work in units.
    ///
    /// A name that does not match costs what `matches_counted` costs. A match
    /// reads the name one time, to the first hit. A hit in the base name then
    /// gives the tier. Only a hit in the folder part needs a second scan, of
    /// the base name, which the first scan stopped before: the two scans share
    /// the bytes of one hit at most, and these are inside the base name. Thus
    /// the work is linear in the name length, and it is one unit for each
    /// `BYTES_PER_UNIT` bytes of the name and of its base name.
    ///
    /// A query that is a part of a path has a separator inside it, so no base
    /// name contains it and no second scan occurs. It is `Exact` when it is the
    /// end of the path and starts at a segment: `src/main.rs` is exact for
    /// `vendor/src/main.rs`, and not for `mysrc/main.rs`. Else it is `Folder`.
    /// That check reads the query one time, so the unit count is for the larger
    /// of the query and the base name.
    ///
    /// A query can end with the separators at the end of the name: `docs/` is
    /// the exact name of the row `docs/`.
    #[must_use]
    pub fn rank_counted(&self, name: &[u8]) -> (Option<Rank>, usize) {
        if name.len() < self.lower.len() || self.lower.is_empty() {
            return (None, 1);
        }
        let mut folded = self.folded.borrow_mut();
        folded.clear();
        folded.extend(name.iter().map(u8::to_ascii_lowercase));
        let Some(first) = self.finder.find(&folded) else {
            return (None, 1 + name.len() / BYTES_PER_UNIT);
        };
        let (start, end) = base_name(&folded);
        let (tier, second) = if self.is_path {
            let tier = if self.ends_path(&folded, end) {
                Tier::Exact
            } else {
                Tier::Folder
            };
            (tier, self.lower.len().max(name.len() - start))
        } else {
            let at = if first >= start {
                Some(first - start)
            } else {
                self.finder.find(&folded[start..])
            };
            let length = end - start;
            let tier = match at {
                Some(0) if self.lower.len() >= length => Tier::Exact,
                Some(0) => Tier::Prefix,
                Some(at) if at < length => Tier::Within,
                _ => Tier::Folder,
            };
            (tier, name.len() - start)
        };
        let rank = Rank {
            tier,
            folder: end < name.len(),
        };
        (Some(rank), 1 + (name.len() + second) / BYTES_PER_UNIT)
    }

    /// Returns true when the needle is the end of the path `folded`, which
    /// has no separators after `end`, or only those at the end of the needle,
    /// and it starts at a segment: after a separator, at the start of the
    /// path, or with a separator of its own.
    fn ends_path(&self, folded: &[u8], end: usize) -> bool {
        let (core, rest) = self.lower.split_at(self.core);
        let Some(at) = end.checked_sub(core.len()) else {
            return false;
        };
        folded[at..end] == *core
            && folded[end..].starts_with(rest)
            && (at == 0 || is_separator(folded[at - 1]) || is_separator(core[0]))
    }
}

/// Compares two names in natural order, as a file manager does. This is a
/// total order, and only byte-equal names are equal. It has two keys:
///
/// 1. The parts of the name, from the left. A run of ASCII digits is one
///    part, and its key is its number: leading zeros have no effect, the
///    longer run is larger, and runs of the same length compare by digit.
///    A number sorts where a digit sorts among the other bytes. All other
///    bytes are one part each, and ASCII letters compare without case. The
///    end of a name sorts first.
/// 2. When all parts are equal, the bytes of the full names. Thus `a01`
///    comes before `a1`, and `A` comes before `a`.
///
/// Each key depends on one name only, and the second key is decided only
/// after the full first key. Thus the order is transitive and antisymmetric.
#[must_use]
pub fn compare_names(a: &[u8], b: &[u8]) -> Ordering {
    compare_names_counted(a, b).0
}

/// Compares two names, as `compare_names`, and returns the work in units.
///
/// One comparison does not allocate, and its work is linear in the name
/// lengths. A digit run is not parsed, because it can be longer than any
/// integer type.
#[must_use]
pub fn compare_names_counted(a: &[u8], b: &[u8]) -> (Ordering, usize) {
    // Equal bytes are equal without case too, so skip the common prefix.
    let common = common_prefix(a, b);
    let same = a[common..]
        .iter()
        .zip(&b[common..])
        .take_while(|(x, y)| x.eq_ignore_ascii_case(y))
        .count();
    let at = common + same;
    let (x, y) = (a.get(at), b.get(at));
    let digit = |byte: Option<&u8>| byte.is_some_and(u8::is_ascii_digit);
    let (x_digit, y_digit) = (digit(x), digit(y));
    // Up to `at`, the parts of the two names are the same. Only a digit at
    // `at` can start or continue a number, so names with no digit there
    // need one check more than a comparison of bytes.
    let inside_number =
        (x_digit || y_digit) && ((x_digit && y_digit) || (at > 0 && a[at - 1].is_ascii_digit()));
    let (parts, read) = if inside_number {
        compare_from_number(a, b, at)
    } else {
        (compare_folded(x, y), 0)
    };
    let units = 1 + common / PREFIX_BYTES_PER_UNIT + (same + read) / BYTES_PER_UNIT;
    // The first bytes of these slices are different, so this reads few bytes.
    (parts.then_with(|| a[common..].cmp(&b[common..])), units)
}

/// Compares two bytes without case. The end of a name sorts first.
fn compare_folded(x: Option<&u8>, y: Option<&u8>) -> Ordering {
    match (x, y) {
        (Some(x), Some(y)) => x.to_ascii_lowercase().cmp(&y.to_ascii_lowercase()),
        (x, y) => x.is_some().cmp(&y.is_some()),
    }
}

/// Compares the parts of two names, from a digit at `at` in one of them or
/// in both. The bytes before `at` are the same without case. Returns the
/// order and the number of bytes that it read.
fn compare_from_number(a: &[u8], b: &[u8], at: usize) -> (Ordering, usize) {
    // The digits before `at` are the start of this number in both names.
    // A digit that is not zero makes all next digits significant. The scan
    // stops there, or at the first byte that is not a digit.
    let before = a[..at]
        .iter()
        .rev()
        .take_while(|&&byte| byte == b'0')
        .count();
    let scanned = (before + 1).min(at);
    let significant = before < at && a[at - before - 1].is_ascii_digit();
    let (mut a_at, mut b_at) = (at, at);
    let mut order = compare_runs(a, b, &mut a_at, &mut b_at, significant);
    while order == Ordering::Equal {
        let (x, y) = (a.get(a_at), b.get(b_at));
        if x.is_none() && y.is_none() {
            break;
        }
        if x.is_some_and(u8::is_ascii_digit) && y.is_some_and(u8::is_ascii_digit) {
            order = compare_runs(a, b, &mut a_at, &mut b_at, false);
        } else {
            order = compare_folded(x, y);
            a_at += 1;
            b_at += 1;
        }
    }
    (order, scanned + (a_at - at) + (b_at - at))
}

/// Compares two digit runs from `a_at` in `a` and `b_at` in `b`, and moves
/// `a_at` and `b_at` to their ends. It stops early when one run is longer.
/// Leading zeros are skipped when `significant` is false.
fn compare_runs(
    a: &[u8],
    b: &[u8],
    a_at: &mut usize,
    b_at: &mut usize,
    significant: bool,
) -> Ordering {
    if !significant {
        while a.get(*a_at) == Some(&b'0') {
            *a_at += 1;
        }
        while b.get(*b_at) == Some(&b'0') {
            *b_at += 1;
        }
    }
    let mut first = Ordering::Equal;
    loop {
        let x = a.get(*a_at).filter(|byte| byte.is_ascii_digit());
        let y = b.get(*b_at).filter(|byte| byte.is_ascii_digit());
        match (x, y) {
            (Some(x), Some(y)) => {
                first = first.then(x.cmp(y));
                *a_at += 1;
                *b_at += 1;
            }
            (Some(_), None) => return Ordering::Greater,
            (None, Some(_)) => return Ordering::Less,
            (None, None) => return first,
        }
    }
}

/// Returns the length of the common prefix of two byte strings.
fn common_prefix(a: &[u8], b: &[u8]) -> usize {
    let length = a.len().min(b.len());
    let mut at = 0;
    while at + 8 <= length {
        let x = u64::from_ne_bytes(a[at..at + 8].try_into().expect("8 bytes"));
        let y = u64::from_ne_bytes(b[at..at + 8].try_into().expect("8 bytes"));
        if x != y {
            break;
        }
        at += 8;
    }
    while at < length && a[at] == b[at] {
        at += 1;
    }
    at
}

/// The sort order of a listing, with the data that it reads. It counts
/// the work of its comparisons, and other work that a step adds, in units.
#[derive(Debug)]
pub struct Order<'a> {
    pub store: &'a Store,
    pub tree: &'a Tree,
    pub sort: Sort,
    spent: Cell<usize>,
}

impl<'a> Order<'a> {
    #[must_use]
    pub fn new(store: &'a Store, tree: &'a Tree, sort: Sort) -> Self {
        Order {
            store,
            tree,
            sort,
            spent: Cell::new(0),
        }
    }

    /// Returns the units of work since the order was made.
    #[must_use]
    pub fn spent(&self) -> usize {
        self.spent.get()
    }

    /// Adds units of work that are not comparisons.
    pub fn charge(&self, units: usize) {
        self.spent.set(self.spent.get().saturating_add(units));
    }

    /// Compares two names and counts the work.
    fn names(&self, a: &[u8], b: &[u8]) -> Ordering {
        let (order, units) = compare_names_counted(a, b);
        self.charge(units);
        order
    }

    /// Returns the bytes of a row name that a name sort reads, else 0.
    #[must_use]
    pub fn row_weight(&self, row: u32) -> usize {
        if self.sort.column == SortColumn::Name {
            self.store.name(row as usize).len()
        } else {
            0
        }
    }

    /// Returns the bytes of a folder name that a name sort reads, else 0.
    #[must_use]
    pub fn folder_weight(&self, folder: u32) -> usize {
        if self.sort.column == SortColumn::Name {
            self.tree.name(self.store.names(), folder).len()
        } else {
            0
        }
    }

    /// Applies the direction to a key comparison.
    fn direct(&self, order: Ordering) -> Ordering {
        if self.sort.descending {
            order.reverse()
        } else {
            order
        }
    }

    /// Compares two number keys. `NaN` is no value: it comes last in both
    /// directions.
    fn numbers(&self, a: f64, b: f64, tie: Ordering) -> Ordering {
        match (a.is_nan(), b.is_nan()) {
            (true, true) => tie,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => self.direct(a.total_cmp(&b)).then(tie),
        }
    }

    /// Returns the number key of a row for a column that has one.
    fn row_key(&self, row: u32) -> f64 {
        let store = self.store;
        let row = row as usize;
        match self.sort.column {
            SortColumn::Size => store.value(row, Column::UncompressedSize),
            SortColumn::Compressed => store.value(row, Column::CompressedSize),
            SortColumn::Ratio => ratio(
                store.value(row, Column::CompressedSize),
                store.value(row, Column::UncompressedSize),
            ),
            SortColumn::Method => {
                // The real method of an AES entry, then the encryption.
                let aes = store.value(row, Column::AesMethod);
                let method = if aes > 0.0 {
                    aes
                } else {
                    store.value(row, Column::Method)
                };
                let encryption = store.value(row, Column::Encryption);
                method * 256.0 + encryption
            }
            SortColumn::Modified => store.value(row, Column::Modified),
            SortColumn::Archive | SortColumn::Name => f64::NAN,
        }
    }

    /// Compares two entry rows.
    #[must_use]
    pub fn rows(&self, a: u32, b: u32) -> Ordering {
        let tie = a.cmp(&b);
        match self.sort.column {
            SortColumn::Archive => self.direct(tie),
            SortColumn::Name => self
                .direct(self.names(self.store.name(a as usize), self.store.name(b as usize)))
                .then(tie),
            _ => {
                self.charge(1);
                self.numbers(self.row_key(a), self.row_key(b), tie)
            }
        }
    }

    /// Returns the number key of a folder row: the rollup of the first
    /// folder of its chain, or the explicit row of its last folder.
    fn folder_key(&self, head: u32, tail: u32) -> f64 {
        let rollup = self.tree.rollup(head);
        match self.sort.column {
            SortColumn::Size => rollup.uncompressed_size,
            SortColumn::Compressed => rollup.compressed_size,
            SortColumn::Ratio => ratio(rollup.compressed_size, rollup.uncompressed_size),
            SortColumn::Modified => match self.tree.folder(tail).explicit_row {
                NONE => f64::NAN,
                row => self.store.value(row as usize, Column::Modified),
            },
            SortColumn::Archive | SortColumn::Name | SortColumn::Method => f64::NAN,
        }
    }

    /// Compares two folder rows, given as (first folder, last folder) of
    /// their chains. A folder has no method, so the method order keeps
    /// folders in id order.
    #[must_use]
    pub fn folders(&self, a: (u32, u32), b: (u32, u32)) -> Ordering {
        let tie = a.0.cmp(&b.0);
        match self.sort.column {
            SortColumn::Archive => self.direct(tie),
            SortColumn::Name => {
                let names = self.store.names();
                self.direct(self.names(self.tree.name(names, a.0), self.tree.name(names, b.0)))
                    .then(tie)
            }
            _ => {
                self.charge(1);
                self.numbers(self.folder_key(a.0, a.1), self.folder_key(b.0, b.1), tie)
            }
        }
    }
}

/// Returns compressed ÷ uncompressed, or `NaN` for an empty entry, which
/// has no ratio.
fn ratio(compressed: f64, uncompressed: f64) -> f64 {
    if uncompressed > 0.0 {
        compressed / uncompressed
    } else {
        f64::NAN
    }
}

/// Returns the first index from `from` whose item is not `before`. The
/// items from `from` must be `before` and then not `before`. It probes
/// 1, 2, 4… items ahead, then searches the last step, so a merge of `m`
/// items into `n` items makes about `m log(n/m)` comparisons.
fn gallop(items: &[u32], from: usize, mut before: impl FnMut(u32) -> bool) -> usize {
    let mut low = from;
    let mut high = from;
    let mut step = 1;
    while high < items.len() && before(items[high]) {
        low = high + 1;
        high = from + step;
        step *= 2;
    }
    let high = high.min(items.len());
    low + items[low..high].partition_point(|&item| before(item))
}

/// Merges the sorted items `new` into the sorted items `listing[start..]`.
/// `scratch` is a buffer that the merge can use, to keep its capacity.
///
/// # Errors
///
/// Returns [`Full`] when the memory budget has no room. Then `listing`
/// does not change.
pub fn merge(
    listing: &mut Vec<u32>,
    start: usize,
    new: &[u32],
    scratch: &mut Vec<u32>,
    order: impl Fn(u32, u32) -> Ordering,
) -> Result<(), Full> {
    let (Some(&first), Some(&last)) = (new.first(), listing.last()) else {
        return listing.try_extend_from_slice(new);
    };
    if listing.len() == start || order(last, first) == Ordering::Less {
        // The new items go after all old items, as in archive order.
        return listing.try_extend_from_slice(new);
    }
    let mut job = MergeJob::new(
        std::mem::take(scratch),
        &listing[..start],
        listing.len() + new.len(),
    )?;
    let old = &listing[start..];
    job.step(old, new, usize::MAX, &order);
    let merged = job.finish(old, None)?;
    *scratch = std::mem::replace(listing, merged);
    Ok(())
}

/// A merge of sorted new items into sorted old items, in steps. The old
/// items must not change until the merge ends.
#[derive(Debug, Default)]
pub struct MergeJob {
    /// The prefix, then the merged items so far.
    out: Vec<u32>,
    prefix: usize,
    /// The next old item and the next new item to place.
    old_at: usize,
    new_at: usize,
}

impl MergeJob {
    /// Starts a merge that writes into `out` (its old items are removed),
    /// after a copy of `prefix`. `capacity` is the length of the result,
    /// so that the steps do not allocate.
    ///
    /// # Errors
    ///
    /// Returns [`Full`] when the memory budget has no room for the result.
    pub fn new(mut out: Vec<u32>, prefix: &[u32], capacity: usize) -> Result<Self, Full> {
        out.clear();
        out.room(capacity.max(prefix.len()))?;
        out.extend_from_slice(prefix);
        Ok(MergeJob {
            out,
            prefix: prefix.len(),
            old_at: 0,
            new_at: 0,
        })
    }

    /// Starts a merge that appends to the items already in `out`. The
    /// caller makes room in `out` for the merged items, so that the steps
    /// do not allocate.
    #[must_use]
    pub fn append_to(out: Vec<u32>) -> Self {
        MergeJob {
            prefix: out.len(),
            out,
            old_at: 0,
            new_at: 0,
        }
    }

    /// Places up to `budget` new items. Returns true when all new items
    /// are placed.
    pub fn step(
        &mut self,
        old: &[u32],
        new: &[u32],
        budget: usize,
        order: impl Fn(u32, u32) -> Ordering,
    ) -> bool {
        let end = self.new_at.saturating_add(budget);
        self.step_until(old, new, order, |placed| placed >= end)
    }

    /// Places new items until all are placed or `stop` is true. `stop`
    /// gets the number of new items placed, and is asked after each item,
    /// so each call places one item at least. Returns true when all new
    /// items are placed.
    pub fn step_until(
        &mut self,
        old: &[u32],
        new: &[u32],
        order: impl Fn(u32, u32) -> Ordering,
        mut stop: impl FnMut(usize) -> bool,
    ) -> bool {
        while self.new_at < new.len() {
            let item = new[self.new_at];
            let at = gallop(old, self.old_at, |other| {
                order(other, item) == Ordering::Less
            });
            self.out.extend_from_slice(&old[self.old_at..at]);
            self.out.push(item);
            self.old_at = at;
            self.new_at += 1;
            if stop(self.new_at) {
                break;
            }
        }
        self.new_at == new.len()
    }

    /// Ends the merge of one pair of slices and makes the job ready for the
    /// next pair: it adds the old items that remain, which need room that the
    /// job already has. Returns the items after the prefix so far.
    pub fn end_part(&mut self, old: &[u32]) -> usize {
        self.out.extend_from_slice(&old[self.old_at..]);
        self.old_at = 0;
        self.new_at = 0;
        self.out.len() - self.prefix
    }

    /// Returns the merged items after the last step: the prefix, then the
    /// merged items, then the old items that remain. `prefix` replaces the
    /// prefix that `new` got.
    ///
    /// # Errors
    ///
    /// Returns [`Full`] when the memory budget has no room for a longer
    /// prefix.
    pub fn finish(mut self, old: &[u32], prefix: Option<&[u32]>) -> Result<Vec<u32>, Full> {
        self.out.try_extend_from_slice(&old[self.old_at..])?;
        if let Some(prefix) = prefix {
            self.out.room(prefix.len().saturating_sub(self.prefix))?;
            self.out
                .splice(..self.prefix, prefix.iter().copied())
                .for_each(drop);
        }
        Ok(self.out)
    }

    /// Returns the allocated bytes of the merge buffer.
    #[must_use]
    pub fn allocated_bytes(&self) -> usize {
        self.out.capacity() * size_of::<u32>()
    }

    /// Returns the buffer of the merged items, to use again.
    #[must_use]
    pub fn into_buffer(self) -> Vec<u32> {
        self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needles_match_ascii_without_case() {
        let needle = Needle::new(b"ReadMe");
        assert!(needle.matches(b"docs/README.md"));
        assert!(needle.matches(b"readme"));
        assert!(!needle.matches(b"read_me"));
        assert!(!needle.matches(b"READ"));
        // Only ASCII letters fold: `É` and `é` are different bytes.
        assert!(Needle::new("é".as_bytes()).matches("café".as_bytes()));
        assert!(!Needle::new("É".as_bytes()).matches("café".as_bytes()));
        // `@` | 0x20 is a backtick, not a letter.
        assert!(!Needle::new(b"`").matches(b"@"));
        assert!(Needle::new(b"").matches(b"anything"));
        assert!(Needle::new(b"1.2").matches(b"v1.2.0"));
    }

    /// The tier and the folder bit of a name.
    fn rank(query: &str, name: &str) -> Option<(Tier, bool)> {
        let (rank, _) = Needle::new(query.as_bytes()).rank_counted(name.as_bytes());
        rank.map(|rank| (rank.tier, rank.folder))
    }

    #[test]
    fn a_rank_has_four_tiers_from_the_base_name() {
        assert_eq!(rank("readme", "a/readme"), Some((Tier::Exact, false)));
        assert_eq!(rank("readme", "readme"), Some((Tier::Exact, false)));
        assert_eq!(rank("readme", "a/readme.md"), Some((Tier::Prefix, false)));
        assert_eq!(rank("readme", "a/old-readme"), Some((Tier::Within, false)));
        assert_eq!(rank("readme", "readme/a"), Some((Tier::Folder, false)));
        assert_eq!(rank("readme", "a/b"), None);
        assert_eq!(rank("readme", "read"), None);
    }

    #[test]
    fn a_hit_in_the_folder_part_does_not_hide_a_better_hit_in_the_base_name() {
        assert_eq!(rank("ab", "ab/ab"), Some((Tier::Exact, false)));
        assert_eq!(rank("ab", "ab/abc"), Some((Tier::Prefix, false)));
        assert_eq!(rank("ab", "ab/cab"), Some((Tier::Within, false)));
        assert_eq!(rank("ab", "ab/c"), Some((Tier::Folder, false)));
        // The first hit in the base name decides: it is at the start.
        assert_eq!(rank("a", "x/aba"), Some((Tier::Prefix, false)));
        assert_eq!(rank("a", "x/baa"), Some((Tier::Within, false)));
    }

    #[test]
    fn a_rank_folds_as_the_search_does() {
        assert_eq!(rank("ReadMe", "A/READme"), Some((Tier::Exact, false)));
        assert_eq!(rank("README", "readme.MD"), Some((Tier::Prefix, false)));
        // Only ASCII letters fold: `É` and `é` are different bytes.
        assert_eq!(rank("café", "x/CAFé"), Some((Tier::Exact, false)));
        assert_eq!(rank("café", "x/CAFÉ"), None);
        assert_eq!(rank("é", "é/é"), Some((Tier::Exact, false)));
        assert_eq!(rank("é", "é/aé"), Some((Tier::Within, false)));
        assert_eq!(rank("É", "é/é"), None);
        // The bytes of a character are not separators.
        assert_eq!(rank("日本", "x/日本語"), Some((Tier::Prefix, false)));
    }

    #[test]
    fn the_separators_at_the_end_are_not_part_of_the_base_name() {
        assert_eq!(rank("docs", "a/docs/"), Some((Tier::Exact, true)));
        assert_eq!(rank("docs", "a\\docs\\"), Some((Tier::Exact, true)));
        assert_eq!(rank("docs", "a/docs//"), Some((Tier::Exact, true)));
        assert_eq!(rank("doc", "a/docs/"), Some((Tier::Prefix, true)));
        assert_eq!(rank("oc", "a/docs/"), Some((Tier::Within, true)));
        // The row of a folder shows with its separator, so a query can have it.
        assert_eq!(rank("docs/", "docs/"), Some((Tier::Exact, true)));
        assert_eq!(rank("docs/", "a/docs/"), Some((Tier::Exact, true)));
        assert_eq!(rank("s/", "a/docs/"), Some((Tier::Within, true)));
        // A separator alone is in no base name.
        assert_eq!(rank("/", "docs/"), Some((Tier::Folder, true)));
        assert_eq!(rank("/", "a/b"), Some((Tier::Folder, false)));
        // A query with only a separator at its end is not in this base name.
        assert_eq!(rank("docs/", "docs/a"), Some((Tier::Folder, false)));
        // `\` is a separator, as in the tree.
        assert_eq!(rank("b", "a\\b"), Some((Tier::Exact, false)));
        // A name with no segments is its own base name, and it is no folder.
        assert_eq!(rank("/", "/"), Some((Tier::Exact, false)));
        assert_eq!(rank("/", "//"), Some((Tier::Prefix, false)));
        assert_eq!(rank("//", "//"), Some((Tier::Exact, false)));
        assert_eq!(rank("x", ""), None);
    }

    #[test]
    fn a_full_path_is_exact_and_other_hits_across_a_separator_are_not() {
        for name in [
            "repo-1.0/src/main.rs",
            "vendor/dep/src/main.rs",
            "src/main.rs",
            "SRC/Main.RS",
        ] {
            assert_eq!(rank("src/main.rs", name), Some((Tier::Exact, false)));
        }
        assert_eq!(
            rank("repo-1.0/src/main.rs", "repo-1.0/src/main.rs"),
            Some((Tier::Exact, false))
        );
        // A hit that does not end at the end of the name.
        assert_eq!(
            rank("src/main.rs", "a/src/main.rs.orig"),
            Some((Tier::Folder, false))
        );
        assert_eq!(
            rank("src/main.rs", "src/main.rs.d/note.txt"),
            Some((Tier::Folder, false))
        );
        // A hit that does not start at a segment.
        assert_eq!(
            rank("src/main.rs", "mysrc/main.rs"),
            Some((Tier::Folder, false))
        );
        // A part of a path that is not the end of the name.
        assert_eq!(rank("a/b", "x/a/bc"), Some((Tier::Folder, false)));
        // The first hit is not the last hit.
        assert_eq!(rank("a/b", "a/bx/a/b"), Some((Tier::Exact, false)));
        // A folder row, also when the query has the separator at its end.
        assert_eq!(rank("a/b", "x/a/b/"), Some((Tier::Exact, true)));
        assert_eq!(rank("a/b/", "x/a/b/"), Some((Tier::Exact, true)));
        assert_eq!(rank("a/b/", "x/a/b//"), Some((Tier::Exact, true)));
        assert_eq!(rank("a/b", "x/a/b//"), Some((Tier::Exact, true)));
        // The search reads bytes, and `\` is a separator in a name.
        assert_eq!(rank("a\\b", "x\\a\\b"), Some((Tier::Exact, false)));
        assert_eq!(rank("a/b", "x/a\\b"), None);
        assert_eq!(rank("a/b", "x\\a/b"), Some((Tier::Exact, false)));
        assert_eq!(rank("a/b", "xa/b"), Some((Tier::Folder, false)));
        // A separator at the start: the segment starts after it.
        assert_eq!(rank("/main.rs", "src/main.rs"), Some((Tier::Exact, false)));
        assert_eq!(
            rank("/main.rs", "src/main.rs.d/x"),
            Some((Tier::Folder, false))
        );
        // Bytes that are not ASCII match only themselves.
        assert_eq!(rank("é/ü", "x/é/ü"), Some((Tier::Exact, false)));
        assert_eq!(rank("É/ü", "x/é/ü"), None);
    }

    #[test]
    fn a_full_path_counts_its_work() {
        // Fold and first scan, then the check of the query.
        let query = format!("{}/b", "a".repeat(30_000));
        let name = format!("x/{query}");
        let (rank, units) = Needle::new(query.as_bytes()).rank_counted(name.as_bytes());
        assert_eq!(rank.unwrap().tier, Tier::Exact);
        assert_eq!(units, 1 + (name.len() + query.len()) / BYTES_PER_UNIT);
        // A long base name counts as before, also when no scan of it occurs.
        let name = format!("x/y/{}", "a".repeat(60_000));
        let (rank, units) = Needle::new(b"x/y").rank_counted(name.as_bytes());
        assert_eq!(rank.unwrap().tier, Tier::Folder);
        assert_eq!(units, 1 + (name.len() + 60_000) / BYTES_PER_UNIT);
        // At most about two units for each 64 bytes of a name, for any query.
        let needle = Needle::new(b"a/a");
        for name in [
            "a/".repeat(30_000),
            format!("{}a", "a/".repeat(30_000)),
            format!("{}/a", "a".repeat(60_000)),
        ] {
            let (_, units) = needle.rank_counted(name.as_bytes());
            assert!(units <= 1 + 2 * name.len() / BYTES_PER_UNIT, "{units}");
        }
    }

    #[test]
    fn a_folder_row_comes_first_inside_its_tier_and_a_tier_comes_first() {
        let bucket = |tier, folder| Rank { tier, folder }.bucket();
        let order = [
            bucket(Tier::Exact, true),
            bucket(Tier::Exact, false),
            bucket(Tier::Prefix, true),
            bucket(Tier::Prefix, false),
            bucket(Tier::Within, true),
            bucket(Tier::Within, false),
            bucket(Tier::Folder, true),
            bucket(Tier::Folder, false),
        ];
        assert_eq!(order, [0, 1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(BUCKETS, order.len());
    }

    #[test]
    fn a_rank_counts_its_work() {
        let needle = Needle::new(b"zz");
        // A name with no match costs what a search costs.
        let name = "a".repeat(6400);
        assert_eq!(
            needle.rank_counted(name.as_bytes()).1,
            needle.matches_counted(name.as_bytes()).1
        );
        // A short name is one unit, as in a search.
        assert_eq!(needle.rank_counted(b"azz").1, 1);
        // A match also counts the bytes of its base name.
        let name = format!("{}/{}zz", "a".repeat(6399), "b".repeat(6398));
        let (rank, units) = needle.rank_counted(name.as_bytes());
        assert_eq!(rank.unwrap().tier, Tier::Within);
        assert_eq!(units, 1 + (12_800 + 6400) / BYTES_PER_UNIT);
        // A hit in the folder part reads the base name a second time.
        let name = format!("zz{}/{}", "a".repeat(6397), "b".repeat(6400));
        let (rank, units) = needle.rank_counted(name.as_bytes());
        assert_eq!(rank.unwrap().tier, Tier::Folder);
        assert_eq!(units, 1 + (12_800 + 6400) / BYTES_PER_UNIT);
        // The count stays at or below two units for each 64 bytes of a name.
        for name in [
            "a".repeat(60_000),
            "/".repeat(60_000),
            format!("{}/", "zz".repeat(30_000)),
            format!("zz/{}", "zz".repeat(30_000)),
            format!("{}/zz", "/".repeat(60_000)),
        ] {
            let (_, units) = needle.rank_counted(name.as_bytes());
            assert!(units <= 1 + 2 * name.len() / BYTES_PER_UNIT, "{units}");
        }
    }

    #[test]
    fn a_rank_agrees_with_a_plain_scan_of_any_name() {
        let letters = b"aAbB//\\.";
        let mut seed = 0x0dd5_eed1_u64;
        for _ in 0..20_000 {
            let word = |seed: &mut u64, most: u32| -> Vec<u8> {
                let length = next(seed) % most;
                (0..length)
                    .map(|_| letters[usize::try_from(next(seed)).unwrap() % letters.len()])
                    .collect()
            };
            let name = word(&mut seed, 14);
            let query = word(&mut seed, 5);
            let needle = Needle::new(&query);
            let (rank, _) = needle.rank_counted(&name);
            let name = name.to_ascii_lowercase();
            let query = query.to_ascii_lowercase();
            if query.is_empty() || name.len() < query.len() {
                assert_eq!(rank, None);
                continue;
            }
            let hits =
                |within: &[u8]| (0..=within.len()).find(|&at| within[at..].starts_with(&query));
            assert_eq!(rank.is_some(), hits(&name).is_some());
            assert_eq!(rank.is_some(), needle.matches(&name));
            let Some(rank) = rank else { continue };
            let trimmed = name
                .iter()
                .rposition(|byte| !is_separator(*byte))
                .map_or(name.len(), |at| at + 1);
            let is_root = !name.iter().any(|byte| !is_separator(*byte));
            let end = if is_root { name.len() } else { trimmed };
            let start = if is_root {
                0
            } else {
                name[..end]
                    .iter()
                    .rposition(|byte| is_separator(*byte))
                    .map_or(0, |at| at + 1)
            };
            let core = query
                .iter()
                .rposition(|byte| !is_separator(*byte))
                .map_or(0, |at| at + 1);
            let expected = if query[..core].iter().any(|byte| is_separator(*byte)) {
                // A hit that ends at the end of the name, with the separators
                // that the query has, and that starts at a segment.
                let path_end = (0..=name.len().saturating_sub(query.len())).any(|at| {
                    name[at..].starts_with(&query)
                        && at + core == end
                        && (at == 0 || is_separator(name[at - 1]) || is_separator(query[0]))
                });
                if path_end { Tier::Exact } else { Tier::Folder }
            } else {
                match hits(&name[start..]) {
                    Some(0) if query.len() >= end - start => Tier::Exact,
                    Some(0) => Tier::Prefix,
                    Some(at) if at < end - start => Tier::Within,
                    _ => Tier::Folder,
                }
            };
            assert_eq!(rank.tier, expected, "{name:?} {query:?}");
            assert_eq!(rank.folder, end < name.len(), "{name:?}");
        }
    }

    #[test]
    fn a_longer_needle_narrows_a_shorter_one() {
        assert!(Needle::new(b"abc").narrows(&Needle::new(b"B")));
        assert!(!Needle::new(b"abc").narrows(&Needle::new(b"x")));
        assert!(Needle::new(b"abc").narrows(&Needle::new(b"")));
    }

    #[test]
    fn names_compare_without_case_then_by_bytes() {
        // Outside digits, the rule did not change. Numbers compare by value,
        // and only then the bytes decide. See `tests/natural_order.rs`.
        assert_eq!(compare_names(b"file2", b"file10"), Ordering::Less);
        assert_eq!(compare_names(b"file2", b"File10"), Ordering::Less);
        assert_eq!(compare_names(b"file01", b"file1"), Ordering::Less);
        assert_eq!(compare_names(b"a", b"B"), Ordering::Less);
        assert_eq!(compare_names(b"B", b"a"), Ordering::Greater);
        assert_eq!(compare_names(b"A", b"a"), Ordering::Less);
        assert_eq!(compare_names(b"ab", b"abc"), Ordering::Less);
        assert_eq!(
            compare_names(b"0123456789abcdefX", b"0123456789abcdefy"),
            Ordering::Less
        );
        assert_eq!(compare_names(b"same", b"same"), Ordering::Equal);
    }

    #[test]
    fn long_names_cost_more_units() {
        let short = compare_names_counted(b"abc", b"abd");
        assert_eq!(short, (Ordering::Less, 1));
        let prefix = "x".repeat(64 * 1024);
        let (order, units) = compare_names_counted(
            format!("{prefix}a").as_bytes(),
            format!("{prefix}b").as_bytes(),
        );
        assert_eq!(order, Ordering::Less);
        assert_eq!(units, 1 + 64 * 1024 / PREFIX_BYTES_PER_UNIT);
        // Bytes that differ only in case are read one at a time.
        let (order, units) = compare_names_counted(
            format!("{}a", "X".repeat(6400)).as_bytes(),
            format!("{}b", "x".repeat(6400)).as_bytes(),
        );
        assert_eq!(order, Ordering::Less);
        assert_eq!(units, 1 + 6400 / BYTES_PER_UNIT);
        let needle = Needle::new(b"zz");
        assert_eq!(needle.matches_counted(b"azz"), (true, 1));
        let name = "z".repeat(6400) + "a";
        let (hit, units) = Needle::new(b"za").matches_counted(name.as_bytes());
        assert!(hit);
        assert!(units > 6400 / BYTES_PER_UNIT, "{units}");
        let (hit, units) = needle.matches_counted("a".repeat(6400).as_bytes());
        assert!(!hit);
        assert!(units >= 6400 / BYTES_PER_UNIT, "{units}");
    }

    #[test]
    fn a_repeated_name_and_query_match_in_linear_work() {
        // An old matcher compared the needle again at each
        // position, so this took about 60,000 × 30,000 steps.
        let name = "a".repeat(60_000);
        let mut query = "A".repeat(30_000);
        query.push('b');
        let needle = Needle::new(query.as_bytes());
        let start = std::time::Instant::now();
        let (hit, units) = needle.matches_counted(name.as_bytes());
        let time = start.elapsed();
        assert!(!hit);
        assert_eq!(units, 1 + 60_000 / BYTES_PER_UNIT);
        // Also in a debug build, a linear match of 60 kB is far below this.
        assert!(time.as_millis() < 50, "{time:?}");
        let mut name = name;
        name.push_str("aB");
        assert!(needle.matches(name.as_bytes()));
        assert!(Needle::new(query.as_bytes()).narrows(&Needle::new(b"aaab")));
        assert!(!Needle::new(b"aaab").narrows(&needle));
        // A rank of this name and query also has linear work, by the count.
        let name = "a".repeat(60_000);
        assert_eq!(needle.rank_counted(name.as_bytes()).1, units);
    }

    #[test]
    fn merges_equal_a_full_sort() {
        let mut seed = 7u64;
        for round in 0..200 {
            let mut values: Vec<u32> = (0..(round % 40)).map(|_| next(&mut seed) % 50).collect();
            values.sort_unstable();
            values.dedup();
            let mut new: Vec<u32> = (0..(round % 13))
                .map(|_| 50 + next(&mut seed) % 50)
                .collect();
            // Keys repeat, ids do not: the tie-break orders them.
            let key = |item: u32| (item % 17, item);
            new.sort_unstable_by_key(|&item| key(item));
            new.dedup();
            values.sort_unstable_by_key(|&item| key(item));
            let prefix = [999, 998];
            let mut listing: Vec<u32> = prefix.iter().copied().chain(values.clone()).collect();
            let mut scratch = Vec::new();
            merge(&mut listing, 2, &new, &mut scratch, |a, b| {
                key(a).cmp(&key(b))
            })
            .unwrap();
            let mut expected: Vec<u32> = values.into_iter().chain(new).collect();
            expected.sort_unstable_by_key(|&item| key(item));
            assert_eq!(&listing[..2], &prefix);
            assert_eq!(&listing[2..], expected.as_slice(), "round {round}");
        }
    }

    #[test]
    fn a_merge_in_steps_equals_one_merge() {
        let old: Vec<u32> = (0..100).map(|i| i * 3).collect();
        let new: Vec<u32> = (0..40).map(|i| i * 7 + 1).collect();
        for budget in [1, 2, 5, 39, 40, usize::MAX] {
            let mut job = MergeJob::new(Vec::new(), &[5, 6], 0).unwrap();
            while !job.step(&old, &new, budget, |a, b| a.cmp(&b)) {}
            let merged = job.finish(&old, Some(&[999])).unwrap();
            let mut expected: Vec<u32> = old.iter().chain(&new).copied().collect();
            expected.sort_unstable();
            expected.insert(0, 999);
            assert_eq!(merged, expected, "budget {budget}");
        }
    }

    fn next(seed: &mut u64) -> u32 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        u32::try_from(*seed >> 40).unwrap()
    }
}
