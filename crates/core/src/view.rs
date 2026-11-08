//! The views of the tree that the UI reads: the listing of one folder (the
//! table permutation) and the flattened tree.
//!
//! A chain of folders that each have one child folder and no entries shows
//! as one row. A view refers to a chain row by its last folder, the folder
//! that the row opens. The listed folder always ends its chain in the tree,
//! so the selected folder always has its own tree row.

use crate::contract::{Column, FOLDER_TAG, NONE, TREE_RECORD_WORDS};
use std::cmp::Ordering;

use zipscope_heap::{Full, Room, try_collect, try_vec, try_with_capacity};

use crate::largest::Largest;
use crate::query::{BUCKETS, DEFAULT_SORT, MergeJob, Needle, Order, Sort, SortColumn, merge};
use crate::store::Store;
use crate::tree::{ROOT, Tree};

/// Bits of word 1 of a flattened tree record.
pub mod tree_record {
    /// Bits 0 to 14: the level of the row. The root row is level 0.
    pub const LEVEL_MASK: u32 = 0x7fff;
    /// Bits 15 to 29: the folders in the row, minus 1.
    pub const CHAIN_SHIFT: u32 = 15;
    pub const CHAIN_MASK: u32 = 0x7fff;
    /// Bit 30: the last folder of the row has child folders.
    pub const HAS_CHILDREN: u32 = 1 << 30;
    /// Bit 31: the row shows its child rows.
    pub const EXPANDED: u32 = 1 << 31;
}

/// The listing and the flattened tree, and the state that makes them.
///
/// The listing is the folder items (chain rows by their last folder), then
/// the entry rows, each part in the sort order. With a search, it is the
/// rows whose name matches, from the whole archive, and no folders.
///
/// While a query is active and the user chose no sort, the rows are in the
/// best-match order: one part for each `Rank::bucket`, and each part in the
/// order of `DEFAULT_SORT`. The tier of a row is known only at its match, and
/// no bytes for each row keep it: the place of a row in `listing`, `pending`
/// or `merging` gives its part. A comparison compares rows of one part only,
/// so it never reads a tier. All other listings have one part, part 0.
///
/// New rows go to `pending`, sorted. In archive order, `refresh` adds them
/// to the listing at once. In another order, they wait for `merge`, which
/// the worker calls at most every ~250 ms, so a merge into a long listing
/// does not occur in each batch. A merge can run in steps: the listing
/// does not change until the last step.
#[derive(Debug)]
pub struct Views {
    /// The folder that the listing shows.
    listed: u32,
    /// True until the UI selects a folder. Then the listing follows the end
    /// of the root chain.
    follow: bool,
    /// The sort of a folder listing, and of a search after a choice.
    sort: Sort,
    /// Where `sort` comes from.
    source: SortSource,
    /// The search, or `None` for the listing of a folder.
    search: Option<Needle>,
    listing: Vec<u32>,
    /// The folder items at the start of the listing.
    folder_items: usize,
    /// The end of each part of the listing, from the end of the folder items.
    ends: [usize; BUCKETS],
    /// Sorted rows that are not in the listing yet, by part.
    pending: Parts,
    /// The next rows to take. For a folder: its last entry row that was
    /// taken, or `NONE`. For a search: the next row to match.
    cursor: u32,
    /// The work that the next refresh must do on the listing.
    work: Work,
    /// Make the folder items again at the next merge.
    folders_stale: bool,
    /// The tree version at the last refresh. Rollups change with it.
    rollup_version: u32,
    /// The largest uncompressed size of a search result in the listing.
    largest_match: f64,
    /// A rebuild or a refine in steps. The listing does not change until
    /// it ends.
    build: Option<Build>,
    /// A number that changes when a rebuild or a refine starts. A request
    /// that changes it waits for the new listing.
    build_epoch: u32,
    /// A rebuild or a refine that needs more units of work than this
    /// runs in steps.
    step_threshold: usize,
    /// The folder of the listing as it is now, or `NONE` for search
    /// results. It changes only when a new listing replaces the old one.
    shown_folder: u32,
    /// The state of the listing as it is now.
    shown: ShownListing,
    /// A merge in steps of the rows in `merging` into the listing.
    job: Option<ListingMerge>,
    merging: Parts,
    /// The folder items made again in steps for a merge, and the result
    /// that waits for the merge of the rows.
    folder_job: Option<FolderBuild>,
    ready_folders: Option<Vec<u32>>,
    scratch: Vec<u32>,
    tree: Vec<u32>,
    /// The expanded state of each folder, by folder id.
    expanded: Vec<bool>,
    tree_dirty: bool,
    /// The folders that the table opens in place, by folder id. All
    /// folders of a chain row change together.
    inline: Vec<bool>,
    /// The published permutation and its information words.
    table: Table,
    /// Numbers that change when the listing or the tree changes.
    listing_version: u32,
    tree_version: u32,
    /// The largest files below the listed folder.
    largest: Largest,
    /// The order of the rows of `tree`.
    tree_order: TreeOrder,
}

/// The order of the child folders in the flattened tree. Only `flatten` reads
/// it. All other readers, such as the listing, the table and the largest
/// files, follow the links of the folder table, which stay in the order that
/// the parser first saw the folders. Thus archive order stays archive order
/// in the table, and a walk that is in progress does not see a change.
#[derive(Debug, Default)]
enum TreeOrder {
    /// The order that the parser first saw the folders.
    #[default]
    Archive,
    /// A job in steps sorts the folders. The tree stays in archive order
    /// until the job ends. Then one assignment changes the order, so no
    /// flattened tree has a part of each order.
    Sorting(Box<TreeOrderJob>),
    /// Each folder has its child folders in name order.
    Name(NameOrder),
}

/// The child folders of all folders, in name order.
#[derive(Debug)]
struct NameOrder {
    /// All folders except the root: by parent id, then by name.
    children: Vec<u32>,
    /// The index in `children` of the first child of each folder, by folder
    /// id.
    starts: Vec<u32>,
    /// The `shape` of each folder, by folder id. The tree does not change after
    /// the rows end. A folder in name order is at a far place in the folder
    /// table, so `flatten` reads this short vector and not the links.
    shapes: Vec<u8>,
}

/// How `flatten` reads the child folders. A parse flattens the whole tree for
/// each batch, so the order of the tree is a type: no row pays a test of it.
trait TreeWalk {
    /// Returns the place of the first child folder that the tree shows.
    fn first(&self, tree: &Tree, folder: u32) -> u32;
    /// Returns the folder at a place, and the place of the sibling after it.
    /// The caller stops after the last sibling.
    fn next(&self, tree: &Tree, place: u32) -> (u32, u32);
    /// Returns true when a folder has one child folder and no entries.
    fn has_one_child(&self, tree: &Tree, folder: u32) -> bool;
    /// Returns true when a folder has child folders.
    fn has_children(&self, tree: &Tree, folder: u32) -> bool;
}

/// The links of the folder table: the order that the parser first saw.
struct ArchiveWalk;

impl TreeWalk for ArchiveWalk {
    #[inline]
    fn first(&self, tree: &Tree, folder: u32) -> u32 {
        tree.first_child(folder)
    }

    #[inline]
    fn next(&self, tree: &Tree, place: u32) -> (u32, u32) {
        (place, tree.next_sibling(place))
    }

    #[inline]
    fn has_one_child(&self, tree: &Tree, folder: u32) -> bool {
        tree.has_one_child(folder)
    }

    #[inline]
    fn has_children(&self, tree: &Tree, folder: u32) -> bool {
        tree.child_count(folder) > 0
    }
}

impl TreeWalk for NameOrder {
    #[inline]
    fn first(&self, _tree: &Tree, folder: u32) -> u32 {
        self.starts[folder as usize]
    }

    #[inline]
    fn next(&self, _tree: &Tree, place: u32) -> (u32, u32) {
        (self.children[place as usize], place + 1)
    }

    #[inline]
    fn has_one_child(&self, _tree: &Tree, folder: u32) -> bool {
        self.shapes[folder as usize] & shape::ONE_CHILD != 0
    }

    #[inline]
    fn has_children(&self, _tree: &Tree, folder: u32) -> bool {
        self.shapes[folder as usize] & shape::HAS_CHILDREN != 0
    }
}

/// Bits of a folder in `NameOrder::shapes`.
mod shape {
    /// The folder has one child folder and no entries.
    pub const ONE_CHILD: u8 = 1;
    /// The folder has child folders.
    pub const HAS_CHILDREN: u8 = 2;
}

/// The job that makes a `NameOrder`. One sort has all folders, by parent and
/// then by name, so a job has no state for each parent. The job reserves its
/// vectors when it starts. After that, only the ends of the sorted runs grow.
#[derive(Debug)]
struct TreeOrderJob {
    starts: Vec<u32>,
    shapes: Vec<u8>,
    sort: StepSort,
    /// The next folder to add to the sort.
    next: usize,
    /// The child folders of the folders before `next`.
    children: u32,
}

impl TreeOrderJob {
    fn allocated_bytes(&self) -> usize {
        self.starts.capacity() * size_of::<u32>()
            + self.shapes.capacity()
            + self.sort.allocated_bytes()
    }
}

/// The sort of the tree: the comparison of the table in name order.
const TREE_SORT: Sort = Sort {
    column: SortColumn::Name,
    descending: false,
};

/// The work that the next refresh must do on the listing, from the least.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Work {
    None,
    /// The search needle got longer: remove the rows that do not match.
    Refine,
    /// Make the listing again from the start.
    Rebuild,
}

/// The state of the listing as it is now. A new listing in steps does not change
/// it until the listing replaces the old one.
#[derive(Debug, Clone, Copy)]
struct ShownListing {
    order: ListingOrder,
    /// True when a new listing in steps took rows that this listing does not
    /// have: rows that waited, and rows that came during the build.
    behind: bool,
    /// The store rows at the last refresh.
    rows_seen: usize,
}

/// Where the sort of the views comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SortSource {
    /// No choice of the user. A search has the best-match order. The default
    /// sort that lands at the end of a parse is not a choice.
    Default,
    /// The user chose it, also archive order.
    Chosen,
}

/// The order of the rows of a listing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListingOrder {
    Sort,
    BestMatch,
}

/// Rows by part of a listing.
type Parts = [Vec<u32>; BUCKETS];

/// Returns the number of rows in all parts.
fn parts_len(parts: &Parts) -> usize {
    parts.iter().map(Vec::len).sum()
}

/// Returns the allocated items of all parts.
fn parts_capacity(parts: &Parts) -> usize {
    parts.iter().map(Vec::capacity).sum()
}

/// A merge in steps of new rows into the entry rows of the listing, one part
/// after the other.
#[derive(Debug)]
struct ListingMerge {
    job: MergeJob,
    /// The part that the merge is in.
    part: usize,
    /// The ends of the parts that the merge made.
    ends: [usize; BUCKETS],
}

/// The most items in one run that a sort in steps sorts in one piece.
/// Then it merges the runs in pairs.
const SORT_RUN: usize = 1024;
/// The most name bytes in one run of a name sort. Long names thus make
/// short runs, and the sort of one run stays short.
const RUN_BYTES: usize = 64 * 1024;
/// The default `step_threshold`, in units of work (see `query`).
pub const STEP_THRESHOLD: usize = 16_384;

/// A listing that is made in steps.
#[derive(Debug)]
enum Build {
    Rebuild(Box<Rebuild>),
    Refine(Refine),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// Match the rows below the cursor again, for a longer query.
    Rank,
    /// Take the rows from the old listing, to their new parts.
    Walk,
    /// Take the rows from the cursor.
    Scan,
    /// Sort the rows.
    Sort,
    /// Make the folder items.
    Folders,
}

/// A new listing, made in steps from the start.
#[derive(Debug)]
struct Rebuild {
    stage: Stage,
    /// The rows that the scan took, by part. A part is sorted when its index
    /// is below `sorted`.
    rows: Parts,
    /// The rows to match before the rows from the cursor, and the next index.
    /// A longer query uses them when few rows matched the last query.
    candidates: Vec<u32>,
    candidate: usize,
    /// The sort in steps of the next part.
    sort: Option<StepSort>,
    sorted: usize,
    rerank: Rerank,
    folders: Option<FolderBuild>,
    largest: f64,
}

/// A best-match listing for a longer query, from the old listing.
///
/// A longer query can move a row to another tier in either direction, so a
/// filter does not give the order. A new sort is not necessary either: the
/// rows of one old part keep their order in each new part, and so do the rows
/// of one part that wait for a merge. Thus a new part has at most
/// 2 × `BUCKETS` sorted runs. The names are read in row order, as a filter does,
/// and the part of each row waits in `parts` for the walk of these rows, so
/// only this listing has one byte for each row, and only until the walk.
#[derive(Debug, Default)]
struct Rerank {
    /// The new part of each row below the cursor, or `NO_PART`.
    parts: Vec<u8>,
    /// The next row to match.
    at: usize,
    /// The rows of each new part, so the walk does not grow them.
    counts: [usize; BUCKETS],
    /// The rows that waited for a merge when the longer query came.
    waiting: Parts,
    /// The next sorted run to walk: the old parts of the listing, then the
    /// parts of `waiting`. And the next row of that run.
    old_part: usize,
    walked: usize,
    /// The ends of the sorted runs of each new part.
    runs: [Vec<usize>; BUCKETS],
}

/// The value of `Rerank::parts` for a row that does not match.
const NO_PART: u8 = u8::MAX;

impl Rerank {
    fn allocated_bytes(&self) -> usize {
        self.parts.capacity()
            + parts_capacity(&self.waiting) * size_of::<u32>()
            + self
                .runs
                .iter()
                .map(|runs| runs.capacity() * size_of::<usize>())
                .sum::<usize>()
    }
}

/// The rows that a new listing starts from.
#[derive(Debug)]
enum RebuildFrom {
    /// All rows.
    Start,
    /// These rows, and the rows from the cursor.
    Candidates(Vec<u32>),
    /// The rows of the old listing and the rows that wait for a merge, which
    /// are all the rows below the cursor that can match, and the rows from the
    /// cursor.
    Listing,
}

impl Rebuild {
    fn allocated_bytes(&self) -> usize {
        (parts_capacity(&self.rows) + self.candidates.capacity()) * size_of::<u32>()
            + self.sort.as_ref().map_or(0, StepSort::allocated_bytes)
            + self.rerank.allocated_bytes()
            + self
                .folders
                .as_ref()
                .map_or(0, FolderBuild::allocated_bytes)
    }
}

/// A filter of the listing for a longer needle, in steps.
#[derive(Debug)]
struct Refine {
    /// A bit for each row below `end` that the needle matches.
    bits: Vec<u64>,
    /// The rows to match: the rows of the listing, or `None` for all rows
    /// below `end`.
    candidates: Option<Vec<u32>>,
    /// The next row, or the next index in `candidates`.
    at: usize,
    end: usize,
    largest: f64,
}

/// A sort in steps. It sorts short runs, then merges pairs of runs until
/// one run is left.
#[derive(Debug, Default)]
struct StepSort {
    items: Vec<u32>,
    /// The result of the merge pass that runs.
    other: Vec<u32>,
    /// The ends of the sorted runs in `items`, and in `other`.
    ends: Vec<usize>,
    next_ends: Vec<usize>,
    /// Before the merge: the next item to sort. In the merge: the index in
    /// `ends` of the next pair of runs.
    at: usize,
    merging: bool,
    job: Option<MergeJob>,
}

impl StepSort {
    fn new(items: Vec<u32>) -> Self {
        StepSort {
            items,
            ..StepSort::default()
        }
    }

    /// Starts from sorted runs: `ends` has the end of each run in `items`.
    fn with_runs(items: Vec<u32>, ends: Vec<usize>) -> Self {
        StepSort {
            items,
            ends,
            merging: true,
            ..StepSort::default()
        }
    }

    /// Sorts until `order` has spent `budget` units. `weight` gives the
    /// name bytes that a comparison of an item can read. Returns true when
    /// `items` is sorted.
    fn step(
        &mut self,
        order: &Order,
        budget: usize,
        weight: impl Fn(u32) -> usize,
        compare: impl Fn(u32, u32) -> Ordering,
    ) -> Result<bool, Full> {
        let over = || order.spent() >= budget.max(1);
        if !self.merging {
            let length = self.items.len();
            while self.at < length {
                if over() {
                    return Ok(false);
                }
                let start = self.at;
                let mut end = start;
                let mut bytes = 0;
                while end < length && end - start < SORT_RUN {
                    let next = weight(self.items[end]);
                    if end > start && bytes + next > RUN_BYTES {
                        break;
                    }
                    bytes += next;
                    end += 1;
                }
                self.ends.room(1)?;
                order.charge(end - start);
                self.items[start..end].sort_unstable_by(|&a, &b| compare(a, b));
                self.ends.push(end);
                self.at = end;
            }
            self.merging = true;
            self.at = 0;
        }
        loop {
            if self.ends.len() <= 1 {
                return Ok(true);
            }
            if self.at + 1 >= self.ends.len() {
                // The pass ended. A last run without a pair is copied. The
                // result is the input of the next pass.
                if self.at < self.ends.len() {
                    let start = if self.at == 0 {
                        0
                    } else {
                        self.ends[self.at - 1]
                    };
                    self.other.try_extend_from_slice(&self.items[start..])?;
                    self.next_ends.try_push(self.items.len())?;
                }
                std::mem::swap(&mut self.items, &mut self.other);
                self.other.clear();
                std::mem::swap(&mut self.ends, &mut self.next_ends);
                self.next_ends.clear();
                self.at = 0;
                continue;
            }
            if over() {
                return Ok(false);
            }
            let start = if self.at == 0 {
                0
            } else {
                self.ends[self.at - 1]
            };
            let middle = self.ends[self.at];
            let end = self.ends[self.at + 1];
            let mut job = if let Some(job) = self.job.take() {
                job
            } else {
                // The pairs of the pass write all items to `other`.
                self.other
                    .room(self.items.len().saturating_sub(self.other.len()))?;
                self.next_ends.room(1)?;
                MergeJob::append_to(std::mem::take(&mut self.other))
            };
            let left = &self.items[start..middle];
            let right = &self.items[middle..end];
            let done = job.step_until(left, right, &compare, |_| {
                order.charge(1);
                over()
            });
            if !done {
                self.job = Some(job);
                return Ok(false);
            }
            self.other = job.finish(left, None)?;
            self.next_ends.push(end);
            self.at += 2;
        }
    }
}

/// The folder items of the listed folder, made in steps.
#[derive(Debug)]
struct FolderBuild {
    /// The first and the last folder of each chain row, in folder order.
    chains: Vec<(u32, u32)>,
    /// The next child folder to take, or `NONE`.
    next: u32,
    /// Indexes in `chains`, in the sort order.
    sort: StepSort,
}

impl StepSort {
    fn allocated_bytes(&self) -> usize {
        (self.items.capacity() + self.other.capacity()) * size_of::<u32>()
            + (self.ends.capacity() + self.next_ends.capacity()) * size_of::<usize>()
            + self.job.as_ref().map_or(0, MergeJob::allocated_bytes)
    }
}

impl FolderBuild {
    fn allocated_bytes(&self) -> usize {
        self.chains.capacity() * size_of::<(u32, u32)>() + self.sort.allocated_bytes()
    }

    fn new(tree: &Tree, folder: u32) -> Self {
        FolderBuild {
            chains: Vec::new(),
            next: tree.first_child(folder),
            sort: StepSort::default(),
        }
    }

    /// Returns the folder items: the last folder of each chain row.
    fn items(&self) -> Result<Vec<u32>, Full> {
        try_collect(
            self.sort
                .items
                .iter()
                .map(|&index| self.chains[index as usize].1 | FOLDER_TAG),
        )
    }
}

impl Default for Views {
    fn default() -> Self {
        Self::new()
    }
}

/// The permutation that the table shows: the listing with the rows of the
/// folders that are open in place.
#[derive(Debug, Default)]
struct Table {
    rows: Vec<u32>,
    /// One word for each value of the published permutation, as word 1 of
    /// a tree record: level, chain, `HAS_CHILDREN` and `EXPANDED`.
    info: Vec<u32>,
    /// True when the published permutation is `rows`, not the listing.
    published: bool,
    /// The `shown_folder` of the last `update_table`.
    folder: u32,
    /// The folders open in place changed: make the table at the next
    /// refresh.
    stale: bool,
    /// The tree or the listing changed below the table: make the table at
    /// the next merge.
    merge_stale: bool,
    /// A new table, made in steps. The published one shows until it ends.
    build: Option<TableBuild>,
}

impl Table {
    fn allocated_bytes(&self) -> usize {
        let build = self.build.as_ref().map_or(0, |build| {
            (build.listing.capacity() + build.rows.capacity() + build.info.capacity())
                * size_of::<u32>()
                + build.stack.capacity() * size_of::<TableFrame>()
                + build
                    .stack
                    .iter()
                    .map(|frame| frame.folders.allocated_bytes())
                    .sum::<usize>()
                + build.entries.as_ref().map_or(0, StepSort::allocated_bytes)
        });
        (self.rows.capacity() + self.info.capacity()) * size_of::<u32>() + build
    }
}

/// A table with open folders, made in steps by `table_step`.
#[derive(Debug)]
struct TableBuild {
    /// The listing when the build started.
    listing: Vec<u32>,
    /// The folder of that listing.
    folder: u32,
    /// The next item of `listing`.
    at: usize,
    rows: Vec<u32>,
    info: Vec<u32>,
    /// The open folders that the build is in, from the outside in.
    stack: Vec<TableFrame>,
    /// The entries of the folder at the top of `stack`, sorted in steps.
    entries: Option<StepSort>,
}

/// One open folder in a table build.
#[derive(Debug)]
struct TableFrame {
    folder: u32,
    level: u32,
    /// Its child rows, collected and sorted in steps as for a listing.
    folders: FolderBuild,
    /// True when `folders` is in the sort order.
    sorted: bool,
    /// The next child row in `folders.sort.items`.
    at: usize,
}

/// One row of the flattened tree.
struct Row {
    /// The last folder of the row.
    tail: u32,
    level: u32,
    /// The folders in the row, minus 1.
    chain: u32,
    expanded: bool,
    /// The place of the row in its parent row (from 1), and the number of
    /// rows there.
    position: u32,
    size: u32,
}

/// The siblings that `flatten` has not visited yet, at one level.
struct Siblings {
    /// The place of the next sibling, from `TreeWalk`.
    next: u32,
    level: u32,
    position: u32,
    size: u32,
}

impl Views {
    #[must_use]
    pub fn new() -> Self {
        Views {
            listed: ROOT,
            follow: true,
            sort: Sort::default(),
            source: SortSource::Default,
            search: None,
            listing: Vec::new(),
            folder_items: 0,
            ends: [0; BUCKETS],
            pending: Parts::default(),
            cursor: NONE,
            work: Work::Rebuild,
            folders_stale: false,
            rollup_version: 0,
            largest_match: 0.0,
            build: None,
            build_epoch: 0,
            step_threshold: STEP_THRESHOLD,
            shown_folder: ROOT,
            shown: ShownListing {
                order: ListingOrder::Sort,
                behind: false,
                rows_seen: 0,
            },
            job: None,
            merging: Parts::default(),
            folder_job: None,
            ready_folders: None,
            scratch: Vec::new(),
            tree: Vec::new(),
            expanded: vec![true],
            tree_dirty: true,
            inline: Vec::new(),
            table: Table {
                folder: NONE,
                stale: true,
                ..Table::default()
            },
            listing_version: 0,
            tree_version: 0,
            largest: Largest::new(),
            tree_order: TreeOrder::Archive,
        }
    }

    /// Returns the bytes that the views have allocated.
    #[must_use]
    pub fn allocated_bytes(&self) -> usize {
        const WORD: usize = size_of::<u32>();
        let tree_order = match &self.tree_order {
            TreeOrder::Archive => 0,
            TreeOrder::Sorting(job) => job.allocated_bytes(),
            TreeOrder::Name(order) => {
                (order.children.capacity() + order.starts.capacity()) * WORD
                    + order.shapes.capacity()
            }
        };
        let build = match &self.build {
            Some(Build::Rebuild(job)) => job.allocated_bytes(),
            Some(Build::Refine(job)) => {
                job.bits.capacity() * size_of::<u64>()
                    + job.candidates.as_ref().map_or(0, Vec::capacity) * WORD
            }
            None => 0,
        };
        (self.listing.capacity()
            + self.tree.capacity()
            + parts_capacity(&self.pending)
            + parts_capacity(&self.merging)
            + self.scratch.capacity()
            + self.ready_folders.as_ref().map_or(0, Vec::capacity))
            * WORD
            + self.expanded.capacity()
            + self.inline.capacity()
            + build
            + tree_order
            + self.table.allocated_bytes()
            + self
                .folder_job
                .as_ref()
                .map_or(0, FolderBuild::allocated_bytes)
            + self.search.as_ref().map_or(0, Needle::allocated_bytes)
            + self
                .job
                .as_ref()
                .map_or(0, |merge| merge.job.allocated_bytes())
    }

    /// Returns the folder that the listing shows, or that the tree selects
    /// during a search.
    #[must_use]
    pub fn listed(&self) -> u32 {
        self.listed
    }

    /// Returns the folder that the permutation lists, or `NONE` when it
    /// lists search results.
    #[must_use]
    pub fn permutation_folder(&self) -> u32 {
        self.shown_folder
    }

    /// Sets the units of work above which a rebuild or a refine runs in
    /// steps. Tests use a small value.
    #[doc(hidden)]
    pub fn set_step_threshold(&mut self, units: usize) {
        self.step_threshold = units;
    }

    /// Returns true while a new sort, search or folder listing is made in
    /// steps. `merge` makes the steps.
    #[must_use]
    pub fn building(&self) -> bool {
        self.build.is_some() || self.table.build.is_some()
    }

    /// Returns a number that changes each time a new listing starts, also
    /// one that replaces a listing that is built in steps.
    #[must_use]
    pub fn build_epoch(&self) -> u32 {
        self.build_epoch
    }

    /// Returns the listing: tagged indexes of the child rows (chains by
    /// their last folder), then the direct entry rows. During a search, the
    /// rows that match.
    #[must_use]
    pub fn listing(&self) -> &[u32] {
        &self.listing
    }

    /// Returns the permutation that the table shows: the listing, with the
    /// rows of the folders that are open in place after their folder row.
    #[must_use]
    pub fn permutation(&self) -> &[u32] {
        if self.table.published {
            &self.table.rows
        } else {
            &self.listing
        }
    }

    /// Returns one information word for each value of `permutation`, with
    /// the bits of word 1 of a tree record. The level is 0 for the rows of
    /// the listed folder.
    #[must_use]
    pub fn permutation_info(&self) -> &[u32] {
        &self.table.info
    }

    /// Returns the flattened tree: `TREE_RECORD_WORDS` words for each
    /// visible row, in tree order.
    #[must_use]
    pub fn tree(&self) -> &[u32] {
        &self.tree
    }

    /// Returns a number that changes when the listing changes.
    #[must_use]
    pub fn listing_version(&self) -> u32 {
        self.listing_version
    }

    /// Returns a number that changes when the flattened tree changes.
    #[must_use]
    pub fn tree_version(&self) -> u32 {
        self.tree_version
    }

    /// Returns the largest files below the folder of the permutation, from
    /// the largest, as store rows. It is empty for search results.
    #[must_use]
    pub fn largest_files(&self) -> &[u32] {
        self.largest.rows()
    }

    /// Returns a number that changes when `largest_files` changes.
    #[must_use]
    pub fn largest_version(&self) -> u32 {
        self.largest.version()
    }

    /// Returns the sort order.
    #[must_use]
    pub fn sort(&self) -> Sort {
        self.sort
    }

    /// Returns true when a search is active.
    #[must_use]
    pub fn searching(&self) -> bool {
        self.search.is_some()
    }

    /// Returns true when the rows of the current state are in the best-match
    /// order: a query is active and the user chose no sort.
    fn best_match(&self) -> bool {
        self.search.is_some() && self.source == SortSource::Default
    }

    /// Returns the sort of the rows of the current state: inside each part,
    /// when the order is best match.
    fn row_sort(&self) -> Sort {
        if self.best_match() {
            DEFAULT_SORT
        } else {
            self.sort
        }
    }

    /// Returns true when the listing as it is now is in the best-match order.
    /// The UI shows this state as the order of the listing, because no column
    /// has it.
    #[must_use]
    pub fn listing_best_match(&self) -> bool {
        self.shown.order == ListingOrder::BestMatch
    }

    /// Returns true when the listing does not show all parsed rows in the
    /// sort order yet. `merge` brings it up to date.
    #[must_use]
    pub fn merge_pending(&self) -> bool {
        self.build.is_some()
            || self.job.is_some()
            || self.folder_job.is_some()
            || self.ready_folders.is_some()
            || self.pending.iter().any(|rows| !rows.is_empty())
            || self.folders_stale
            || self.table.merge_stale
            || self.table.build.is_some()
            || self.largest.scanning()
    }

    /// Returns true when parsed rows of this listing are not in it as it is
    /// now: they wait for a merge, or a new listing took them from the merge
    /// path. A stop that leaves this true has a listing with rows missing. A
    /// new order of the same rows that is not ready yet is not such a case.
    #[must_use]
    pub fn rows_waiting(&self) -> bool {
        self.shown.behind || self.job.is_some() || self.pending.iter().any(|rows| !rows.is_empty())
    }

    /// Returns the largest uncompressed size of a row of the listing: of a
    /// direct entry, or the rollup of a child folder (the first folder of
    /// its chain row). During a search, of a result. The table scales its
    /// size bars to it.
    #[must_use]
    pub fn listing_largest(&self, tree: &Tree) -> f64 {
        let folder = self.shown_folder;
        if folder == NONE {
            return self.largest_match;
        }
        tree.child_folders(folder)
            .map(|child| tree.rollup(child).uncompressed_size)
            .fold(tree.largest_entry(folder), f64::max)
    }

    /// Sets the sort order that the user chose. `refresh` sorts the listing
    /// again. A choice ends the best-match order, also when the column is the
    /// one that best match uses inside a part.
    pub fn set_sort(&mut self, sort: Sort) {
        let order = (self.best_match(), self.row_sort());
        self.sort = sort;
        self.source = SortSource::Chosen;
        if (self.best_match(), self.row_sort()) != order {
            self.work = Work::Rebuild;
        }
    }

    /// Sets the default sort, which is not a choice of the user. A folder
    /// listing gets it at the next `refresh`. A best-match listing does not
    /// change: it has this sort inside its parts, and its folder gets the
    /// default sort when the query goes. It does nothing after a choice.
    pub fn set_default_sort(&mut self) {
        if self.source == SortSource::Chosen {
            return;
        }
        let order = self.row_sort();
        self.sort = DEFAULT_SORT;
        if self.row_sort() != order {
            self.work = Work::Rebuild;
        }
    }

    /// Sets the search. An empty query shows the listed folder again. A
    /// query that contains the last query only removes rows.
    pub fn set_search(&mut self, query: &[u8]) {
        let needle = Needle::new(query);
        if needle.is_empty() {
            if self.search.take().is_some() {
                self.work = Work::Rebuild;
            }
            return;
        }
        match &self.search {
            Some(old) if *old == needle => {}
            // A rebuild in steps has not taken all rows yet: start again.
            Some(old) if needle.narrows(old) && self.build.is_none() => {
                self.search = Some(needle);
                self.work = self.work.max(Work::Refine);
            }
            _ => {
                self.search = Some(needle);
                self.work = Work::Rebuild;
            }
        }
    }

    /// Returns the number of visible tree rows.
    #[must_use]
    pub fn tree_rows(&self) -> usize {
        self.tree.len() / TREE_RECORD_WORDS
    }

    /// Returns true when the folder shows on one row with its only child.
    fn joins_child(&self, tree: &Tree, folder: u32) -> bool {
        folder != ROOT && folder != self.listed && tree.has_one_child(folder)
    }

    fn is_expanded(&self, folder: u32) -> bool {
        self.expanded.get(folder as usize).copied().unwrap_or(false)
    }

    fn set_expanded(&mut self, folder: u32, open: bool) -> Result<(), Full> {
        let index = folder as usize;
        if index >= self.expanded.len() {
            self.expanded.try_resize(index + 1, false)?;
        }
        self.expanded[index] = open;
        Ok(())
    }

    /// Lists a folder and expands its ancestors, so its tree row shows.
    /// The listing stops following the root chain. Returns false for an
    /// unknown folder.
    ///
    /// When the memory budget has no room, the change can stop in the
    /// middle, and `zipscope_heap::refused()` is true. Then the caller must
    /// not change the views again. The same applies to the other methods
    /// that change the views.
    pub fn list(&mut self, tree: &Tree, folder: u32) -> bool {
        if folder as usize >= tree.folder_count() {
            return false;
        }
        self.follow = false;
        // An error sets `refused()`, which the worker reads.
        let _: Result<(), Full> = self.show(tree, folder);
        true
    }

    fn show(&mut self, tree: &Tree, folder: u32) -> Result<(), Full> {
        let mut ancestor = tree.parent(folder);
        while ancestor != NONE {
            self.set_expanded(ancestor, true)?;
            ancestor = tree.parent(ancestor);
        }
        self.tree_dirty = true;
        if folder != self.listed {
            self.listed = folder;
            // A new folder starts with all its rows closed.
            if !self.inline.is_empty() {
                self.inline.clear();
                self.table.stale = true;
            }
            // A search lists the whole archive, so it does not change.
            if self.search.is_none() {
                self.work = Work::Rebuild;
            }
        }
        Ok(())
    }

    /// Expands or collapses the tree row that ends at `folder`. All folders
    /// of the row change, so the row keeps its state when its chain splits
    /// or grows. Returns false for an unknown folder.
    pub fn expand(&mut self, tree: &Tree, folder: u32, open: bool) -> bool {
        if folder as usize >= tree.folder_count() {
            return false;
        }
        // An error sets `refused()`, which the worker reads.
        let _: Result<(), Full> = self.try_expand(tree, folder, open);
        true
    }

    fn try_expand(&mut self, tree: &Tree, folder: u32, open: bool) -> Result<(), Full> {
        self.set_expanded(folder, open)?;
        let mut ancestor = tree.parent(folder);
        while ancestor != NONE && self.joins_child(tree, ancestor) {
            self.set_expanded(ancestor, open)?;
            ancestor = tree.parent(ancestor);
        }
        self.tree_dirty = true;
        if !open && is_below(tree, self.listed, folder) {
            // The row of the listed folder hides. Select the collapsed row,
            // so the tree keeps a selected row.
            self.follow = false;
            self.show(tree, folder)?;
        }
        Ok(())
    }

    /// Opens or closes the table row that ends at `folder` in place. All
    /// folders of the row change. With `deep`, all folders below it change
    /// too. Returns false for an unknown folder.
    pub fn expand_inline(&mut self, tree: &Tree, folder: u32, open: bool, deep: bool) -> bool {
        if folder as usize >= tree.folder_count() {
            return false;
        }
        // An error sets `refused()`, which the worker reads.
        let _: Result<(), Full> = self.try_expand_inline(tree, folder, open, deep);
        true
    }

    fn try_expand_inline(
        &mut self,
        tree: &Tree,
        folder: u32,
        open: bool,
        deep: bool,
    ) -> Result<(), Full> {
        let count = tree.folder_count();
        if self.inline.len() < count {
            self.inline.try_resize(count, false)?;
        }
        self.inline[folder as usize] = open;
        let mut ancestor = tree.parent(folder);
        while ancestor != NONE && self.joins_child(tree, ancestor) {
            self.inline[ancestor as usize] = open;
            ancestor = tree.parent(ancestor);
        }
        if deep {
            // A parent has a smaller id than its child.
            let first = folder as usize;
            let mut below = try_vec(false, count - first)?;
            below[0] = true;
            for index in first + 1..count {
                let parent = tree.parent(u32::try_from(index).unwrap_or(NONE)) as usize;
                if (first..count).contains(&parent) && below[parent - first] {
                    below[index - first] = true;
                    self.inline[index] = open;
                }
            }
        }
        self.table.stale = true;
        Ok(())
    }

    fn is_inline(&self, folder: u32) -> bool {
        self.inline.get(folder as usize).copied().unwrap_or(false)
    }

    /// Starts the job that puts the tree in name order. Call it only after
    /// the last row: the job has the folders of this moment. A job with little
    /// work ends in this call, so it needs no other publish. It does nothing
    /// when a job started before.
    pub fn start_tree_order(&mut self, tree: &Tree, store: &Store) {
        // An error sets `refused()`, which the worker reads.
        let _: Result<bool, Full> = self.try_start_tree_order(tree, store);
    }

    fn try_start_tree_order(&mut self, tree: &Tree, store: &Store) -> Result<bool, Full> {
        if !matches!(self.tree_order, TreeOrder::Archive) {
            return Ok(false);
        }
        let folders = tree.folder_count();
        let mut sort = StepSort::new(try_with_capacity(folders - 1)?);
        sort.other = try_with_capacity(folders - 1)?;
        self.tree_order = TreeOrder::Sorting(Box::new(TreeOrderJob {
            starts: try_vec(0, folders)?,
            shapes: try_vec(0, folders)?,
            sort,
            next: 0,
            children: 0,
        }));
        self.try_tree_order_step(tree, store, self.step_threshold)
    }

    /// Returns true after `start_tree_order`, also when the job ended. Then
    /// the parse must add no more rows, because the job and its result have
    /// no place for a new folder.
    #[must_use]
    pub fn tree_order_started(&self) -> bool {
        !matches!(self.tree_order, TreeOrder::Archive)
    }

    /// Returns true while the job of the tree order has work.
    #[must_use]
    pub fn tree_order_pending(&self) -> bool {
        matches!(self.tree_order, TreeOrder::Sorting(_))
    }

    /// Returns true when the flattened tree is in name order.
    #[must_use]
    pub fn tree_in_name_order(&self) -> bool {
        matches!(self.tree_order, TreeOrder::Name(_))
    }

    /// Runs the job of the tree order for about `budget` units of work. One
    /// unit is about one comparison of two short names. A longer name costs
    /// more. Returns true when the job ended: then the tree has changed, and
    /// the caller publishes it.
    pub fn tree_order_step(&mut self, tree: &Tree, store: &Store, budget: usize) -> bool {
        self.try_tree_order_step(tree, store, budget)
            .unwrap_or(false)
    }

    fn try_tree_order_step(
        &mut self,
        tree: &Tree,
        store: &Store,
        budget: usize,
    ) -> Result<bool, Full> {
        let TreeOrder::Sorting(job) = &mut self.tree_order else {
            return Ok(false);
        };
        let order = Order::new(store, tree, TREE_SORT);
        while job.next < tree.folder_count() {
            if order.spent() >= budget.max(1) {
                return Ok(false);
            }
            let folder = u32::try_from(job.next).expect("folder ids fit in u32");
            order.charge(1);
            job.starts[job.next] = job.children;
            job.children += tree.child_count(folder);
            job.shapes[job.next] = if tree.has_one_child(folder) {
                shape::ONE_CHILD
            } else {
                0
            } | if tree.child_count(folder) > 0 {
                shape::HAS_CHILDREN
            } else {
                0
            };
            if folder != ROOT {
                job.sort.items.push(folder);
            }
            job.next += 1;
        }
        let done = job.sort.step(
            &order,
            budget,
            |folder| order.folder_weight(folder),
            |a, b| match tree.parent(a).cmp(&tree.parent(b)) {
                // Folder names are different in one parent.
                Ordering::Equal => order.folders((a, a), (b, b)),
                by_parent => {
                    order.charge(1);
                    by_parent
                }
            },
        )?;
        if !done {
            return Ok(false);
        }
        self.tree_order = TreeOrder::Name(NameOrder {
            children: std::mem::take(&mut job.sort.items),
            starts: std::mem::take(&mut job.starts),
            shapes: std::mem::take(&mut job.shapes),
        });
        self.flatten(tree)?;
        self.tree_version = self.tree_version.wrapping_add(1);
        self.tree_dirty = false;
        Ok(true)
    }

    /// Makes the views again where the tree changed, and takes the new
    /// rows of the listing. In archive order, it adds them to the listing.
    /// Returns true when a view changed.
    pub fn refresh(&mut self, tree: &mut Tree, store: &Store) -> bool {
        self.try_refresh(tree, store).unwrap_or(false)
    }

    fn try_refresh(&mut self, tree: &mut Tree, store: &Store) -> Result<bool, Full> {
        // A new listing that scans owns the cursor, so these rows are not in
        // `pending`, and the listing that shows does not get them.
        if self.build.is_some() && store.rows() != self.shown.rows_seen {
            self.shown.behind = true;
        }
        self.shown.rows_seen = store.rows();
        let changes = tree.take_changes();
        if self.follow {
            let end = tree.compact_end(ROOT);
            if end != self.listed {
                self.show(tree, end)?;
                self.set_expanded(end, true)?;
            }
        }
        // The largest files follow the listed folder, also during a search.
        self.largest.follow(tree, store, self.listed);
        self.largest.take_rows(tree, store);
        if self.largest.scanning() {
            self.largest.step(tree, store, self.step_threshold);
        }
        if !changes.is_empty() {
            self.tree_dirty = true;
            if self.search.is_none() && !self.folders_stale {
                self.folders_stale = changes
                    .iter()
                    .any(|&folder| self.changes_listing(tree, folder));
            }
        }
        if tree.version() != self.rollup_version {
            self.rollup_version = tree.version();
            // Rows below the open folders changed. A build that runs can
            // have passed their folder, so another build follows it.
            if self.table.published || self.table.build.is_some() {
                self.table.merge_stale = true;
            }
            // A new row can change the order of folder rows.
            if self.search.is_none() && self.sort.column.folder_keys_change() {
                self.folders_stale = true;
            }
        }
        let mut listing_changed = false;
        // True when only new rows of the archive order changed the listing.
        let mut grew = false;
        if self.work == Work::Rebuild {
            listing_changed = self.start_rebuild(tree, store, RebuildFrom::Start)?;
        } else {
            if self.work == Work::Refine {
                listing_changed = self.start_refine(tree, store)?;
            }
            // A rebuild that scans owns the cursor.
            let scanning = matches!(&self.build, Some(Build::Rebuild(r)) if r.stage == Stage::Scan);
            if !scanning {
                self.collect(tree, store)?;
            }
            if self.row_sort().is_archive() && self.build.is_none() {
                let merged = self.merge_step(tree, store, usize::MAX)?;
                grew = merged && !listing_changed;
                listing_changed |= merged;
            }
        }
        // A table of open folders keeps its build when only new rows of
        // the archive order changed the listing.
        let keep = grew
            && self.same_table_folder()
            && (self.table.published || self.table.build.is_some());
        if self.table.stale || (listing_changed && !keep) {
            // A request that opens or closes rows waits for its table.
            let own = self.table.stale;
            listing_changed =
                self.update_table(tree, store, self.step_threshold, own)? || listing_changed;
        } else if listing_changed {
            if self.table.published {
                // The published table does not change with the listing.
                listing_changed = false;
            } else {
                self.publish_listing(tree)?;
            }
            // The next merge makes the table again, at most every merge
            // interval.
            self.table.merge_stale = true;
        }
        if listing_changed {
            self.listing_version = self.listing_version.wrapping_add(1);
        }
        let tree_changed = self.tree_dirty;
        if self.tree_dirty {
            self.flatten(tree)?;
            self.tree_version = self.tree_version.wrapping_add(1);
            self.tree_dirty = false;
        }
        let largest_changed = self.largest.show(self.shown_folder);
        Ok(listing_changed || tree_changed || largest_changed)
    }

    /// Adds pending rows to the listing in the sort order until about
    /// `budget` units of work are done, and makes the folder items again
    /// if they changed. The listing changes only when all rows of the
    /// merge are placed. Then it returns true. Rows that arrive during a
    /// merge wait for the next merge. A rebuild or a refine in steps comes
    /// first. Each call does one piece of work at least.
    pub fn merge(&mut self, tree: &Tree, store: &Store, budget: usize) -> bool {
        self.try_merge(tree, store, budget).unwrap_or(false)
    }

    fn try_merge(&mut self, tree: &Tree, store: &Store, budget: usize) -> Result<bool, Full> {
        let mut changed = self.merge_step(tree, store, budget)?;
        let idle = self.build.is_none() && self.job.is_none();
        if changed {
            // The listing changed. Without a table, it is published now.
            changed = self.update_table(tree, store, budget, false)?;
        } else if idle && self.table.build.is_some() {
            changed = self.table_step(tree, store, budget)?;
        } else if idle && self.table.merge_stale {
            changed = self.update_table(tree, store, budget, false)?;
        } else if idle && self.largest.scanning() {
            // The listing comes first. The scan of the largest files has
            // no listing to change.
            self.largest.step(tree, store, budget);
        }
        if changed {
            self.listing_version = self.listing_version.wrapping_add(1);
        }
        let largest_changed = self.largest.show(self.shown_folder);
        Ok(changed || largest_changed)
    }

    fn merge_step(&mut self, tree: &Tree, store: &Store, budget: usize) -> Result<bool, Full> {
        if self.build.is_some() {
            return self.build_step(tree, store, budget);
        }
        let order = Order::new(store, tree, self.row_sort());
        if self.folders_stale
            && self.job.is_none()
            && self.folder_job.is_none()
            && self.ready_folders.is_none()
        {
            // Changes from now on make the folder items again later.
            self.folders_stale = false;
            if self.search.is_none() {
                self.folder_job = Some(FolderBuild::new(tree, self.listed));
            }
        }
        if let Some(mut folders) = self.folder_job.take() {
            if !self.folder_step(&mut folders, &order, budget)? {
                self.folder_job = Some(folders);
                return Ok(false);
            }
            self.ready_folders = Some(folders.items()?);
        }
        let mut merge = match self.job.take() {
            Some(merge) => merge,
            None if self.pending.iter().all(Vec::is_empty) => {
                let Some(folders) = self.ready_folders.take() else {
                    return Ok(false);
                };
                self.listing
                    .room(folders.len().saturating_sub(self.folder_items))?;
                self.listing
                    .splice(..self.folder_items, folders.iter().copied());
                self.folder_items = folders.len();
                return Ok(true);
            }
            None => {
                let job = MergeJob::new(
                    std::mem::take(&mut self.scratch),
                    &self.listing[..self.folder_items],
                    self.listing.len() + parts_len(&self.pending),
                )?;
                std::mem::swap(&mut self.merging, &mut self.pending);
                self.pending.iter_mut().for_each(Vec::clear);
                ListingMerge {
                    job,
                    part: 0,
                    ends: [0; BUCKETS],
                }
            }
        };
        let entries = &self.listing[self.folder_items..];
        while merge.part < BUCKETS {
            let part = merge.part;
            let start = if part == 0 { 0 } else { self.ends[part - 1] };
            let old = &entries[start..self.ends[part]];
            let done = merge.job.step_until(
                old,
                &self.merging[part],
                |a, b| order.rows(a, b),
                |_| {
                    order.charge(1);
                    order.spent() >= budget.max(1)
                },
            );
            if !done {
                self.job = Some(merge);
                return Ok(false);
            }
            merge.ends[part] = merge.job.end_part(old);
            merge.part += 1;
        }
        if self.search.is_some() {
            self.largest_match = self
                .merging
                .iter()
                .flatten()
                .map(|&row| store.value(row as usize, Column::UncompressedSize))
                .fold(self.largest_match, f64::max);
        }
        let folders = self.ready_folders.take();
        let merged = merge.job.finish(&[], folders.as_deref())?;
        self.scratch = std::mem::replace(&mut self.listing, merged);
        self.ends = merge.ends;
        if let Some(folders) = folders {
            self.folder_items = folders.len();
        }
        self.merging.iter_mut().for_each(Vec::clear);
        Ok(true)
    }

    /// Stops a merge in steps. Its rows wait again.
    fn cancel_merge(&mut self, tree: &Tree, store: &Store) -> Result<(), Full> {
        self.folder_job = None;
        self.ready_folders = None;
        if let Some(job) = self.job.take() {
            self.scratch = job.job.into_buffer();
            let order = Order::new(store, tree, self.row_sort());
            for (pending, rows) in self.pending.iter_mut().zip(&mut self.merging) {
                merge(pending, 0, rows, &mut self.scratch, |a, b| order.rows(a, b))?;
                rows.clear();
            }
        }
        Ok(())
    }

    /// Makes folder items until `order` has spent `budget` units. Returns
    /// true when `folders` holds all child folders of the listed folder in
    /// the sort order. Folders that are added after their place was passed
    /// wait for the next merge.
    fn folder_step(
        &self,
        folders: &mut FolderBuild,
        order: &Order,
        budget: usize,
    ) -> Result<bool, Full> {
        let tree = order.tree;
        while folders.next != NONE {
            if order.spent() >= budget.max(1) {
                return Ok(false);
            }
            folders.chains.room(1)?;
            folders.sort.items.room(1)?;
            let head = folders.next;
            let (tail, extra, _) = self.chain(tree, head);
            order.charge(1 + extra as usize);
            let index = u32::try_from(folders.chains.len()).expect("folder ids fit in u32");
            folders.chains.push((head, tail));
            folders.sort.items.push(index);
            folders.next = tree.next_sibling(head);
        }
        if self.row_sort().is_archive() {
            return Ok(true);
        }
        let chains = &folders.chains;
        folders.sort.step(
            order,
            budget,
            |index| order.folder_weight(chains[index as usize].0),
            |a, b| order.folders(chains[a as usize], chains[b as usize]),
        )
    }

    /// Starts a new listing. When it needs few units of work, it is made at
    /// once: then it returns true. Else `merge` makes it in steps.
    ///
    fn start_rebuild(
        &mut self,
        tree: &Tree,
        store: &Store,
        from: RebuildFrom,
    ) -> Result<bool, Full> {
        self.build_epoch = self.build_epoch.wrapping_add(1);
        self.shown.behind |= self.rows_waiting();
        self.job = None;
        self.merging.iter_mut().for_each(Vec::clear);
        self.folder_job = None;
        self.ready_folders = None;
        self.work = Work::None;
        self.folders_stale = false;
        let (stage, candidates, rerank) = match from {
            RebuildFrom::Start => {
                self.cursor = if self.search.is_some() { 0 } else { NONE };
                (Stage::Scan, Vec::new(), Rerank::default())
            }
            RebuildFrom::Candidates(rows) => (Stage::Scan, rows, Rerank::default()),
            RebuildFrom::Listing => {
                let rerank = Rerank {
                    parts: try_vec(NO_PART, self.cursor as usize)?,
                    waiting: std::mem::take(&mut self.pending),
                    ..Rerank::default()
                };
                (Stage::Rank, Vec::new(), rerank)
            }
        };
        self.pending.iter_mut().for_each(Vec::clear);
        let mut rows = Parts::default();
        // The scratch buffer is the rows of part 0 when that part holds all
        // rows. Else no part can use it well, so its memory goes first.
        let scratch = std::mem::take(&mut self.scratch);
        if !self.best_match() {
            rows[0] = scratch;
            rows[0].clear();
        }
        self.build = Some(Build::Rebuild(Box::new(Rebuild {
            stage,
            rows,
            candidates,
            candidate: 0,
            sort: None,
            sorted: 0,
            rerank,
            folders: None,
            largest: 0.0,
        })));
        self.build_step(tree, store, self.step_threshold)
    }

    /// Makes one step of the build. Returns true when it ended and the
    /// listing changed.
    fn build_step(&mut self, tree: &Tree, store: &Store, budget: usize) -> Result<bool, Full> {
        let order = Order::new(store, tree, self.row_sort());
        match self.build.take() {
            Some(Build::Rebuild(mut rebuild)) => {
                if !self.rebuild_step(tree, store, &order, &mut rebuild, budget)? {
                    self.build = Some(Build::Rebuild(rebuild));
                    return Ok(false);
                }
                let mut listing = match &rebuild.folders {
                    Some(folders) => folders.items()?,
                    None => Vec::new(),
                };
                listing.room(parts_len(&rebuild.rows))?;
                self.folder_items = listing.len();
                let mut end = 0;
                for (rows, part_end) in rebuild.rows.iter().zip(&mut self.ends) {
                    listing.extend_from_slice(rows);
                    end += rows.len();
                    *part_end = end;
                }
                self.scratch = std::mem::replace(&mut self.listing, listing);
                self.largest_match = rebuild.largest;
                self.shown_folder = self.permutation_target();
                self.shown.behind = false;
                self.shown.order = if self.best_match() {
                    ListingOrder::BestMatch
                } else {
                    ListingOrder::Sort
                };
                Ok(true)
            }
            Some(Build::Refine(mut refine)) => {
                if let Some(needle) = &self.search {
                    let count = refine.candidates.as_ref().map_or(refine.end, Vec::len);
                    while refine.at < count && order.spent() < budget.max(1) {
                        let row = refine
                            .candidates
                            .as_ref()
                            .map_or(refine.at, |rows| rows[refine.at] as usize);
                        let (hit, units) = needle.matches_counted(store.name(row));
                        order.charge(units);
                        if hit {
                            refine.bits[row / 64] |= 1 << (row % 64);
                            refine.largest = refine
                                .largest
                                .max(store.value(row, Column::UncompressedSize));
                        }
                        refine.at += 1;
                    }
                    if refine.at < count {
                        self.build = Some(Build::Refine(refine));
                        return Ok(false);
                    }
                }
                let limit = refine.end;
                let bits = &refine.bits;
                // Rows from `end` were matched with the new needle.
                let keep = |row: &u32| {
                    *row as usize >= limit || bits[*row as usize / 64] & (1 << (*row % 64)) != 0
                };
                // A refine is only for a listing with one part.
                self.listing.retain(keep);
                self.ends.fill(self.listing.len() - self.folder_items);
                self.pending[0].retain(keep);
                self.largest_match = refine.largest;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Makes one step of a rebuild, until `order` has spent `budget`
    /// units. Returns true when `rebuild` holds the rows and the folder
    /// items in the sort order.
    fn rebuild_step(
        &mut self,
        tree: &Tree,
        store: &Store,
        order: &Order,
        rebuild: &mut Rebuild,
        budget: usize,
    ) -> Result<bool, Full> {
        loop {
            match rebuild.stage {
                Stage::Rank => {
                    if !self.rank_rows(store, rebuild, order, budget)? {
                        return Ok(false);
                    }
                    rebuild.stage = Stage::Walk;
                }
                Stage::Walk => {
                    if !self.walk_listing(rebuild, order, budget)? {
                        return Ok(false);
                    }
                    rebuild.stage = Stage::Sort;
                }
                Stage::Scan => {
                    let before = rebuild.rows.each_ref().map(Vec::len);
                    let done = self.scan_candidates(store, rebuild, order, budget)?
                        && self.scan_rows(tree, store, &mut rebuild.rows, order, budget)?;
                    if self.search.is_some() {
                        rebuild.largest = rebuild
                            .rows
                            .iter()
                            .zip(before)
                            .flat_map(|(rows, start)| &rows[start..])
                            .map(|&row| store.value(row as usize, Column::UncompressedSize))
                            .fold(rebuild.largest, f64::max);
                    }
                    if !done {
                        return Ok(false);
                    }
                    rebuild.stage = Stage::Sort;
                }
                Stage::Sort => {
                    // Rows come in row order, which is the archive order.
                    if !self.row_sort().is_archive() {
                        while rebuild.sorted < BUCKETS {
                            let part = rebuild.sorted;
                            let mut sort = rebuild.sort.take().unwrap_or_else(|| {
                                let items = std::mem::take(&mut rebuild.rows[part]);
                                let runs = std::mem::take(&mut rebuild.rerank.runs[part]);
                                if runs.is_empty() {
                                    StepSort::new(items)
                                } else {
                                    StepSort::with_runs(items, runs)
                                }
                            });
                            let done = sort.step(
                                order,
                                budget,
                                |row| order.row_weight(row),
                                |a, b| order.rows(a, b),
                            )?;
                            if !done {
                                rebuild.sort = Some(sort);
                                return Ok(false);
                            }
                            rebuild.rows[part] = sort.items;
                            rebuild.sorted += 1;
                        }
                    }
                    if self.search.is_some() {
                        return Ok(true);
                    }
                    // Changes from now on make the folder items again at
                    // the next merge.
                    self.folders_stale = false;
                    rebuild.folders = Some(FolderBuild::new(tree, self.listed));
                    rebuild.stage = Stage::Folders;
                }
                Stage::Folders => {
                    let folders = rebuild
                        .folders
                        .as_mut()
                        .expect("the folder stage has folders");
                    return self.folder_step(folders, order, budget);
                }
            }
        }
    }

    /// Starts a filter of the listing for a longer needle. When it needs
    /// few units of work, it is made at once: then it returns true.
    ///
    /// A best-match listing does not get a filter, because a longer query can
    /// move a row to another tier. It is made again from the same rows that
    /// the filter reads. See `Rerank`.
    fn start_refine(&mut self, tree: &Tree, store: &Store) -> Result<bool, Full> {
        self.work = Work::None;
        self.cancel_merge(tree, store)?;
        let end = self.cursor as usize;
        let taken = self.listing.len() + parts_len(&self.pending);
        // Few results: match only them. Else match the names in row order,
        // which reads the name arena in order.
        let candidates = if taken < end / 8 {
            let mut rows = try_with_capacity(taken)?;
            rows.extend_from_slice(&self.listing);
            self.pending
                .iter()
                .for_each(|part| rows.extend_from_slice(part));
            Some(rows)
        } else {
            None
        };
        if self.best_match() {
            let from = candidates.map_or(RebuildFrom::Listing, RebuildFrom::Candidates);
            return self.start_rebuild(tree, store, from);
        }
        self.build_epoch = self.build_epoch.wrapping_add(1);
        self.build = Some(Build::Refine(Refine {
            bits: try_vec(0, end.div_ceil(64))?,
            candidates,
            at: 0,
            end,
            largest: 0.0,
        }));
        self.build_step(tree, store, self.step_threshold)
    }

    /// Returns the permutation folder of the listing that the current
    /// state makes.
    fn permutation_target(&self) -> u32 {
        if self.search.is_some() {
            NONE
        } else {
            self.listed
        }
    }

    /// Matches a row and adds it to its part when it matches.
    fn take_match(
        &self,
        needle: &Needle,
        row: u32,
        store: &Store,
        rows: &mut Parts,
        order: &Order,
    ) -> Result<(), Full> {
        let name = store.name(row as usize);
        if self.best_match() {
            let (rank, units) = needle.rank_counted(name);
            order.charge(units);
            if let Some(rank) = rank {
                rows[rank.bucket()].try_push(row)?;
            }
        } else {
            let (hit, units) = needle.matches_counted(name);
            order.charge(units);
            if hit {
                rows[0].try_push(row)?;
            }
        }
        Ok(())
    }

    /// Takes the candidates of a rebuild that match, until `order` has spent
    /// `budget` units. Returns true when it read all candidates.
    fn scan_candidates(
        &self,
        store: &Store,
        rebuild: &mut Rebuild,
        order: &Order,
        budget: usize,
    ) -> Result<bool, Full> {
        let Some(needle) = &self.search else {
            return Ok(true);
        };
        let budget = budget.max(1);
        while let Some(&row) = rebuild.candidates.get(rebuild.candidate) {
            if order.spent() >= budget {
                return Ok(false);
            }
            self.take_match(needle, row, store, &mut rebuild.rows, order)?;
            rebuild.candidate += 1;
        }
        Ok(true)
    }

    /// Finds the new part of each row below the cursor, until `order` has
    /// spent `budget` units. Returns true when it read all these rows. Then
    /// the parts have the room for the walk.
    fn rank_rows(
        &self,
        store: &Store,
        rebuild: &mut Rebuild,
        order: &Order,
        budget: usize,
    ) -> Result<bool, Full> {
        let Some(needle) = &self.search else {
            return Ok(true);
        };
        let rerank = &mut rebuild.rerank;
        while rerank.at < rerank.parts.len() {
            if order.spent() >= budget.max(1) {
                return Ok(false);
            }
            let (rank, units) = needle.rank_counted(store.name(rerank.at));
            order.charge(units);
            if let Some(rank) = rank {
                let part = rank.bucket();
                rerank.parts[rerank.at] = u8::try_from(part).expect("a part fits in u8");
                rerank.counts[part] += 1;
                rebuild.largest = rebuild
                    .largest
                    .max(store.value(rerank.at, Column::UncompressedSize));
            }
            rerank.at += 1;
        }
        for (rows, count) in rebuild.rows.iter_mut().zip(rerank.counts) {
            rows.room(count)?;
        }
        Ok(true)
    }

    /// Moves the rows of the old listing and the rows that wait to their new
    /// parts, until `order` has spent `budget` units. The rows of one old part
    /// are one sorted run in each new part. Returns true when it read them.
    fn walk_listing(
        &self,
        rebuild: &mut Rebuild,
        order: &Order,
        budget: usize,
    ) -> Result<bool, Full> {
        let rerank = &mut rebuild.rerank;
        let entries = &self.listing[self.folder_items..];
        while rerank.old_part < 2 * BUCKETS {
            let run: &[u32] = if rerank.old_part < BUCKETS {
                let start = rerank.old_part.checked_sub(1).map_or(0, |at| self.ends[at]);
                &entries[start..self.ends[rerank.old_part]]
            } else {
                &rerank.waiting[rerank.old_part - BUCKETS]
            };
            while let Some(&row) = run.get(rerank.walked) {
                if order.spent() >= budget.max(1) {
                    return Ok(false);
                }
                let part = rerank.parts[row as usize];
                if part != NO_PART {
                    rebuild.rows[usize::from(part)].push(row);
                }
                order.charge(1);
                rerank.walked += 1;
            }
            for (runs, rows) in rerank.runs.iter_mut().zip(&rebuild.rows) {
                if runs.last().copied().unwrap_or(0) < rows.len() {
                    runs.try_push(rows.len())?;
                }
            }
            rerank.old_part += 1;
            rerank.walked = 0;
        }
        rerank.parts = Vec::new();
        rerank.waiting = Parts::default();
        Ok(true)
    }

    /// Takes rows after the cursor, until `order` has spent `budget` units:
    /// new entries of the listed folder, or new rows that match the search.
    /// Returns true when it took all rows that there are now.
    fn scan_rows(
        &mut self,
        tree: &Tree,
        store: &Store,
        rows: &mut Parts,
        order: &Order,
        budget: usize,
    ) -> Result<bool, Full> {
        let budget = budget.max(1);
        if let Some(needle) = &self.search {
            let rows_now = u32::try_from(store.rows()).expect("rows fit in u32");
            let mut cursor = self.cursor;
            while cursor < rows_now && order.spent() < budget {
                self.take_match(needle, cursor, store, rows, order)?;
                cursor += 1;
                self.cursor = cursor;
            }
            Ok(cursor == rows_now)
        } else {
            let mut next = if self.cursor == NONE {
                tree.first_entry(self.listed)
            } else {
                tree.next_entry(self.cursor)
            };
            while next != NONE {
                if order.spent() >= budget {
                    return Ok(false);
                }
                order.charge(1);
                rows[0].try_push(next)?;
                self.cursor = next;
                next = tree.next_entry(next);
            }
            Ok(true)
        }
    }

    /// Takes the new rows into `pending`, sorted.
    fn collect(&mut self, tree: &Tree, store: &Store) -> Result<(), Full> {
        let sort = self.row_sort();
        let order = Order::new(store, tree, sort);
        let mut parts = Parts::default();
        self.scan_rows(tree, store, &mut parts, &order, usize::MAX)?;
        let mut scratch = Vec::new();
        for (pending, rows) in self.pending.iter_mut().zip(&mut parts) {
            if rows.is_empty() {
                continue;
            }
            // Rows come in row order, which is the archive order.
            if !sort.is_archive() {
                rows.sort_unstable_by(|&a, &b| order.rows(a, b));
            }
            merge(pending, 0, rows, &mut scratch, |a, b| order.rows(a, b))?;
        }
        Ok(())
    }

    /// Returns true when a change to the children of `folder` can change
    /// the listing: the folder is the listed folder, or it is on a chain
    /// row of the listing.
    fn changes_listing(&self, tree: &Tree, folder: u32) -> bool {
        if folder == self.listed {
            return true;
        }
        let mut ancestor = tree.parent(folder);
        while ancestor != NONE {
            if ancestor == self.listed {
                return true;
            }
            if !tree.has_one_child(ancestor) {
                return false;
            }
            ancestor = tree.parent(ancestor);
        }
        false
    }

    fn same_table_folder(&self) -> bool {
        self.table.folder == self.shown_folder
    }

    /// Makes the published permutation and its information words from the
    /// listing, with `budget` units of work. Without open folders, the
    /// permutation is the listing. With open folders, a table build starts
    /// and `merge` makes its steps. Returns true when the published
    /// permutation changed.
    /// With `own`, a request started the build, so it waits for it.
    fn update_table(
        &mut self,
        tree: &Tree,
        store: &Store,
        budget: usize,
        own: bool,
    ) -> Result<bool, Full> {
        self.table.stale = false;
        self.table.merge_stale = false;
        let parent = self.shown_folder;
        if parent == NONE || !self.inline.iter().any(|&open| open) {
            self.table.build = None;
            self.publish_listing(tree)?;
            return Ok(true);
        }
        // Until the build ends, the old table shows. Another folder or a
        // listing with no table shows its rows closed.
        let mut changed = false;
        if !self.table.published || self.table.folder != parent {
            self.publish_listing(tree)?;
            changed = true;
        }
        if own {
            self.build_epoch = self.build_epoch.wrapping_add(1);
        }
        self.table.build = Some(TableBuild {
            listing: try_collect(self.listing.iter().copied())?,
            folder: parent,
            at: 0,
            rows: Vec::new(),
            info: Vec::new(),
            stack: Vec::new(),
            entries: None,
        });
        Ok(self.table_step(tree, store, budget)? || changed)
    }

    /// Publishes the listing with the information words of its rows, all
    /// closed.
    fn publish_listing(&mut self, tree: &Tree) -> Result<(), Full> {
        let parent = self.shown_folder;
        // The info words must have the length of the listing before the
        // listing is published, so make room first.
        self.table.info.clear();
        self.table.info.try_resize(self.listing.len(), 0)?;
        let mut info = std::mem::take(&mut self.table.info);
        // Folder items come first. Entry rows at level 0 have no bits.
        for (index, &item) in self.listing.iter().enumerate() {
            if item & FOLDER_TAG == 0 {
                break;
            }
            // The rows of an open folder do not show here.
            info[index] =
                self.folder_info(tree, item & !FOLDER_TAG, parent, 0).0 & !tree_record::EXPANDED;
        }
        self.table.info = info;
        self.table.rows.clear();
        self.table.published = false;
        self.table.folder = parent;
        Ok(())
    }

    /// Returns the work of a table build: the open folder `folder` at
    /// `level`. Its child rows are collected and sorted in steps.
    fn table_frame(tree: &Tree, folder: u32, level: u32) -> TableFrame {
        TableFrame {
            folder,
            level,
            folders: FolderBuild::new(tree, folder),
            sorted: false,
            at: 0,
        }
    }

    /// Makes one step of the table build until about `budget` units of
    /// work are done: the rows of the listing in order, each open folder
    /// followed by its child folders and then its entries, sorted in steps.
    /// When the build ends, the new table replaces the published one: then
    /// it returns true.
    ///
    /// When the memory budget has no room, the build stops and is dropped.
    fn table_step(&mut self, tree: &Tree, store: &Store, budget: usize) -> Result<bool, Full> {
        let Some(mut build) = self.table.build.take() else {
            return Ok(false);
        };
        let order = Order::new(store, tree, self.row_sort());
        let over = || order.spent() >= budget.max(1);
        loop {
            if let Some(entries) = &mut build.entries {
                if !entries.step(
                    &order,
                    budget,
                    |row| order.row_weight(row),
                    |a, b| order.rows(a, b),
                )? {
                    self.table.build = Some(build);
                    return Ok(false);
                }
                let level = build.stack.pop().map_or(0, |frame| frame.level);
                build.rows.try_extend_from_slice(&entries.items)?;
                build
                    .info
                    .try_resize(build.rows.len(), level.min(tree_record::LEVEL_MASK))?;
                build.entries = None;
                continue;
            }
            if over() {
                self.table.build = Some(build);
                return Ok(false);
            }
            // Room for a frame of an open folder row below.
            build.stack.room(1)?;
            if let Some(frame) = build.stack.last_mut() {
                let (folder, level) = (frame.folder, frame.level);
                if !frame.sorted {
                    if !self.folder_step(&mut frame.folders, &order, budget)? {
                        self.table.build = Some(build);
                        return Ok(false);
                    }
                    frame.sorted = true;
                    continue;
                }
                if let Some(&index) = frame.folders.sort.items.get(frame.at) {
                    build.rows.room(1)?;
                    build.info.room(1)?;
                    frame.at += 1;
                    let tail = frame.folders.chains[index as usize].1;
                    let (word, open) = self.folder_info(tree, tail, folder, level);
                    order.charge(1);
                    build.rows.push(tail | FOLDER_TAG);
                    build.info.push(word);
                    if open {
                        build.stack.push(Self::table_frame(tree, tail, level + 1));
                    }
                    continue;
                }
                // The child folders are done: then the entries.
                let count = tree.entry_count(folder) as usize;
                let mut rows: Vec<u32> = try_with_capacity(count)?;
                rows.extend(tree.entries(folder));
                order.charge(rows.len());
                if self.row_sort().is_archive() || rows.len() < 2 {
                    build.stack.pop();
                    build.rows.try_extend_from_slice(&rows)?;
                    build
                        .info
                        .try_resize(build.rows.len(), level.min(tree_record::LEVEL_MASK))?;
                } else {
                    build.entries = Some(StepSort::new(rows));
                }
                continue;
            }
            let Some(&item) = build.listing.get(build.at) else {
                break;
            };
            if item & FOLDER_TAG == 0 {
                // The entries of the listing come last, after its folders.
                let room = budget.max(1).saturating_sub(order.spent()).max(1);
                let end = build.listing.len().min(build.at + room);
                build
                    .rows
                    .try_extend_from_slice(&build.listing[build.at..end])?;
                build.info.try_resize(build.rows.len(), 0)?;
                order.charge(end - build.at);
                build.at = end;
                continue;
            }
            build.rows.room(1)?;
            build.info.room(1)?;
            build.at += 1;
            order.charge(1);
            let tail = item & !FOLDER_TAG;
            let (word, open) = self.folder_info(tree, tail, build.folder, 0);
            build.rows.push(item);
            build.info.push(word);
            if open {
                build.stack.push(Self::table_frame(tree, tail, 1));
            }
        }
        self.table.rows = build.rows;
        self.table.info = build.info;
        self.table.published = true;
        self.table.folder = build.folder;
        Ok(true)
    }

    /// Returns the information word of the table row that ends at `tail`,
    /// below the row of `parent`, and true when the row is open.
    fn folder_info(&self, tree: &Tree, tail: u32, parent: u32, level: u32) -> (u32, bool) {
        let mut extra: u32 = 0;
        let mut open = self.is_inline(tail);
        let mut folder = tail;
        loop {
            let up = tree.parent(folder);
            if up == NONE || up == parent || extra >= tree_record::CHAIN_MASK {
                break;
            }
            folder = up;
            extra += 1;
            open |= self.is_inline(folder);
        }
        let mut word = level.min(tree_record::LEVEL_MASK) | (extra << tree_record::CHAIN_SHIFT);
        let has_children = tree.child_count(tail) > 0 || tree.entry_count(tail) > 0;
        if has_children {
            word |= tree_record::HAS_CHILDREN;
            if open {
                word |= tree_record::EXPANDED;
            }
        }
        (word, open && has_children)
    }

    /// Returns the last folder of the chain row that starts at `head`, the
    /// folders in it minus 1, and true when a folder of it is expanded.
    fn chain(&self, tree: &Tree, head: u32) -> (u32, u32, bool) {
        self.walk_chain(tree, &ArchiveWalk, head)
    }

    /// `chain` for a walk of the tree.
    #[inline]
    fn walk_chain(&self, tree: &Tree, walk: &impl TreeWalk, head: u32) -> (u32, u32, bool) {
        let mut tail = head;
        let mut extra = 0;
        let mut expanded = self.is_expanded(head);
        while tail != ROOT && tail != self.listed && walk.has_one_child(tree, tail) {
            tail = tree.first_child(tail);
            extra += 1;
            expanded |= self.is_expanded(tail);
        }
        (tail, extra, expanded)
    }

    /// Adds one tree record.
    #[inline]
    fn push_row(&mut self, tree: &Tree, walk: &impl TreeWalk, row: &Row) -> Result<(), Full> {
        self.tree.room(TREE_RECORD_WORDS)?;
        let mut info = row.level.min(tree_record::LEVEL_MASK)
            | (row.chain.min(tree_record::CHAIN_MASK) << tree_record::CHAIN_SHIFT);
        if walk.has_children(tree, row.tail) {
            info |= tree_record::HAS_CHILDREN;
            if row.expanded {
                info |= tree_record::EXPANDED;
            }
        }
        self.tree
            .extend([row.tail | FOLDER_TAG, info, row.position, row.size]);
        Ok(())
    }

    /// Makes the flattened tree in the order of the tree.
    fn flatten(&mut self, tree: &Tree) -> Result<(), Full> {
        let order = std::mem::take(&mut self.tree_order);
        let result = match &order {
            TreeOrder::Name(names) => self.flatten_with(tree, names),
            _ => self.flatten_with(tree, &ArchiveWalk),
        };
        self.tree_order = order;
        result
    }

    /// Makes the flattened tree. The stack holds one entry for each level,
    /// at most `MAX_DEPTH` + 1, so its growth is small.
    fn flatten_with(&mut self, tree: &Tree, walk: &impl TreeWalk) -> Result<(), Full> {
        self.tree.clear();
        let root_open = self.is_expanded(ROOT);
        let root = Row {
            tail: ROOT,
            level: 0,
            chain: 0,
            expanded: root_open,
            position: 1,
            size: 1,
        };
        self.push_row(tree, walk, &root)?;
        let mut stack = Vec::new();
        if root_open && tree.child_count(ROOT) > 0 {
            stack.push(Siblings {
                next: walk.first(tree, ROOT),
                level: 1,
                position: 0,
                size: tree.child_count(ROOT),
            });
        }
        while let Some(top) = stack.last_mut() {
            if top.position == top.size {
                stack.pop();
                continue;
            }
            let (head, next) = walk.next(tree, top.next);
            top.next = next;
            top.position += 1;
            let (level, position, size) = (top.level, top.position, top.size);
            let (tail, chain, expanded) = self.walk_chain(tree, walk, head);
            let row = Row {
                tail,
                level,
                chain,
                expanded,
                position,
                size,
            };
            self.push_row(tree, walk, &row)?;
            if expanded && walk.has_children(tree, tail) {
                stack.push(Siblings {
                    next: walk.first(tree, tail),
                    level: level + 1,
                    position: 0,
                    size: tree.child_count(tail),
                });
            }
        }
        Ok(())
    }
}

/// Returns true when `folder` is below `ancestor`.
fn is_below(tree: &Tree, folder: u32, ancestor: u32) -> bool {
    let mut current = tree.parent(folder);
    while current != NONE {
        if current == ancestor {
            return true;
        }
        current = tree.parent(current);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        store: Store,
        tree: Tree,
        views: Views,
        rows: Vec<String>,
    }

    impl Fixture {
        fn new(names: &[&str]) -> Self {
            let mut fixture = Fixture {
                store: Store::new(),
                tree: Tree::new(),
                views: Views::new(),
                rows: Vec::new(),
            };
            fixture.add(names);
            fixture
        }

        fn add(&mut self, names: &[&str]) {
            for name in names {
                self.push(name, 1.0);
            }
            self.refresh();
        }

        fn push(&mut self, name: &str, size: f64) {
            self.push_timed(name, size, f64::NAN);
        }

        fn push_timed(&mut self, name: &str, size: f64, modified: f64) {
            let row = crate::store::Row {
                name: name.as_bytes(),
                uncompressed_size: size,
                compressed_size: size,
                modified,
                ..crate::store::Row::default()
            };
            self.store.push(&row, None).unwrap();
            let index = self.store.rows() - 1;
            self.tree.insert(
                self.store.names(),
                u32::try_from(index).unwrap(),
                name.as_bytes(),
                self.store.name_offset(index),
                size,
                size,
            );
            self.rows.push(name.to_string());
        }

        fn refresh(&mut self) -> bool {
            self.views.refresh(&mut self.tree, &self.store)
        }

        fn folder_name(&self, folder: u32) -> String {
            String::from_utf8_lossy(self.tree.name(self.store.names(), folder)).into_owned()
        }

        /// The names of the folders of a chain row, from `tail` up.
        fn chain_name(&self, tail: u32, extra: u32) -> String {
            let mut parts = Vec::new();
            let mut folder = tail;
            for _ in 0..=extra {
                parts.push(self.folder_name(folder));
                folder = self.tree.parent(folder);
            }
            parts.reverse();
            parts.join("/")
        }

        /// The listing as text: folders end with `/`.
        fn listing(&self) -> Vec<String> {
            self.views
                .listing()
                .iter()
                .map(|&item| {
                    if item & FOLDER_TAG != 0 {
                        let tail = item & !FOLDER_TAG;
                        let mut parts = Vec::new();
                        let mut folder = tail;
                        while folder != self.views.listed() {
                            parts.push(self.folder_name(folder));
                            folder = self.tree.parent(folder);
                        }
                        parts.reverse();
                        format!("{}/", parts.join("/"))
                    } else {
                        self.rows[item as usize].clone()
                    }
                })
                .collect()
        }

        /// The tree as text: indent, name, `+` when collapsed with
        /// children, `-` when expanded, and position/size.
        fn tree(&self) -> Vec<String> {
            self.views
                .tree()
                .chunks(TREE_RECORD_WORDS)
                .map(|record| {
                    let tail = record[0] & !FOLDER_TAG;
                    let info = record[1];
                    let level = info & tree_record::LEVEL_MASK;
                    let extra = (info >> tree_record::CHAIN_SHIFT) & tree_record::CHAIN_MASK;
                    let mark = if info & tree_record::EXPANDED != 0 {
                        "-"
                    } else if info & tree_record::HAS_CHILDREN != 0 {
                        "+"
                    } else {
                        " "
                    };
                    let name = if tail == ROOT {
                        "(root)".to_string()
                    } else {
                        self.chain_name(tail, extra)
                    };
                    format!(
                        "{}{mark}{name} {}/{}",
                        "  ".repeat(level as usize),
                        record[2],
                        record[3]
                    )
                })
                .collect()
        }

        /// The published table as text: indent, `-` for an open folder row,
        /// `+` for a closed one with rows, and the label of the row.
        fn table(&self) -> Vec<String> {
            let permutation = self.views.permutation();
            let info = self.views.permutation_info();
            assert_eq!(permutation.len(), info.len());
            permutation
                .iter()
                .zip(info)
                .map(|(&item, &word)| {
                    let level = word & tree_record::LEVEL_MASK;
                    let indent = "  ".repeat(level as usize);
                    if item & FOLDER_TAG == 0 {
                        let name = &self.rows[item as usize];
                        return format!("{indent} {}", name.rsplit('/').next().unwrap());
                    }
                    let extra = (word >> tree_record::CHAIN_SHIFT) & tree_record::CHAIN_MASK;
                    let mark = if word & tree_record::EXPANDED != 0 {
                        "-"
                    } else if word & tree_record::HAS_CHILDREN != 0 {
                        "+"
                    } else {
                        " "
                    };
                    format!(
                        "{indent}{mark}{}/",
                        self.chain_name(item & !FOLDER_TAG, extra)
                    )
                })
                .collect()
        }

        fn find(&self, path: &str) -> u32 {
            let mut folder = ROOT;
            for part in path.split('/') {
                folder = self
                    .tree
                    .child_folders(folder)
                    .find(|&id| self.folder_name(id) == part)
                    .unwrap();
            }
            folder
        }
    }

    #[test]
    fn folders_open_in_place_in_the_sort_order() {
        let mut fixture = Fixture::new(&["a/x/y/1", "a/2", "a/b/3", "a/b/4", "c", "d/5"]);
        fixture.views.list(&fixture.tree, ROOT);
        fixture.refresh();
        assert_eq!(fixture.table(), ["+a/", "+d/", " c"]);
        let a = fixture.find("a");
        assert!(fixture.views.expand_inline(&fixture.tree, a, true, false));
        fixture.refresh();
        assert_eq!(
            fixture.table(),
            ["-a/", "  +x/y/", "  +b/", "   2", "+d/", " c"]
        );
        // The listing does not change: only the published permutation.
        assert_eq!(fixture.listing(), ["a/", "d/", "c"]);
        fixture.views.set_sort(Sort {
            column: SortColumn::Name,
            descending: true,
        });
        fixture.refresh();
        assert_eq!(
            fixture.table(),
            ["+d/", "-a/", "  +x/y/", "  +b/", "   2", " c"]
        );
        // A chain row opens by its last folder.
        let y = fixture.find("a/x/y");
        fixture.views.expand_inline(&fixture.tree, y, true, false);
        fixture.refresh();
        assert_eq!(
            fixture.table(),
            ["+d/", "-a/", "  -x/y/", "     1", "  +b/", "   2", " c"]
        );
        fixture.views.expand_inline(&fixture.tree, a, false, false);
        fixture.refresh();
        assert_eq!(fixture.table(), ["+d/", "+a/", " c"]);
    }

    #[test]
    fn deep_expansion_opens_every_folder_below() {
        let mut fixture = Fixture::new(&["r/a/b/1", "r/a/c/2", "r/3", "r/e/4"]);
        let r = fixture.find("r");
        assert_eq!(fixture.views.listed(), r);
        let a = fixture.find("r/a");
        fixture.views.expand_inline(&fixture.tree, a, true, true);
        fixture.refresh();
        assert_eq!(
            fixture.table(),
            ["-a/", "  -b/", "     1", "  -c/", "     2", "+e/", " 3"]
        );
        fixture.views.expand_inline(&fixture.tree, a, false, true);
        fixture.views.expand_inline(&fixture.tree, a, true, false);
        fixture.refresh();
        assert_eq!(fixture.table(), ["-a/", "  +b/", "  +c/", "+e/", " 3"]);
        // A new folder lists with all rows closed.
        fixture.views.list(&fixture.tree, a);
        fixture.refresh();
        assert_eq!(fixture.table(), ["+b/", "+c/"]);
    }

    #[test]
    fn open_folders_take_new_rows_at_the_merge() {
        let mut fixture = Fixture::new(&["r/a/1", "r/2"]);
        let a = fixture.find("r/a");
        fixture.views.expand_inline(&fixture.tree, a, true, false);
        fixture.refresh();
        assert_eq!(fixture.table(), ["-a/", "   1", " 2"]);
        fixture.add(&["r/a/3", "r/4"]);
        // The table waits for the merge.
        assert_eq!(fixture.table(), ["-a/", "   1", " 2"]);
        assert!(fixture.views.merge_pending());
        assert!(
            fixture
                .views
                .merge(&fixture.tree, &fixture.store, usize::MAX)
        );
        assert_eq!(fixture.table(), ["-a/", "   1", "   3", " 2", " 4"]);
        assert!(!fixture.views.merge_pending());
    }

    #[test]
    fn a_large_table_is_made_in_steps_and_keeps_the_old_table() {
        let names: Vec<String> = (0..3000).map(|i| format!("r/a/f{i:04}")).collect();
        let mut all: Vec<&str> = names.iter().map(String::as_str).collect();
        all.push("r/b/x");
        all.push("r/top");
        let mut fixture = Fixture::new(&all);
        fixture.views.set_step_threshold(2);
        let a = fixture.find("r/a");
        fixture.views.expand_inline(&fixture.tree, a, true, false);
        fixture.views.set_sort(Sort {
            column: SortColumn::Name,
            descending: true,
        });
        fixture.refresh();
        // The build runs in steps: until it ends, the rows show closed.
        assert!(fixture.views.building());
        let closed = fixture.table();
        assert_eq!(closed.len(), 3);
        assert!(closed.iter().all(|row| !row.starts_with('-')), "{closed:?}");
        let mut steps = 0;
        while fixture.views.merge_pending() {
            fixture.views.merge(&fixture.tree, &fixture.store, 8);
            steps += 1;
        }
        assert!(steps > 10, "{steps} steps");
        let mut expected = vec!["+b/".to_string(), "-a/".to_string()];
        expected.extend((0..3000).rev().map(|i| format!("   f{i:04}")));
        expected.push(" top".to_string());
        assert_eq!(fixture.table(), expected);

        // A new sort keeps the old table until the new one is made.
        fixture.views.set_sort(Sort {
            column: SortColumn::Name,
            descending: false,
        });
        fixture.refresh();
        assert!(fixture.views.building());
        assert_eq!(fixture.table(), expected);
        while fixture.views.merge_pending() {
            fixture.views.merge(&fixture.tree, &fixture.store, 8);
        }
        let mut sorted = vec!["-a/".to_string()];
        sorted.extend((0..3000).map(|i| format!("   f{i:04}")));
        sorted.push("+b/".to_string());
        sorted.push(" top".to_string());
        assert_eq!(fixture.table(), sorted);
    }

    #[test]
    fn many_child_folders_of_an_open_folder_sort_in_steps() {
        let names: Vec<String> = (0..5000).map(|i| format!("r/a/d{i:04}/x")).collect();
        let mut all: Vec<&str> = names.iter().map(String::as_str).collect();
        all.push("r/top");
        let mut fixture = Fixture::new(&all);
        fixture.views.set_step_threshold(64);
        fixture.views.set_sort(Sort {
            column: SortColumn::Name,
            descending: true,
        });
        while fixture.refresh() && fixture.views.merge_pending() {
            fixture
                .views
                .merge(&fixture.tree, &fixture.store, usize::MAX);
        }
        let a = fixture.find("r/a");
        fixture.views.expand_inline(&fixture.tree, a, true, false);
        fixture.refresh();
        // `refresh` does a small part of the work, and each merge another.
        assert!(fixture.views.building());
        let mut steps = 0;
        while fixture.views.merge_pending() {
            fixture.views.merge(&fixture.tree, &fixture.store, 64);
            steps += 1;
        }
        assert!(steps > 100, "{steps} steps");
        let table = fixture.table();
        assert_eq!(table.len(), 5002);
        assert_eq!(table[0], "-a/");
        assert_eq!(table[1], "  +d4999/");
        assert_eq!(table[5000], "  +d0000/");
        assert_eq!(table[5001], " top");
    }

    #[test]
    fn rows_that_arrive_during_the_first_table_build_show() {
        let names: Vec<String> = (0..3000).map(|i| format!("r/big/sub/f{i:04}")).collect();
        let mut all: Vec<&str> = names.iter().map(String::as_str).collect();
        // An entry of `big`, so that `big` is not a chain with `sub` and a
        // row in `sub` does not change the listing.
        all.push("r/big/file");
        all.push("r/top");
        let mut fixture = Fixture::new(&all);
        fixture.views.set_sort(Sort {
            column: SortColumn::Name,
            descending: false,
        });
        while fixture.refresh() && fixture.views.merge_pending() {
            fixture
                .views
                .merge(&fixture.tree, &fixture.store, usize::MAX);
        }
        fixture.views.set_step_threshold(16);
        let big = fixture.find("r/big");
        fixture.views.expand_inline(&fixture.tree, big, true, true);
        fixture.refresh();
        assert!(fixture.views.building());
        // The build has taken the rows of `sub` and sorts them in steps.
        // Then a late row arrives in it.
        for _ in 0..10 {
            fixture.views.merge(&fixture.tree, &fixture.store, 64);
        }
        assert!(fixture.views.building());
        fixture.add(&["r/big/sub/late"]);
        while fixture.views.merge_pending() {
            fixture.views.merge(&fixture.tree, &fixture.store, 64);
        }
        let table = fixture.table();
        assert!(
            table.iter().any(|row| row.trim() == "late"),
            "the late row is missing"
        );
        assert_eq!(table, fresh_table(&fixture, &[big]));
    }

    /// The table that a new fixture with the same rows and the same open
    /// folders makes in one step.
    fn fresh_table(fixture: &Fixture, open: &[u32]) -> Vec<String> {
        let names: Vec<&str> = fixture.rows.iter().map(String::as_str).collect();
        let mut fresh = Fixture::new(&names);
        fresh.views.list(&fresh.tree, fixture.views.listed());
        fresh.views.set_sort(fixture.views.sort());
        for &folder in open {
            fresh.views.expand_inline(&fresh.tree, folder, true, true);
        }
        fresh.refresh();
        while fresh.views.merge_pending() {
            fresh.views.merge(&fresh.tree, &fresh.store, usize::MAX);
        }
        fresh.table()
    }

    #[test]
    fn a_table_built_while_rows_arrive_equals_a_fresh_table() {
        for descending in [false, true] {
            let mut seed = 11;
            // The folders exist before the deep open: a deep open opens the
            // folders that exist then.
            let mut fixture =
                Fixture::new(&["r/a/0", "r/a/x/0", "r/a/y/z/0", "r/a/y/0", "r/b/0", "r/top"]);
            fixture.views.set_step_threshold(8);
            fixture.views.set_sort(Sort {
                column: SortColumn::Name,
                descending,
            });
            let r = fixture.find("r");
            fixture.views.list(&fixture.tree, r);
            fixture.refresh();
            let a = fixture.find("r/a");
            fixture.views.expand_inline(&fixture.tree, a, true, true);
            fixture.refresh();
            for batch in 0..60 {
                let names: Vec<String> = (0..20)
                    .map(|i| {
                        let folder = ["a", "a/x", "a/y/z", "b", ""][(next(&mut seed) % 5) as usize];
                        let leaf = format!("n{batch:02}-{i:02}");
                        if folder.is_empty() {
                            format!("r/{leaf}")
                        } else {
                            format!("r/{folder}/{leaf}")
                        }
                    })
                    .collect();
                let refs: Vec<&str> = names.iter().map(String::as_str).collect();
                fixture.add(&refs);
                // As the parse loop: a few merge steps between batches.
                for _ in 0..(next(&mut seed) % 4) {
                    fixture.views.merge(&fixture.tree, &fixture.store, 32);
                }
            }
            // The final merges, as when parsing ends.
            while fixture.views.merge_pending() {
                fixture.views.merge(&fixture.tree, &fixture.store, 32);
            }
            assert_eq!(
                fixture.table(),
                fresh_table(&fixture, &[a]),
                "descending {descending}"
            );
        }
    }

    #[test]
    fn a_table_in_steps_equals_a_table_in_one_step() {
        let mut seed = 7;
        let names: Vec<String> = (0..300)
            .map(|_| {
                let depth = next(&mut seed) % 4;
                let mut path = String::new();
                for _ in 0..depth {
                    path.push('d');
                    path.push(char::from(
                        b'0' + u8::try_from(next(&mut seed) % 3).unwrap(),
                    ));
                    path.push('/');
                }
                format!("{path}n{}", next(&mut seed) % 1000)
            })
            .collect();
        let all: Vec<&str> = names.iter().map(String::as_str).collect();
        let build = |budget: usize, threshold: usize| {
            let mut fixture = Fixture::new(&all);
            fixture.views.list(&fixture.tree, ROOT);
            fixture.views.set_step_threshold(threshold);
            fixture.views.set_sort(Sort {
                column: SortColumn::Name,
                descending: false,
            });
            fixture.refresh();
            while fixture.views.merge_pending() {
                fixture
                    .views
                    .merge(&fixture.tree, &fixture.store, usize::MAX);
            }
            fixture.views.expand_inline(&fixture.tree, ROOT, true, true);
            fixture.refresh();
            while fixture.views.merge_pending() {
                fixture.views.merge(&fixture.tree, &fixture.store, budget);
            }
            fixture.table()
        };
        let whole = build(usize::MAX, STEP_THRESHOLD);
        assert!(whole.len() > 300);
        assert_eq!(build(3, 1), whole);
    }

    #[test]
    fn search_results_have_no_open_rows() {
        let mut fixture = Fixture::new(&["r/a/1", "r/2"]);
        let a = fixture.find("r/a");
        fixture.views.expand_inline(&fixture.tree, a, true, false);
        fixture.refresh();
        fixture.views.set_search(b"1");
        fixture.refresh();
        assert_eq!(fixture.table(), [" 1"]);
        fixture.views.set_search(b"");
        fixture.refresh();
        assert_eq!(fixture.table(), ["-a/", "   1", " 2"]);
    }

    #[test]
    fn lands_at_the_end_of_the_root_chain() {
        let fixture = Fixture::new(&["p/src/main/a.rs", "p/src/main/b.rs", "p/src/test/c.rs"]);
        assert_eq!(fixture.views.listed(), fixture.find("p/src"));
        assert_eq!(fixture.listing(), ["main/", "test/"]);
        assert_eq!(
            fixture.tree(),
            [
                "-(root) 1/1",
                "  -p/src 1/1",
                "     main 1/2",
                "     test 2/2"
            ]
        );
    }

    #[test]
    fn the_landing_moves_up_when_the_chain_splits() {
        let mut fixture = Fixture::new(&["p/src/a"]);
        assert_eq!(fixture.views.listed(), fixture.find("p/src"));
        fixture.add(&["p/README"]);
        assert_eq!(fixture.views.listed(), fixture.find("p"));
        assert_eq!(fixture.listing(), ["src/", "p/README"]);
        fixture.add(&["top"]);
        assert_eq!(fixture.views.listed(), ROOT);
        assert_eq!(fixture.listing(), ["p/", "top"]);
        assert_eq!(fixture.tree(), ["-(root) 1/1", "  -p 1/1", "     src 1/1"]);
    }

    #[test]
    fn table_chains_compact_and_split() {
        let mut fixture = Fixture::new(&["a", "x/y/z/f"]);
        assert_eq!(fixture.views.listed(), ROOT);
        assert_eq!(fixture.listing(), ["x/y/z/", "a"]);
        fixture.add(&["x/y/g"]);
        assert_eq!(fixture.listing(), ["x/y/", "a"]);
        // An explicit row does not stop a chain.
        fixture.add(&["x/"]);
        assert_eq!(fixture.listing(), ["x/y/", "a"]);
    }

    #[test]
    fn an_empty_folder_chain_grows_when_a_child_arrives() {
        let mut fixture = Fixture::new(&["a", "e/"]);
        assert_eq!(fixture.listing(), ["e/", "a"]);
        fixture.add(&["e/f/x"]);
        assert_eq!(fixture.listing(), ["e/f/", "a"]);
    }

    #[test]
    fn selecting_a_folder_stops_following_and_shows_its_row() {
        let mut fixture = Fixture::new(&["a/b/c/d/f", "z"]);
        let c = fixture.find("a/b/c");
        assert!(fixture.views.list(&fixture.tree, c));
        fixture.refresh();
        assert_eq!(fixture.listing(), ["d/"]);
        // The listed folder ends its chain row.
        assert_eq!(
            fixture.tree(),
            ["-(root) 1/1", "  -a/b/c 1/1", "     d 1/1"]
        );
        fixture.add(&["y/q"]);
        assert_eq!(fixture.views.listed(), c);
        assert!(!fixture.views.list(&fixture.tree, 99));
    }

    #[test]
    fn expanding_a_chain_row_keeps_it_open_when_the_chain_splits() {
        let mut fixture = Fixture::new(&["top", "a/b/c/1", "a/b/c/2"]);
        assert_eq!(fixture.tree(), ["-(root) 1/1", "   a/b/c 1/1"]);
        fixture.add(&["a/b/c/d/3"]);
        assert_eq!(fixture.tree(), ["-(root) 1/1", "  +a/b/c 1/1"]);
        let c = fixture.find("a/b/c");
        assert!(fixture.views.expand(&fixture.tree, c, true));
        fixture.refresh();
        assert_eq!(
            fixture.tree(),
            ["-(root) 1/1", "  -a/b/c 1/1", "     d 1/1"]
        );
        fixture.add(&["a/b/x/4"]);
        assert_eq!(
            fixture.tree(),
            [
                "-(root) 1/1",
                "  -a/b 1/1",
                "    -c 1/2",
                "       d 1/1",
                "     x 2/2"
            ]
        );
        // Collapse the row: all its folders close.
        let b = fixture.find("a/b");
        fixture.views.expand(&fixture.tree, b, false);
        fixture.refresh();
        assert_eq!(fixture.tree(), ["-(root) 1/1", "  +a/b 1/1"]);
    }

    #[test]
    fn collapsing_a_row_above_the_listed_folder_selects_it() {
        let mut fixture = Fixture::new(&["a/one/x", "a/two/y", "b/z"]);
        let a = fixture.find("a");
        let one = fixture.find("a/one");
        fixture.views.list(&fixture.tree, one);
        fixture.refresh();
        let version = fixture.views.listing_version();
        fixture.views.expand(&fixture.tree, a, false);
        fixture.refresh();
        assert_eq!(fixture.views.listed(), a);
        assert_ne!(fixture.views.listing_version(), version);
        assert_eq!(fixture.tree(), ["-(root) 1/1", "  +a 1/2", "   b 2/2"]);
        // Collapsing another row does not change the selection.
        fixture.views.expand(&fixture.tree, ROOT, false);
        fixture.refresh();
        assert_eq!(fixture.views.listed(), ROOT);
    }

    #[test]
    fn the_largest_item_is_an_entry_or_a_child_rollup() {
        let mut fixture = Fixture::new(&["top"]);
        assert_eq!(fixture.views.listing_largest(&fixture.tree), 1.0);
        fixture.add(&["d/1", "d/2", "d/e/3"]);
        assert_eq!(fixture.views.listed(), ROOT);
        assert_eq!(fixture.views.listing_largest(&fixture.tree), 3.0);
    }

    #[test]
    fn versions_change_only_with_their_view() {
        let mut fixture = Fixture::new(&["a/b/c", "x"]);
        let (listing, tree) = (
            fixture.views.listing_version(),
            fixture.views.tree_version(),
        );
        fixture.refresh();
        assert_eq!(fixture.views.listing_version(), listing);
        assert_eq!(fixture.views.tree_version(), tree);
        let b = fixture.find("a/b");
        fixture.views.expand(&fixture.tree, b, true);
        fixture.refresh();
        assert_eq!(fixture.views.listing_version(), listing);
        assert_ne!(fixture.views.tree_version(), tree);
    }

    #[test]
    fn collapsing_the_root_hides_every_row() {
        let mut fixture = Fixture::new(&["a/1", "b/2"]);
        fixture.views.expand(&fixture.tree, ROOT, false);
        fixture.refresh();
        assert_eq!(fixture.tree(), ["+(root) 1/1"]);
    }

    #[test]
    fn an_empty_archive_has_one_root_row() {
        let mut fixture = Fixture::new(&[]);
        fixture.refresh();
        assert_eq!(fixture.tree(), [" (root) 1/1"]);
        assert_eq!(fixture.listing(), Vec::<String>::new());
    }

    #[test]
    fn refresh_does_no_work_without_changes() {
        let mut fixture = Fixture::new(&["a/b"]);
        assert!(!fixture.refresh());
    }

    fn sort(column: SortColumn, descending: bool) -> Sort {
        Sort { column, descending }
    }

    #[test]
    fn sorts_folders_then_entries() {
        let mut fixture = Fixture::new(&[]);
        for (name, size) in [
            ("b.txt", 5.0),
            ("A/x", 1.0),
            ("c/y", 9.0),
            ("a.txt", 7.0),
            ("B/z/q", 3.0),
        ] {
            fixture.push(name, size);
        }
        fixture.refresh();
        assert_eq!(fixture.listing(), ["A/", "c/", "B/z/", "b.txt", "a.txt"]);
        fixture.views.set_sort(sort(SortColumn::Name, false));
        fixture.refresh();
        assert_eq!(fixture.listing(), ["A/", "B/z/", "c/", "a.txt", "b.txt"]);
        fixture.views.set_sort(sort(SortColumn::Size, true));
        fixture.refresh();
        assert_eq!(fixture.listing(), ["c/", "B/z/", "A/", "a.txt", "b.txt"]);
        fixture.views.set_sort(sort(SortColumn::Archive, true));
        fixture.refresh();
        assert_eq!(fixture.listing(), ["B/z/", "c/", "A/", "a.txt", "b.txt"]);
    }

    #[test]
    fn missing_values_come_last_in_both_directions() {
        let mut fixture = Fixture::new(&[]);
        fixture.push("empty", 0.0);
        fixture.push("half", 4.0);
        fixture.push("also-empty", 0.0);
        fixture.refresh();
        for descending in [false, true] {
            fixture.views.set_sort(sort(SortColumn::Ratio, descending));
            fixture.refresh();
            assert_eq!(fixture.listing(), ["half", "empty", "also-empty"]);
        }
    }

    #[test]
    fn search_lists_matching_rows_of_the_whole_archive() {
        let mut fixture =
            Fixture::new(&["src/Main.rs", "docs/main.md", "x/y/", "other", "x/y/z/MAIN"]);
        fixture.views.set_search(b"MAIN");
        fixture.refresh();
        assert_eq!(fixture.views.permutation_folder(), NONE);
        // The user chose no sort: the exact name first, then all sizes are 1.
        assert_eq!(
            fixture.listing(),
            ["x/y/z/MAIN", "src/Main.rs", "docs/main.md"]
        );
        // A choice, also archive order, keeps its order.
        fixture.views.set_sort(Sort::default());
        fixture.refresh();
        assert_eq!(
            fixture.listing(),
            ["src/Main.rs", "docs/main.md", "x/y/z/MAIN"]
        );
        // A folder entry is a row too.
        fixture.views.set_search(b"y/");
        fixture.refresh();
        assert_eq!(fixture.listing(), ["x/y/", "x/y/z/MAIN"]);
        fixture.views.set_search(b"");
        fixture.refresh();
        assert_eq!(fixture.views.permutation_folder(), ROOT);
        assert_eq!(fixture.listing(), ["src/", "docs/", "x/y/z/", "other"]);
    }

    #[test]
    fn a_sort_waits_for_the_merge_and_archive_order_does_not() {
        let mut fixture = Fixture::new(&["b", "d"]);
        fixture.add(&["c"]);
        assert_eq!(fixture.listing(), ["b", "d", "c"]);
        assert!(!fixture.views.merge_pending());
        fixture.views.set_sort(sort(SortColumn::Name, false));
        fixture.refresh();
        assert_eq!(fixture.listing(), ["b", "c", "d"]);
        let version = fixture.views.listing_version();
        fixture.add(&["a", "e"]);
        // The new rows wait. The listing that shows stays sorted.
        assert_eq!(fixture.listing(), ["b", "c", "d"]);
        assert_eq!(fixture.views.listing_version(), version);
        assert!(fixture.views.merge_pending());
        assert!(
            fixture
                .views
                .merge(&fixture.tree, &fixture.store, usize::MAX)
        );
        assert_eq!(fixture.listing(), ["a", "b", "c", "d", "e"]);
        assert!(!fixture.views.merge_pending());
        assert!(
            !fixture
                .views
                .merge(&fixture.tree, &fixture.store, usize::MAX)
        );
    }

    #[test]
    fn a_merge_in_steps_keeps_the_listing_until_it_ends() {
        let mut fixture = Fixture::new(&["d", "b"]);
        fixture.views.set_sort(sort(SortColumn::Name, true));
        fixture.refresh();
        fixture.add(&["a", "c", "e"]);
        // A budget of 1 unit places one row in each call.
        assert!(!fixture.views.merge(&fixture.tree, &fixture.store, 1));
        assert_eq!(fixture.listing(), ["d", "b"]);
        // A row that arrives during the merge waits for the next merge.
        fixture.add(&["f"]);
        assert!(!fixture.views.merge(&fixture.tree, &fixture.store, 1));
        assert!(fixture.views.merge(&fixture.tree, &fixture.store, 1));
        assert_eq!(fixture.listing(), ["e", "d", "c", "b", "a"]);
        assert!(fixture.views.merge_pending());
        assert!(fixture.views.merge(&fixture.tree, &fixture.store, 1));
        assert_eq!(fixture.listing(), ["f", "e", "d", "c", "b", "a"]);
        assert!(!fixture.views.merge_pending());
    }

    #[test]
    fn folder_sizes_sort_again_when_rollups_grow() {
        let mut fixture = Fixture::new(&[]);
        fixture.push("a/1", 5.0);
        fixture.push("b/1", 3.0);
        fixture.refresh();
        fixture.views.set_sort(sort(SortColumn::Size, true));
        fixture.refresh();
        assert_eq!(fixture.listing(), ["a/", "b/"]);
        fixture.push("b/2", 4.0);
        fixture.refresh();
        assert!(fixture.views.merge_pending());
        fixture
            .views
            .merge(&fixture.tree, &fixture.store, usize::MAX);
        assert_eq!(fixture.listing(), ["b/", "a/"]);
    }

    /// Returns the listing that a new fixture makes for the same rows and
    /// query in one step, as text and as tagged indexes.
    fn from_scratch(fixture: &Fixture, query: &[u8]) -> (Vec<String>, Vec<u32>) {
        let mut scratch = Fixture::new(&[]);
        for row in 0..fixture.store.rows() {
            let size = fixture.store.value(row, Column::UncompressedSize);
            let modified = fixture.store.value(row, Column::Modified);
            scratch.push_timed(&fixture.rows[row].clone(), size, modified);
        }
        scratch.views.list(&scratch.tree, fixture.views.listed());
        if fixture.views.source == SortSource::Chosen {
            scratch.views.set_sort(fixture.views.sort());
        }
        scratch.views.set_search(query);
        scratch.refresh();
        while scratch.views.merge_pending() {
            scratch
                .views
                .merge(&scratch.tree, &scratch.store, usize::MAX);
        }
        (scratch.listing(), scratch.views.listing().to_vec())
    }

    #[test]
    fn incremental_sort_and_search_equal_one_step() {
        let parts = ["a", "B", "c", "ab"];
        let columns = [
            SortColumn::Archive,
            SortColumn::Name,
            SortColumn::Size,
            SortColumn::Compressed,
            SortColumn::Ratio,
            SortColumn::Method,
            SortColumn::Modified,
        ];
        let queries: [&[u8]; 4] = [b"", b"a", b"AB", b"b/"];
        // At once, and in steps of small budgets.
        for threshold in [STEP_THRESHOLD, 0, 3] {
            for start in 1..300u64 {
                let mut seed = start.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
                let mut fixture = Fixture::new(&[]);
                fixture.views.set_step_threshold(threshold);
                let mut query: &[u8] = b"";
                for step in 0..12 {
                    for _ in 0..(next(&mut seed) % 9) {
                        let depth = next(&mut seed) % 3;
                        let mut name: Vec<&str> = (0..depth)
                            .map(|_| parts[(next(&mut seed) % 4) as usize])
                            .collect();
                        name.push(parts[(next(&mut seed) % 4) as usize]);
                        let mut name = name.join("/");
                        // Folder entries, also after their folder exists,
                        // give folders a late modified time.
                        if next(&mut seed).is_multiple_of(4) {
                            name.push('/');
                        }
                        let size = f64::from(u32::try_from(next(&mut seed) % 4).unwrap());
                        let modified = match next(&mut seed) % 5 {
                            0 => f64::NAN,
                            time => f64::from(u32::try_from(time).unwrap()),
                        };
                        fixture.push_timed(&name, size, modified);
                    }
                    fixture.refresh();
                    match next(&mut seed) % 6 {
                        0 => {
                            let column = columns[(next(&mut seed) % 7) as usize];
                            fixture
                                .views
                                .set_sort(sort(column, next(&mut seed).is_multiple_of(2)));
                            fixture.refresh();
                        }
                        1 => {
                            query = queries[(next(&mut seed) % 4) as usize];
                            fixture.views.set_search(query);
                            fixture.refresh();
                        }
                        2 => {
                            // A small budget can leave a merge or a build
                            // in steps open.
                            let budget = usize::try_from(next(&mut seed) % 40).unwrap();
                            fixture.views.merge(&fixture.tree, &fixture.store, budget);
                        }
                        _ => {}
                    }
                    if fixture.views.building() {
                        // The old listing shows until the build ends.
                        continue;
                    }
                    // The entry rows that show are always a sorted part of
                    // the result. Folder rows can wait for the merge: their
                    // sizes and chains change while rows arrive.
                    let entries = |listing: &[u32]| -> Vec<u32> {
                        listing
                            .iter()
                            .copied()
                            .filter(|item| item & FOLDER_TAG == 0)
                            .collect()
                    };
                    let shown = entries(fixture.views.listing());
                    let full = entries(&from_scratch(&fixture, query).1);
                    let mut at = 0;
                    for item in &shown {
                        let found = full[at..].iter().position(|other| other == item);
                        assert!(
                            found.is_some(),
                            "threshold {threshold} seed {start} step {step}: {item} out of order"
                        );
                        at += found.unwrap() + 1;
                    }
                }
                while fixture.views.merge_pending() {
                    fixture.views.merge(&fixture.tree, &fixture.store, 7);
                }
                assert_eq!(
                    fixture.listing(),
                    from_scratch(&fixture, query).0,
                    "threshold {threshold} seed {start}"
                );
                assert_eq!(
                    fixture.views.permutation_folder(),
                    if query.is_empty() {
                        fixture.views.listed()
                    } else {
                        NONE
                    }
                );
            }
        }
    }

    #[test]
    fn a_late_folder_entry_sorts_its_folder_again_by_time() {
        // A newer `a/` after `a/file` must move `a/` first.
        let mut fixture = Fixture::new(&[]);
        fixture.views.set_sort(sort(SortColumn::Modified, true));
        fixture.push_timed("a/file", 1.0, 1.0);
        fixture.push_timed("b/", 0.0, 5.0);
        fixture.push_timed("b/file", 1.0, 1.0);
        fixture.refresh();
        fixture
            .views
            .merge(&fixture.tree, &fixture.store, usize::MAX);
        assert_eq!(fixture.listing(), ["b/", "a/"]);
        fixture.push_timed("a/", 0.0, 9.0);
        fixture.refresh();
        while fixture.views.merge_pending() {
            fixture
                .views
                .merge(&fixture.tree, &fixture.store, usize::MAX);
        }
        assert_eq!(fixture.listing(), ["a/", "b/"]);
        assert_eq!(fixture.listing(), from_scratch(&fixture, b"").0);
        // The same in a listed sub folder.
        fixture.push_timed("b/c/file", 1.0, 1.0);
        fixture.push_timed("b/d/file", 1.0, 1.0);
        let b = fixture
            .tree
            .child_folders(ROOT)
            .find(|&folder| fixture.folder_name(folder) == "b")
            .unwrap();
        fixture.views.list(&fixture.tree, b);
        fixture.refresh();
        while fixture.views.merge_pending() {
            fixture
                .views
                .merge(&fixture.tree, &fixture.store, usize::MAX);
        }
        assert_eq!(fixture.listing(), ["c/", "d/", "b/file"]);
        fixture.push_timed("b/d/", 0.0, 7.0);
        fixture.refresh();
        while fixture.views.merge_pending() {
            fixture
                .views
                .merge(&fixture.tree, &fixture.store, usize::MAX);
        }
        assert_eq!(fixture.listing(), ["d/", "c/", "b/file"]);
        assert_eq!(fixture.listing(), from_scratch(&fixture, b"").0);
    }

    #[test]
    fn a_large_rebuild_runs_in_steps_and_keeps_the_old_listing() {
        let mut fixture = Fixture::new(&[]);
        for index in 0..5000 {
            fixture.push(&format!("f{:04}", (index * 7919) % 5000), 1.0);
        }
        fixture.refresh();
        fixture.views.set_step_threshold(100);
        let before = fixture.views.listing().to_vec();
        fixture.views.set_sort(sort(SortColumn::Name, true));
        fixture.views.set_search(b"F");
        let epoch = fixture.views.build_epoch();
        assert!(!fixture.refresh() || fixture.views.listing() == before.as_slice());
        assert!(fixture.views.building());
        assert_ne!(fixture.views.build_epoch(), epoch);
        // A new listing replaces the one in steps, with a new epoch.
        let epoch = fixture.views.build_epoch();
        fixture.views.set_sort(sort(SortColumn::Name, false));
        fixture.refresh();
        assert!(fixture.views.building());
        assert_ne!(fixture.views.build_epoch(), epoch);
        fixture.views.set_sort(sort(SortColumn::Name, true));
        fixture.refresh();
        assert_eq!(fixture.views.permutation_folder(), ROOT);
        let mut steps = 0;
        while !fixture.views.merge(&fixture.tree, &fixture.store, 2000) {
            assert_eq!(fixture.views.listing(), before.as_slice());
            steps += 1;
        }
        assert!(steps > 10, "{steps} steps");
        assert!(!fixture.views.building());
        assert_eq!(fixture.views.permutation_folder(), NONE);
        assert_eq!(fixture.listing(), from_scratch(&fixture, b"F").0);
        // A longer needle filters in steps too.
        fixture.views.set_search(b"F00");
        fixture.refresh();
        assert!(fixture.views.building());
        while !fixture.views.merge(&fixture.tree, &fixture.store, 500) {}
        assert_eq!(fixture.listing(), from_scratch(&fixture, b"F00").0);
    }

    #[test]
    fn a_longer_query_filters_the_listing_in_its_order() {
        let mut fixture = Fixture::new(&[]);
        for (name, size) in [("abc", 1.0), ("xabd", 9.0), ("ABZ", 5.0), ("q", 2.0)] {
            fixture.push(name, size);
        }
        fixture.refresh();
        fixture.views.set_sort(sort(SortColumn::Size, true));
        fixture.views.set_search(b"ab");
        fixture.refresh();
        assert_eq!(fixture.listing(), ["xabd", "ABZ", "abc"]);
        assert_eq!(fixture.views.listing_largest(&fixture.tree), 9.0);
        fixture.views.set_search(b"abz");
        fixture.refresh();
        assert_eq!(fixture.listing(), ["ABZ"]);
        assert_eq!(fixture.views.listing_largest(&fixture.tree), 5.0);
    }

    /// A small random generator, so the test needs no dependency.
    fn next(seed: &mut u64) -> u64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    }

    #[test]
    fn incremental_views_equal_views_made_from_scratch() {
        let parts = ["a", "b", "c"];
        for start in 1..40u64 {
            let mut seed = start.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
            let mut names = Vec::new();
            for _ in 0..60 {
                let depth = next(&mut seed) % 4;
                let mut name: Vec<&str> = (0..depth)
                    .map(|_| parts[(next(&mut seed) % 3) as usize])
                    .collect();
                name.push(if next(&mut seed).is_multiple_of(5) {
                    ""
                } else {
                    "f"
                });
                names.push(name.join("/"));
            }
            let names: Vec<&str> = names.iter().map(String::as_str).collect();
            let mut fixture = Fixture::new(&[]);
            let mut selected = None;
            for (index, batch) in names
                .chunks(1 + usize::try_from(start % 5).unwrap())
                .enumerate()
            {
                fixture.add(batch);
                if index == 3 {
                    let count = u64::try_from(fixture.tree.folder_count()).unwrap();
                    let folder = u32::try_from(next(&mut seed) % count).unwrap();
                    fixture.views.list(&fixture.tree, folder);
                    fixture.views.expand(&fixture.tree, folder, true);
                    fixture.refresh();
                    selected = Some(folder);
                }
            }
            let mut scratch = Fixture::new(&names);
            if let Some(folder) = selected {
                scratch.views.list(&scratch.tree, folder);
                scratch.views.expanded = fixture.views.expanded.clone();
                scratch.views.tree_dirty = true;
                scratch.refresh();
            }
            assert_eq!(fixture.listing(), scratch.listing(), "seed {start}");
            assert_eq!(
                fixture.views.listed(),
                scratch.views.listed(),
                "seed {start}"
            );
            assert_eq!(fixture.tree(), scratch.tree(), "seed {start}");
        }
    }

    /// The largest files as names.
    fn largest(fixture: &Fixture) -> Vec<String> {
        fixture
            .views
            .largest_files()
            .iter()
            .map(|&row| fixture.rows[row as usize].clone())
            .collect()
    }

    /// The largest files below `folder`, from all rows: the rule of
    /// `largest` without its scan.
    fn largest_from_scratch(fixture: &Fixture, folder: u32) -> Vec<u32> {
        let mut files: Vec<(f64, u32)> = (0..fixture.rows.len())
            .filter_map(|row| {
                let row = u32::try_from(row).unwrap();
                let size = fixture.store.value(row as usize, Column::UncompressedSize);
                let mut at = fixture.tree.row_folder(row);
                if at & FOLDER_TAG != 0 || size <= 0.0 {
                    return None;
                }
                while at != folder && at != NONE {
                    at = fixture.tree.parent(at);
                }
                (at == folder).then_some((size, row))
            })
            .collect();
        files.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        files.iter().take(10).map(|&(_, row)| row).collect()
    }

    #[test]
    fn largest_files_rank_the_files_of_the_whole_subtree() {
        let mut fixture = Fixture::new(&[]);
        for (name, size) in [
            ("app/small.txt", 1.0),
            ("app/src/big.bin", 50.0),
            ("app/src/deep/huge.bin", 90.0),
            ("app/src/deep/", 500.0),
            ("app/src/deep/", 400.0),
            ("app/empty.txt", 0.0),
            ("app/src/tie-a", 50.0),
            ("other/outside.bin", 1000.0),
            ("app/src/deep/tie-b", 50.0),
        ] {
            fixture.push(name, size);
        }
        fixture.refresh();
        let app = fixture.find("app");
        fixture.views.list(&fixture.tree, app);
        fixture.refresh();
        // Not the explicit row of a folder, the empty file or the file
        // outside. A second folder entry is an entry of its folder. The
        // same size keeps archive order.
        assert_eq!(
            largest(&fixture),
            [
                "app/src/deep/",
                "app/src/deep/huge.bin",
                "app/src/big.bin",
                "app/src/tie-a",
                "app/src/deep/tie-b",
                "app/small.txt",
            ]
        );
        // The root has all files.
        fixture.views.list(&fixture.tree, ROOT);
        fixture.refresh();
        assert_eq!(largest(&fixture)[0], "other/outside.bin");
        // A search lists no folder, so it has no largest files.
        fixture.views.set_search(b"bin");
        fixture.refresh();
        assert_eq!(largest(&fixture), Vec::<String>::new());
        fixture.views.set_search(b"");
        fixture.refresh();
        assert_eq!(largest(&fixture).len(), 7);
    }

    #[test]
    fn largest_files_count_direct_entries_and_need_files() {
        let mut fixture = Fixture::new(&[]);
        for (name, size) in [
            ("a/one", 5.0),
            ("a/two", 3.0),
            ("a/b/", 0.0),
            ("a/b/c/", 0.0),
        ] {
            fixture.push(name, size);
        }
        fixture.refresh();
        let folder = fixture.find("a");
        fixture.views.list(&fixture.tree, folder);
        fixture.refresh();
        // The direct entries rank; the folders below add no file.
        assert_eq!(largest(&fixture), ["a/one", "a/two"]);
        let b = fixture.find("a/b");
        fixture.views.list(&fixture.tree, b);
        fixture.refresh();
        assert_eq!(largest(&fixture), Vec::<String>::new());
        fixture.views.list(&fixture.tree, folder);
        fixture.push("a/b/c/three", 1.0);
        fixture.refresh();
        assert_eq!(largest(&fixture), ["a/one", "a/two", "a/b/c/three"]);
    }

    #[test]
    fn largest_files_scan_in_steps_and_take_new_rows_one_time() {
        let mut fixture = Fixture::new(&[]);
        for index in 0..3000u32 {
            let name = format!("d{}/e{}/f{index}", index % 7, index % 11);
            fixture.push(&name, f64::from((index * 7919) % 1000));
        }
        fixture.refresh();
        fixture.views.set_step_threshold(64);
        let folder = fixture.find("d3");
        fixture.views.list(&fixture.tree, folder);
        fixture.refresh();
        // The listing of `d3` shows, but the scan has not ended: no result
        // shows, also not the result of the root.
        assert_eq!(fixture.views.permutation_folder(), folder);
        assert!(fixture.views.merge_pending());
        assert_eq!(largest(&fixture), Vec::<String>::new());
        let mut calls = 0;
        let mut added = 3000u32;
        while fixture.views.merge_pending() {
            fixture.views.merge(&fixture.tree, &fixture.store, 64);
            calls += 1;
            // Rows arrive during the scan, also rows of the scanned
            // folders.
            if calls % 5 == 0 && added < 3400 {
                let name = format!("d3/e{}/late{added}", added % 11);
                fixture.push(&name, f64::from(added % 1003));
                fixture.refresh();
                added += 1;
            }
        }
        assert!(calls > 2, "{calls}");
        assert_eq!(
            fixture.views.largest_files(),
            largest_from_scratch(&fixture, folder).as_slice()
        );
        let rows = fixture.views.largest_files().to_vec();
        let mut unique = rows.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), rows.len());
    }

    #[test]
    fn the_largest_files_of_the_shown_listing_stay_until_the_next_listing() {
        let mut fixture = Fixture::new(&[]);
        for index in 0..2000u32 {
            let name = format!("a/b{}/f{index}", index % 5);
            fixture.push(&name, f64::from(index));
        }
        fixture.push("c/d/g", 3.0);
        fixture.push("c/h", 2.0);
        for index in 0..100 {
            fixture.push(&format!("c/x{index:03}"), 1.0);
        }
        fixture.refresh();
        let a = fixture.find("a");
        fixture.views.list(&fixture.tree, a);
        fixture.refresh();
        while fixture.views.merge_pending() {
            fixture.views.merge(&fixture.tree, &fixture.store, 0);
        }
        let shown = largest(&fixture);
        assert_eq!(shown.len(), 10);
        // A new listing in steps: the old listing and its result stay.
        fixture.views.set_step_threshold(8);
        fixture.views.set_sort(sort(SortColumn::Name, false));
        let c = fixture.find("c");
        fixture.views.list(&fixture.tree, c);
        fixture.refresh();
        assert_eq!(fixture.views.permutation_folder(), a);
        assert_eq!(largest(&fixture), shown);
        while fixture.views.permutation_folder() == a {
            fixture.views.merge(&fixture.tree, &fixture.store, 8);
            if fixture.views.permutation_folder() == a {
                assert_eq!(largest(&fixture), shown);
            }
        }
        let expected: Vec<String> = ["c/d/g".to_string(), "c/h".to_string()]
            .into_iter()
            .chain((0..8).map(|index| format!("c/x{index:03}")))
            .collect();
        while fixture.views.merge_pending() {
            let rows = largest(&fixture);
            assert!(rows.is_empty() || rows == expected, "{rows:?}");
            fixture.views.merge(&fixture.tree, &fixture.store, 8);
        }
        assert_eq!(largest(&fixture), expected);
    }

    #[test]
    fn a_ranking_whose_listing_did_not_show_keeps_the_shown_result() {
        // The listing of X shows with its files. The scan
        // of Y ends before the listing of Y shows (a long listing builds in
        // steps). Then Z: the files of X must stay while the listing of X
        // shows, and the files of Z show with the listing of Z.
        let mut fixture = Fixture::new(&[]);
        fixture.push("x/a/one", 5.0);
        fixture.push("x/two", 3.0);
        fixture.push("y/three", 4.0);
        fixture.push("z/b/four", 2.0);
        let (x, y, z) = (fixture.find("x"), fixture.find("y"), fixture.find("z"));
        let (tree, store) = (&fixture.tree, &fixture.store);
        let names = |largest: &Largest| -> Vec<String> {
            largest
                .rows()
                .iter()
                .map(|&row| fixture.rows[row as usize].clone())
                .collect()
        };
        let mut largest = Largest::new();
        largest.follow(tree, store, x);
        while !largest.step(tree, store, 1) {}
        largest.show(x);
        assert_eq!(names(&largest), ["x/a/one", "x/two"]);
        largest.follow(tree, store, y);
        while !largest.step(tree, store, 1) {}
        // The listing of X still shows.
        largest.show(x);
        assert_eq!(names(&largest), ["x/a/one", "x/two"]);
        largest.follow(tree, store, z);
        largest.show(x);
        assert_eq!(names(&largest), ["x/a/one", "x/two"]);
        while !largest.step(tree, store, 1) {}
        largest.show(x);
        assert_eq!(names(&largest), ["x/a/one", "x/two"]);
        largest.show(z);
        assert_eq!(names(&largest), ["z/b/four"]);
    }

    #[test]
    fn largest_files_during_a_parse_equal_largest_files_from_scratch() {
        let parts = ["a", "b", "c"];
        for start in 1..60u64 {
            let mut seed = start.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
            let mut fixture = Fixture::new(&[]);
            fixture
                .views
                .set_step_threshold(1 + usize::try_from(start % 7).unwrap());
            let mut folder = ROOT;
            for index in 0..120 {
                let depth = next(&mut seed) % 4;
                let mut name: Vec<&str> = (0..depth)
                    .map(|_| parts[(next(&mut seed) % 3) as usize])
                    .collect();
                name.push(if next(&mut seed).is_multiple_of(6) {
                    ""
                } else {
                    "f"
                });
                // Few sizes, so that ties occur; some files are empty.
                let size = f64::from(u32::try_from(next(&mut seed) % 6).unwrap());
                fixture.push(&name.join("/"), size);
                if index % 7 == 0 {
                    fixture.refresh();
                    fixture.views.merge(&fixture.tree, &fixture.store, 3);
                }
                if index % 30 == 0 {
                    let count = u64::try_from(fixture.tree.folder_count()).unwrap();
                    folder = u32::try_from(next(&mut seed) % count).unwrap();
                    fixture.views.list(&fixture.tree, folder);
                }
                // A result that shows is never a file outside the listed
                // folder.
                let shown = fixture.views.permutation_folder();
                for &row in fixture.views.largest_files() {
                    let mut at = fixture.tree.row_folder(row);
                    while at != shown && at != NONE {
                        at = fixture.tree.parent(at);
                    }
                    assert_eq!(at, shown, "seed {start}");
                }
            }
            fixture.refresh();
            while fixture.views.merge_pending() {
                fixture.views.merge(&fixture.tree, &fixture.store, 3);
            }
            assert_eq!(
                fixture.views.largest_files(),
                largest_from_scratch(&fixture, folder).as_slice(),
                "seed {start}"
            );
        }
    }

    /// Merges until the listing changes, with a small budget. Checks that
    /// the old listing stays until then, and returns the calls.
    fn steps_until_done(fixture: &mut Fixture, budget: usize) -> usize {
        let before = fixture.views.listing().to_vec();
        let mut calls = 1;
        while !fixture.views.merge(&fixture.tree, &fixture.store, budget) {
            assert_eq!(fixture.views.listing(), before.as_slice());
            calls += 1;
        }
        calls
    }

    #[test]
    fn many_folders_and_long_names_sort_in_steps() {
        // Before, the folder items and the name bytes did not count in the
        // budget, so these sorts ran in one call.
        let many_folders: Vec<String> = (0..5000)
            .map(|i| format!("d{:05}/f", (i * 7919) % 5000))
            .collect();
        let long_names: Vec<String> = (0..256)
            .map(|i| format!("{}{:03}", "p".repeat(20_000), (i * 37) % 256))
            .collect();
        // A query that repeats a byte of the names.
        let repeated = format!("{}x", "p".repeat(5000));
        for (label, names, query) in [
            ("folders", &many_folders, &b""[..]),
            ("long names", &long_names, &b""[..]),
            ("long names, search", &long_names, &b"P"[..]),
            ("repeated bytes, search", &long_names, repeated.as_bytes()),
        ] {
            let mut fixture = Fixture::new(&[]);
            for name in names {
                fixture.push(name, 1.0);
            }
            fixture.refresh();
            fixture.views.set_sort(sort(SortColumn::Name, true));
            fixture.views.set_search(query);
            fixture.refresh();
            assert!(fixture.views.building(), "{label}");
            let calls = steps_until_done(&mut fixture, 512);
            assert!(calls > 10, "{label}: {calls} calls");
            assert_eq!(
                fixture.listing(),
                from_scratch(&fixture, query).0,
                "{label}"
            );
        }
    }

    #[test]
    fn hostile_digit_runs_sort_in_steps() {
        // The names have a short common prefix, so only the count of the
        // digits that a comparison reads can make the steps. The bytes of
        // one run stay under `RUN_BYTES`, so a sorted run alone is too few.
        let leading_zeros: Vec<String> = (0..256)
            .map(|i| format!("{}{}", "0".repeat(i * 75), (i * 37) % 256))
            .collect();
        let long_numbers: Vec<String> = (0..256)
            .map(|i| format!("{}{}", (i * 37) % 256 + 1000, "7".repeat(20_000)))
            .collect();
        for (label, names, least) in [
            ("leading zeros", &leading_zeros, 100),
            ("long numbers", &long_numbers, 400),
        ] {
            let mut fixture = Fixture::new(&[]);
            for name in names {
                fixture.push(name, 1.0);
            }
            fixture.refresh();
            fixture.views.set_sort(sort(SortColumn::Name, false));
            fixture.refresh();
            assert!(fixture.views.building(), "{label}");
            let calls = steps_until_done(&mut fixture, 512);
            assert!(calls >= least, "{label}: {calls} calls");
            assert_eq!(fixture.listing(), from_scratch(&fixture, b"").0, "{label}");
        }
    }

    #[test]
    fn name_sorts_with_numbers_are_the_same_in_steps_and_in_merges() {
        let parts = ["a1", "a01", "A2", "a10", "file01", "File1", "2", "02", "x"];
        for threshold in [STEP_THRESHOLD, 0, 3] {
            for start in 1..200u64 {
                let mut seed = start.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
                let mut fixture = Fixture::new(&[]);
                fixture.views.set_step_threshold(threshold);
                fixture
                    .views
                    .set_sort(sort(SortColumn::Name, next(&mut seed).is_multiple_of(2)));
                for _ in 0..8 {
                    for _ in 0..(next(&mut seed) % 9) {
                        let mut name = String::new();
                        for _ in 0..=(next(&mut seed) % 2) {
                            if !name.is_empty() {
                                name.push(if next(&mut seed).is_multiple_of(2) {
                                    '/'
                                } else {
                                    '-'
                                });
                            }
                            name.push_str(parts[(next(&mut seed) % 9) as usize]);
                        }
                        fixture.push(&name, 1.0);
                    }
                    fixture.refresh();
                    while fixture.views.merge_pending() {
                        fixture.views.merge(&fixture.tree, &fixture.store, 3);
                    }
                    assert_eq!(fixture.listing(), from_scratch(&fixture, b"").0);
                }
            }
        }
    }

    #[test]
    fn a_name_sort_uses_numbers_and_duplicates_stay_in_archive_order() {
        let mut fixture = Fixture::new(&[
            "file10", "d10/x", "file2", "d9/x", "File3", "d01/x", "D1/x", "file01", "file1",
            "file10",
        ]);
        fixture.views.set_sort(sort(SortColumn::Name, false));
        fixture.refresh();
        let rows = |fixture: &Fixture| {
            let start = fixture.views.folder_items;
            fixture.views.listing()[start..].to_vec()
        };
        let folders = ["D1/", "d01/", "d9/", "d10/"];
        let files = ["file01", "file1", "file2", "File3", "file10", "file10"];
        assert_eq!(
            fixture.listing(),
            [folders.as_slice(), files.as_slice()].concat()
        );
        // The two rows of `file10` keep archive order in both directions.
        assert_eq!(rows(&fixture), [7, 8, 2, 4, 0, 9]);
        fixture.views.set_sort(sort(SortColumn::Name, true));
        fixture.refresh();
        let folders: Vec<&str> = folders.into_iter().rev().collect();
        let files: Vec<&str> = files.into_iter().rev().collect();
        assert_eq!(
            fixture.listing(),
            [folders.as_slice(), files.as_slice()].concat()
        );
        assert_eq!(rows(&fixture), [0, 9, 4, 2, 8, 7]);
        // During the parse, the tree stays as first seen.
        let tree = fixture.tree();
        let at = |name: &str| tree.iter().position(|row| row.contains(name)).unwrap();
        assert!(at("d10") < at("d9") && at("d9") < at("d01") && at("d01") < at("D1"));
        // After the last row, the tree gets the same order as the table.
        fixture
            .views
            .start_tree_order(&fixture.tree, &fixture.store);
        assert!(fixture.views.tree_in_name_order());
        let tree = fixture.tree();
        let at = |name: &str| tree.iter().position(|row| row.contains(name)).unwrap();
        assert!(at("D1") < at("d01") && at("d01") < at("d9") && at("d9") < at("d10"));
    }

    #[test]
    fn folder_items_sort_again_in_steps_during_a_parse() {
        let mut fixture = Fixture::new(&[]);
        fixture.views.set_sort(sort(SortColumn::Name, false));
        for i in 0..3000 {
            fixture.push(&format!("d{:04}/f", (i * 7919) % 3000), 1.0);
        }
        fixture.refresh();
        while fixture.views.merge_pending() {
            fixture
                .views
                .merge(&fixture.tree, &fixture.store, usize::MAX);
        }
        // New folders make the folder items stale. The next merge sorts
        // them again in steps.
        fixture.push("c/f", 1.0);
        fixture.push("e/f", 1.0);
        fixture.refresh();
        assert!(fixture.views.merge_pending());
        let calls = steps_until_done(&mut fixture, 256);
        assert!(calls > 10, "{calls} calls");
        assert!(!fixture.views.merge_pending());
        assert_eq!(fixture.listing(), from_scratch(&fixture, b"").0);
    }

    /// Measures the query of the largest files on 1,000,000 rows in the
    /// layout of the listing benchmark, against a listing of the same
    /// folders:
    /// `cargo test --release -p zipscope-core --lib largest_times -- --ignored --nocapture`.
    #[test]
    #[ignore = "a time measurement"]
    fn largest_times() {
        use std::time::Instant;
        for mode in ["random sizes", "growing sizes", "equal sizes"] {
            println!("{mode}:");
            let mut seed = 0x9e37_79b9_7f4a_7c15u64;
            let mut fixture = Fixture::new(&[]);
            for index in 0..1_000_000u32 {
                let name = format!(
                    "project-1.2.0/src/module-{:03}/component-{:02}/file-{index:07}-generated-entry-name.txt",
                    index % 1000,
                    index % 100
                );
                let size = match mode {
                    "random sizes" => {
                        f64::from(u32::try_from(next(&mut seed) % 1_000_000).unwrap())
                    }
                    "growing sizes" => f64::from(index + 1),
                    _ => 1.0,
                };
                fixture.push(&name, size);
            }
            fixture.refresh();
            while fixture.views.merge_pending() {
                fixture
                    .views
                    .merge(&fixture.tree, &fixture.store, usize::MAX);
            }
            let src = fixture.find("project-1.2.0/src");
            let module = fixture.find("project-1.2.0/src/module-007");
            for (label, folder) in [("root", ROOT), ("src", src), ("module", module)] {
                // The scan alone, in one call.
                let mut largest = Largest::new();
                let start = Instant::now();
                largest.follow(&fixture.tree, &fixture.store, folder);
                while !largest.step(&fixture.tree, &fixture.store, usize::MAX) {}
                let scan = start.elapsed();
                // The scan in the steps of the worker (VIEW_CHUNK units).
                let mut largest = Largest::new();
                largest.follow(&fixture.tree, &fixture.store, folder);
                let (mut calls, mut longest) = (0, std::time::Duration::ZERO);
                loop {
                    let start = Instant::now();
                    let done = largest.step(&fixture.tree, &fixture.store, 8192);
                    longest = longest.max(start.elapsed());
                    calls += 1;
                    if done {
                        break;
                    }
                }
                // The listing of the same folder, by size, for comparison.
                fixture.views.set_sort(sort(SortColumn::Size, true));
                fixture.views.list(&fixture.tree, folder);
                let start = Instant::now();
                fixture.refresh();
                while fixture.views.merge_pending() {
                    fixture
                        .views
                        .merge(&fixture.tree, &fixture.store, usize::MAX);
                }
                let listing = start.elapsed();
                println!(
                    "{label}: scan {scan:?} ({calls} steps of 8192 units, longest {longest:?}); \
                 listing and scan by size {listing:?}"
                );
            }
            // New rows: the cost of `take_rows` for each row.
            let mut largest = Largest::new();
            largest.follow(&fixture.tree, &fixture.store, module);
            largest.rewind();
            let start = Instant::now();
            largest.take_rows(&fixture.tree, &fixture.store);
            println!(
                "take_rows of 1,000,000 rows below module-007: {:?}",
                start.elapsed()
            );
        }
    }

    /// Prints the longest call of each step kind. Run with
    /// `cargo test --release -p zipscope-core --lib step_times -- --ignored --nocapture`.
    #[test]
    #[ignore = "a time measurement"]
    fn step_times() {
        use std::time::Instant;
        let cases: Vec<(&str, Vec<String>)> = vec![
            (
                "250k folders",
                (0..250_000)
                    .map(|i| format!("d{:07}/f", (i * 7919) % 250_000))
                    .collect(),
            ),
            (
                "1000 names, 60 kB prefix",
                (0..1000)
                    .map(|i| format!("{}{:04}", "p".repeat(60_000), (i * 7919) % 1000))
                    .collect(),
            ),
            (
                "1M short names",
                (0..1_000_000)
                    .map(|i| {
                        format!(
                            "project-src-m-{:03}-file-{:07}-generated-entry-name.txt",
                            i % 1000,
                            (i * 7919) % 1_000_000
                        )
                    })
                    .collect(),
            ),
        ];
        for (label, names) in cases {
            let mut fixture = Fixture::new(&[]);
            for name in &names {
                fixture.push(name, 1.0);
            }
            fixture.refresh();
            while fixture.views.merge_pending() {
                fixture
                    .views
                    .merge(&fixture.tree, &fixture.store, usize::MAX);
            }
            for (what, column, query) in [
                ("name sort", SortColumn::Name, &b""[..]),
                ("size sort", SortColumn::Size, &b""[..]),
                ("search", SortColumn::Name, &b"F"[..]),
            ] {
                fixture.views.set_search(b"");
                fixture.views.set_sort(sort(SortColumn::Archive, false));
                fixture.refresh();
                while fixture.views.merge_pending() {
                    fixture
                        .views
                        .merge(&fixture.tree, &fixture.store, usize::MAX);
                }
                fixture.views.set_sort(sort(column, false));
                fixture.views.set_search(query);
                let start = Instant::now();
                fixture.refresh();
                let refresh = start.elapsed();
                let (mut longest, mut calls) = (refresh, 0);
                let all = Instant::now();
                while fixture.views.merge_pending() {
                    let start = Instant::now();
                    fixture.views.merge(&fixture.tree, &fixture.store, 8192);
                    longest = longest.max(start.elapsed());
                    calls += 1;
                }
                println!(
                    "{label}, {what}: refresh {refresh:?}, {calls} calls, longest {longest:?}, all {:?}",
                    all.elapsed()
                );
            }
        }
    }
}
