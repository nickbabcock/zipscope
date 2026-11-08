//! The folder tree. It is built as rows arrive: folders, implied folders,
//! the direct children of each folder, and rolled-up sizes.
//!
//! Paths split on `/` and `\`. Empty segments are ignored, so `a//b` and
//! `/a/b` are in the folders `a` and `b`. A name that ends with a separator
//! is a folder entry. The first folder entry of a folder is its explicit
//! row. A second folder entry for the same folder is an entry in that
//! folder, so every row shows in the tree. Other rows are entries of their
//! parent folder.
//!
//! Limits: a path has at most `MAX_DEPTH` folders below the root. The
//! segments after that fold into the name of the last folder. When the
//! folder table is full, a row goes into the deepest folder of its path
//! that exists. Both limits mark the row (`is_limited`), and `insert`
//! returns the `marks` bits of the limits.

use std::hash::BuildHasher;

use foldhash::fast::FixedState;
use zipscope_heap::{Full, Room, try_vec};

use crate::arena::Arena;
use crate::contract::{FOLDER_RECORD_BYTES, FOLDER_TAG, NONE, ROLLUP_RECORD_BYTES, marks};

/// The folder id of the root. The root has no name and no parent.
pub const ROOT: u32 = 0;

/// The most folders, including the root.
///
/// One folder costs about 180 bytes
/// (the record, the rollup, the links and the name order in wasm, and the
/// folder record and two rollup sets in the mirrors). Thus 4,194,304 folders
/// use about 750 MiB, which is less than the soft memory budget. A real archive has
/// many entries in each folder, so this limit is far above the folders of
/// an archive that the budget lets through. A depth bomb can make 256
/// folders from each entry; this limit stops it.
pub const MAX_FOLDERS: usize = 1 << 22;
const _: () = assert!(MAX_FOLDERS <= FOLDER_TAG as usize);

/// The most folders in one path, without the root.
pub const MAX_DEPTH: usize = 256;

/// One record of the folder table (`FOLDER_RECORD_BYTES`). The UI reads it
/// from the mirror of the folder table.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Folder {
    /// The name, as a slice of an entry name in the name arena.
    pub name_offset: u32,
    pub name_length: u32,
    /// The parent folder id, or `NONE` for the root.
    pub parent: u32,
    /// The row of the folder entry, or `NONE` for an implied folder.
    pub explicit_row: u32,
}

const _: () = assert!(size_of::<Folder>() == FOLDER_RECORD_BYTES);
const _: () = assert!(size_of::<Rollup>() == ROLLUP_RECORD_BYTES);

/// The rolled-up values of a folder and all folders below it.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Rollup {
    /// The sum of the uncompressed sizes of all rows in the folder,
    /// including its explicit row and the folder entries below it.
    pub uncompressed_size: f64,
    pub compressed_size: f64,
    /// The rows in the folder, including its explicit row.
    pub entry_count: f64,
}

/// The children of a folder, as linked lists in arrays.
#[derive(Debug, Clone, Copy)]
struct Links {
    first_child: u32,
    last_child: u32,
    next_sibling: u32,
    child_count: u32,
    first_entry: u32,
    last_entry: u32,
    entry_count: u32,
    /// The hash of the parent and the name.
    hash: u32,
    /// The epoch in which the folder was last recorded as changed.
    changed_epoch: u32,
    /// The largest uncompressed size of a direct entry.
    largest_entry: f64,
}

impl Links {
    const fn new(hash: u32) -> Self {
        Links {
            first_child: NONE,
            last_child: NONE,
            next_sibling: NONE,
            child_count: 0,
            first_entry: NONE,
            last_entry: NONE,
            entry_count: 0,
            hash,
            changed_epoch: 0,
            largest_entry: 0.0,
        }
    }
}

/// Returns the non-empty segments of a path, as byte ranges. `/` and `\`
/// are separators.
pub fn segments(name: &[u8]) -> impl Iterator<Item = (usize, usize)> + '_ {
    let mut start = 0;
    let mut position = 0;
    std::iter::from_fn(move || {
        while position <= name.len() {
            let at = position;
            position += 1;
            if at == name.len() || is_separator(name[at]) {
                let segment = (start, at);
                start = at + 1;
                if segment.1 > segment.0 {
                    return Some(segment);
                }
            }
        }
        None
    })
}

/// Returns true for `/` and `\`.
#[must_use]
pub fn is_separator(byte: u8) -> bool {
    byte == b'/' || byte == b'\\'
}

/// The hash of a parent id and a name, keyed with the seed of the tree.
/// The worker gives a random seed for each archive, so an archive cannot
/// make names that collide.
fn hash(state: &FixedState, parent: u32, name: &[u8]) -> u32 {
    let h = state.hash_one((parent, name));
    #[expect(
        clippy::cast_possible_truncation,
        reason = "The table uses the low 32 bits of the hash."
    )]
    let low = h as u32;
    low
}

/// Converts a length or an index that is known to fit in 31 bits: a name
/// position (a name is at most 3 × 65,535 bytes) or a folder id (at most
/// `MAX_FOLDERS`).
fn word(value: usize) -> u32 {
    u32::try_from(value).expect("names and folder ids fit in u32")
}

/// The folders of an archive.
#[derive(Debug)]
pub struct Tree {
    records: Vec<Folder>,
    rollups: Vec<Rollup>,
    links: Vec<Links>,
    /// The next entry of the same folder, for each row.
    next_entry: Vec<u32>,
    /// The folder that lists each row: the folder of an entry, or the
    /// folder of an explicit row with `FOLDER_TAG`.
    row_folders: Vec<u32>,
    /// Open addressing: folder ids by the hash of (parent, name). The root
    /// is not in it.
    slots: Vec<u32>,
    /// The folder path of the last row. Rows in archive order often share
    /// a path, so this skips most lookups.
    path: Vec<u32>,
    /// Segments of the row that `insert` adds.
    scratch: Vec<(usize, usize)>,
    /// Folders whose explicit row changed after their record was made.
    updates: Vec<u32>,
    /// Folders that got a child folder or an entry since `take_changes`.
    changed: Vec<u32>,
    epoch: u32,
    /// Rows that a limit moved, in row order.
    limited: Vec<u32>,
    max_folders: usize,
    hasher: FixedState,
    /// Rows added. Rollups change only when it changes.
    version: u32,
}

impl Default for Tree {
    fn default() -> Self {
        Self::new()
    }
}

impl Tree {
    /// Makes a tree with only the root.
    #[must_use]
    pub fn new() -> Self {
        Tree {
            records: vec![Folder {
                name_offset: 0,
                name_length: 0,
                parent: NONE,
                explicit_row: NONE,
            }],
            rollups: vec![Rollup::default()],
            links: vec![Links::new(0)],
            next_entry: Vec::new(),
            row_folders: Vec::new(),
            slots: Vec::new(),
            path: Vec::new(),
            scratch: Vec::new(),
            updates: Vec::new(),
            changed: Vec::new(),
            epoch: 1,
            limited: Vec::new(),
            max_folders: MAX_FOLDERS,
            hasher: FixedState::with_seed(0),
            version: 0,
        }
    }

    /// Makes a tree with a folder limit and a hash seed. The worker gives a
    /// random seed for each archive.
    #[must_use]
    pub fn with_options(max_folders: usize, seed: u64) -> Self {
        Tree {
            max_folders: max_folders.clamp(1, MAX_FOLDERS),
            hasher: FixedState::with_seed(seed),
            ..Self::new()
        }
    }

    /// Makes a tree that holds at most `max_folders` folders, including the
    /// root. Tests use a small limit.
    #[must_use]
    pub fn with_folder_limit(max_folders: usize) -> Self {
        Self::with_options(max_folders, 0)
    }

    /// Allocates what `insert` of a row with `name` needs, so that the
    /// insert does not grow a vector. The tree does not change.
    ///
    /// # Errors
    ///
    /// Returns [`Full`] when the memory budget has no room.
    pub fn prepare(&mut self, name: &[u8]) -> Result<(), Full> {
        // A name of n bytes has at most n / 2 + 1 segments.
        let segments = name.len() / 2 + 1;
        let folders = segments
            .min(MAX_DEPTH)
            .min(self.max_folders.saturating_sub(self.records.len()));
        self.scratch.room(segments)?;
        self.path.room(MAX_DEPTH.saturating_sub(self.path.len()))?;
        self.next_entry.room(1)?;
        self.row_folders.room(1)?;
        self.limited.room(1)?;
        self.updates.room(1)?;
        self.changed.room(folders + 1)?;
        self.records.room(folders)?;
        self.rollups.room(folders)?;
        self.links.room(folders)?;
        // `find_or_create` grows the slots when they are half full.
        while (self.records.len() + folders) * 2 >= self.slots.len() {
            let size = (self.slots.len() * 2).max(64);
            let slots = try_vec(NONE, size)?;
            self.rehash(slots);
        }
        Ok(())
    }

    /// Adds a row. `row` must be the next row, `name` its decoded name and
    /// `name_offset` the offset of the name in `names`. Returns the `marks`
    /// bits of the limits that moved the row: `DEPTH_CAP` when the path was
    /// deeper than `MAX_DEPTH`, `FOLDER_CAP` when the folder table was full.
    pub fn insert(
        &mut self,
        names: &Arena,
        row: u32,
        name: &[u8],
        name_offset: u32,
        uncompressed_size: f64,
        compressed_size: f64,
    ) -> u8 {
        debug_assert_eq!(row as usize, self.next_entry.len());
        self.version = self.version.wrapping_add(1);
        let mut scratch = std::mem::take(&mut self.scratch);
        scratch.clear();
        scratch.extend(segments(name));
        let is_folder = !scratch.is_empty() && name.last().copied().is_some_and(is_separator);
        let mut depth = if is_folder {
            scratch.len()
        } else {
            scratch.len() - usize::from(!scratch.is_empty())
        };
        let deep = depth > MAX_DEPTH;
        if deep {
            // The last folder gets the remaining folder segments, with
            // their separators, as one name.
            scratch[MAX_DEPTH - 1].1 = scratch[depth - 1].1;
            depth = MAX_DEPTH;
        }

        let mut parent = ROOT;
        let mut cached = true;
        let mut full = false;
        for (level, &(start, end)) in scratch[..depth].iter().enumerate() {
            let segment = &name[start..end];
            let hit = self
                .path
                .get(level)
                .copied()
                .filter(|&id| cached && self.name(names, id) == segment);
            let id = if let Some(id) = hit {
                id
            } else {
                cached = false;
                self.path.truncate(level);
                // `start` is below the length of the name, so the sum stays
                // in the chunk of the name.
                let Some(id) =
                    self.find_or_create(names, parent, segment, name_offset + word(start))
                else {
                    full = true;
                    break;
                };
                self.path.push(id);
                id
            };
            parent = id;
        }
        self.scratch = scratch;
        if full {
            self.path.clear();
        } else {
            self.path.truncate(depth);
        }
        self.next_entry.push(NONE);
        self.row_folders.push(parent);
        if deep || full {
            self.limited.push(row);
        }
        let limits =
            if deep { marks::DEPTH_CAP } else { 0 } | if full { marks::FOLDER_CAP } else { 0 };

        let folder = parent;
        if is_folder && !full {
            let record = &mut self.records[folder as usize];
            if record.explicit_row == NONE {
                record.explicit_row = row;
                self.row_folders[row as usize] = folder | FOLDER_TAG;
                self.updates.push(folder);
                self.add(folder, uncompressed_size, compressed_size);
                return limits;
            }
            // A second entry for the same folder is an entry in that
            // folder, so that every row shows in the tree.
        }
        let links = &mut self.links[folder as usize];
        if links.last_entry == NONE {
            links.first_entry = row;
        } else {
            self.next_entry[links.last_entry as usize] = row;
        }
        links.last_entry = row;
        links.entry_count += 1;
        links.largest_entry = links.largest_entry.max(uncompressed_size);
        self.mark_changed(folder);
        self.add(folder, uncompressed_size, compressed_size);
        limits
    }

    fn add(&mut self, mut folder: u32, uncompressed: f64, compressed: f64) {
        while folder != NONE {
            let rollup = &mut self.rollups[folder as usize];
            rollup.uncompressed_size += uncompressed;
            rollup.compressed_size += compressed;
            rollup.entry_count += 1.0;
            folder = self.records[folder as usize].parent;
        }
    }

    fn mark_changed(&mut self, folder: u32) {
        let links = &mut self.links[folder as usize];
        if links.changed_epoch != self.epoch {
            links.changed_epoch = self.epoch;
            self.changed.push(folder);
        }
    }

    fn find_or_create(
        &mut self,
        names: &Arena,
        parent: u32,
        segment: &[u8],
        offset: u32,
    ) -> Option<u32> {
        if (self.records.len() * 2) >= self.slots.len() {
            self.grow_slots();
        }
        let hash = hash(&self.hasher, parent, segment);
        let mask = self.slots.len() - 1;
        let mut slot = hash as usize & mask;
        loop {
            let id = self.slots[slot];
            if id == NONE {
                break;
            }
            let record = &self.records[id as usize];
            if self.links[id as usize].hash == hash
                && record.parent == parent
                && names.get(record.name_offset, record.name_length) == segment
            {
                return Some(id);
            }
            slot = (slot + 1) & mask;
        }
        if self.records.len() >= self.max_folders {
            return None;
        }
        let id = word(self.records.len());
        self.records.push(Folder {
            name_offset: offset,
            name_length: word(segment.len()),
            parent,
            explicit_row: NONE,
        });
        self.rollups.push(Rollup::default());
        self.links.push(Links::new(hash));
        self.slots[slot] = id;
        let links = &mut self.links[parent as usize];
        let last = links.last_child;
        links.last_child = id;
        links.child_count += 1;
        if last == NONE {
            links.first_child = id;
        } else {
            self.links[last as usize].next_sibling = id;
        }
        self.mark_changed(parent);
        Some(id)
    }

    /// Grows the slots without a budget check. `prepare` grows them
    /// first, so this occurs only when a caller did not call it.
    fn grow_slots(&mut self) {
        let size = (self.slots.len() * 2).max(64);
        self.rehash(vec![NONE; size]);
    }

    /// Puts all folders except the root into `slots`, which are all `NONE`.
    fn rehash(&mut self, slots: Vec<u32>) {
        self.slots = slots;
        let mask = self.slots.len() - 1;
        for id in 1..self.records.len() {
            let mut slot = self.links[id].hash as usize & mask;
            while self.slots[slot] != NONE {
                slot = (slot + 1) & mask;
            }
            self.slots[slot] = word(id);
        }
    }

    /// Returns the bytes that the tree has allocated.
    #[must_use]
    pub fn allocated_bytes(&self) -> usize {
        self.records.capacity() * size_of::<Folder>()
            + self.rollups.capacity() * size_of::<Rollup>()
            + self.links.capacity() * size_of::<Links>()
            + (self.next_entry.capacity()
                + self.row_folders.capacity()
                + self.slots.capacity()
                + self.path.capacity()
                + self.updates.capacity()
                + self.changed.capacity()
                + self.limited.capacity())
                * size_of::<u32>()
            + self.scratch.capacity() * size_of::<(usize, usize)>()
    }

    /// Returns the number of folders, including the root.
    #[must_use]
    pub fn folder_count(&self) -> usize {
        self.records.len()
    }

    /// Returns the folder table records, by folder id.
    #[must_use]
    pub fn folders(&self) -> &[Folder] {
        &self.records
    }

    /// Returns the rollups, by folder id.
    #[must_use]
    pub fn rollups(&self) -> &[Rollup] {
        &self.rollups
    }

    #[must_use]
    pub fn folder(&self, folder: u32) -> &Folder {
        &self.records[folder as usize]
    }

    #[must_use]
    pub fn rollup(&self, folder: u32) -> Rollup {
        self.rollups[folder as usize]
    }

    #[must_use]
    pub fn parent(&self, folder: u32) -> u32 {
        self.records[folder as usize].parent
    }

    /// Returns the name of a folder. The root has an empty name.
    #[must_use]
    pub fn name<'a>(&self, names: &'a Arena, folder: u32) -> &'a [u8] {
        let record = &self.records[folder as usize];
        if record.name_length == 0 {
            return &[];
        }
        names.get(record.name_offset, record.name_length)
    }

    /// Returns the number of child folders.
    #[must_use]
    pub fn child_count(&self, folder: u32) -> u32 {
        self.links[folder as usize].child_count
    }

    /// Returns the number of direct entries.
    #[must_use]
    pub fn entry_count(&self, folder: u32) -> u32 {
        self.links[folder as usize].entry_count
    }

    /// Returns the first child folder, or `NONE`.
    #[must_use]
    pub fn first_child(&self, folder: u32) -> u32 {
        self.links[folder as usize].first_child
    }

    /// Returns the next folder with the same parent, or `NONE`.
    #[must_use]
    pub fn next_sibling(&self, folder: u32) -> u32 {
        self.links[folder as usize].next_sibling
    }

    /// Returns the direct children as tagged indexes: the child folders
    /// with `FOLDER_TAG`, then the entry rows. Chains are not compacted.
    #[must_use]
    pub fn children(&self, folder: u32) -> Vec<u32> {
        self.child_folders(folder)
            .map(|id| id | FOLDER_TAG)
            .chain(self.entries(folder))
            .collect()
    }

    /// Returns the last folder of the chain that starts at `folder`: while
    /// a folder has one child folder and no entries, the chain continues.
    /// An explicit row does not stop the chain.
    #[must_use]
    pub fn compact_end(&self, mut folder: u32) -> u32 {
        while self.has_one_child(folder) {
            folder = self.first_child(folder);
        }
        folder
    }

    /// Returns true when a limit moved the row: its path was deeper than
    /// `MAX_DEPTH`, or the folder table was full.
    #[must_use]
    pub fn is_limited(&self, row: usize) -> bool {
        u32::try_from(row).is_ok_and(|row| self.limited.binary_search(&row).is_ok())
    }

    /// Returns the child folders, in the order they were made. This order
    /// does not change. The tree view has its own name order (`view.rs`).
    pub fn child_folders(&self, folder: u32) -> impl Iterator<Item = u32> + '_ {
        let mut next = self.first_child(folder);
        std::iter::from_fn(move || {
            let id = next;
            (id != NONE).then(|| {
                next = self.next_sibling(id);
                id
            })
        })
    }

    /// Returns the direct entry rows, in row order.
    pub fn entries(&self, folder: u32) -> impl Iterator<Item = u32> + '_ {
        let mut next = self.links[folder as usize].first_entry;
        std::iter::from_fn(move || {
            let row = next;
            (row != NONE).then(|| {
                next = self.next_entry[row as usize];
                row
            })
        })
    }

    /// Returns the folder of a row: for an entry, the folder that lists
    /// it; for the explicit row of a folder, that folder with
    /// `FOLDER_TAG`. Returns `NONE` for a row that is not in the tree.
    #[must_use]
    pub fn row_folder(&self, row: u32) -> u32 {
        self.row_folders.get(row as usize).copied().unwrap_or(NONE)
    }

    /// Returns the first direct entry row, or `NONE`.
    #[must_use]
    pub fn first_entry(&self, folder: u32) -> u32 {
        self.links[folder as usize].first_entry
    }

    /// Returns the next entry row of the same folder, or `NONE`. Rows are
    /// added to the end of their folder, so a later call can give a row
    /// that an earlier call did not.
    #[must_use]
    pub fn next_entry(&self, row: u32) -> u32 {
        self.next_entry[row as usize]
    }

    /// Returns the largest uncompressed size of a direct entry, or 0.
    #[must_use]
    pub fn largest_entry(&self, folder: u32) -> f64 {
        self.links[folder as usize].largest_entry
    }

    /// Returns a number that changes when the rollups change.
    #[must_use]
    pub fn version(&self) -> u32 {
        self.version
    }

    /// Returns true when a folder has one child folder and no entries.
    /// Such a folder shows on one row with its child.
    #[must_use]
    pub fn has_one_child(&self, folder: u32) -> bool {
        let links = &self.links[folder as usize];
        links.child_count == 1 && links.entry_count == 0
    }

    /// Returns the folders whose explicit row changed after the folder was
    /// made, since the last `clear_updates`.
    #[must_use]
    pub fn updates(&self) -> &[u32] {
        &self.updates
    }

    pub fn clear_updates(&mut self) {
        self.updates.clear();
    }

    /// Returns the folders that got a child folder or an entry since the
    /// last call, and starts a new record.
    pub fn take_changes(&mut self) -> Vec<u32> {
        self.epoch = self.epoch.wrapping_add(1).max(1);
        std::mem::take(&mut self.changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tree with its own name arena.
    pub(crate) struct Built {
        pub names: Arena,
        pub tree: Tree,
        pub rows: Vec<String>,
    }

    impl Built {
        pub fn new() -> Self {
            Built {
                names: Arena::new(),
                tree: Tree::new(),
                rows: Vec::new(),
            }
        }

        pub fn add(&mut self, name: &str, size: f64) {
            let offset = self.names.push(name.as_bytes()).unwrap();
            let row = u32::try_from(self.rows.len()).unwrap();
            self.tree
                .insert(&self.names, row, name.as_bytes(), offset, size, size / 2.0);
            self.rows.push(name.to_string());
        }

        pub fn find(&self, path: &str) -> u32 {
            let mut folder = ROOT;
            for (start, end) in segments(path.as_bytes()) {
                let segment = &path.as_bytes()[start..end];
                folder = self
                    .tree
                    .child_folders(folder)
                    .find(|&id| self.tree.name(&self.names, id) == segment)
                    .unwrap_or_else(|| panic!("no folder {path}"));
            }
            folder
        }

        pub fn entry_names(&self, folder: u32) -> Vec<&str> {
            self.tree
                .entries(folder)
                .map(|row| self.rows[row as usize].as_str())
                .collect()
        }

        pub fn child_names(&self, folder: u32) -> Vec<String> {
            self.tree
                .child_folders(folder)
                .map(|id| String::from_utf8(self.tree.name(&self.names, id).to_vec()).unwrap())
                .collect()
        }
    }

    fn built(names: &[&str]) -> Built {
        let mut built = Built::new();
        for name in names {
            built.add(name, 10.0);
        }
        built
    }

    #[test]
    fn splits_on_both_separators_and_skips_empty_segments() {
        let found: Vec<_> = segments(b"/a//b\\c/").collect();
        assert_eq!(found, [(1, 2), (4, 5), (6, 7)]);
        assert_eq!(segments(b"").count(), 0);
        assert_eq!(segments(b"//\\").count(), 0);
        assert_eq!(segments(b"x").collect::<Vec<_>>(), [(0, 1)]);
    }

    #[test]
    fn makes_implied_folders() {
        let built = built(&["a/b/c.txt", "a\\b\\d.txt", "a/e.txt", "f.txt"]);
        let tree = &built.tree;
        assert_eq!(tree.folder_count(), 3);
        assert_eq!(built.child_names(ROOT), ["a"]);
        let a = built.find("a");
        let b = built.find("a/b");
        assert_eq!(tree.folder(a).explicit_row, NONE);
        assert_eq!(tree.parent(b), a);
        assert_eq!(built.entry_names(b), ["a/b/c.txt", "a\\b\\d.txt"]);
        assert_eq!(built.entry_names(a), ["a/e.txt"]);
        assert_eq!(built.entry_names(ROOT), ["f.txt"]);
        // A folder name is a slice of the name that made it.
        assert_eq!(tree.folder(b).name_offset, 2);
        assert_eq!(tree.folder(b).name_length, 1);
    }

    #[test]
    fn rolls_up_sizes_and_counts() {
        let mut built = Built::new();
        built.add("a/", 1.0);
        built.add("a/b/c", 2.0);
        built.add("a/b/d", 4.0);
        built.add("e", 8.0);
        let tree = &built.tree;
        let a = built.find("a");
        let b = built.find("a/b");
        assert_eq!(tree.folder(a).explicit_row, 0);
        let rollup = |folder| {
            let r = tree.rollup(folder);
            (r.uncompressed_size, r.compressed_size, r.entry_count)
        };
        assert_eq!(rollup(b), (6.0, 3.0, 2.0));
        // The explicit row counts in its folder.
        assert_eq!(rollup(a), (7.0, 3.5, 3.0));
        assert_eq!(rollup(ROOT), (15.0, 7.5, 4.0));
    }

    #[test]
    fn a_later_folder_entry_makes_an_implied_folder_explicit() {
        let mut built = built(&["a/b.txt"]);
        let a = built.find("a");
        assert_eq!(built.tree.folder(a).explicit_row, NONE);
        assert_eq!(built.tree.updates(), [0u32; 0]);
        built.add("a\\", 0.0);
        assert_eq!(built.tree.folder(a).explicit_row, 1);
        assert_eq!(built.tree.updates(), [a]);
        built.tree.clear_updates();
        assert_eq!(built.tree.updates(), [0u32; 0]);
    }

    #[test]
    fn a_second_folder_entry_is_an_entry_of_that_folder() {
        let built = built(&["x/a/", "x/a/", "x/a/f"]);
        let x = built.find("x");
        let a = built.find("x/a");
        assert_eq!(built.tree.folder(a).explicit_row, 0);
        assert_eq!(built.entry_names(x), Vec::<&str>::new());
        assert_eq!(built.entry_names(a), ["x/a/", "x/a/f"]);
        assert_eq!(built.tree.rollup(ROOT).entry_count, 3.0);
    }

    #[test]
    fn names_without_segments_are_entries_of_the_root() {
        let built = built(&["", "/", "\\\\", "a"]);
        assert_eq!(built.tree.folder_count(), 1);
        assert_eq!(built.entry_names(ROOT), ["", "/", "\\\\", "a"]);
    }

    #[test]
    fn every_row_shows_one_time() {
        let names = [
            "a/", "a/", "a/b/", "a/b/c", "a//b/d", "/a/e", "a", "a/b\\", "", "z/y/x/",
        ];
        let built = built(&names);
        let tree = &built.tree;
        let mut seen = vec![0; names.len()];
        for folder in 0..u32::try_from(tree.folder_count()).unwrap() {
            for row in tree.entries(folder) {
                seen[row as usize] += 1;
            }
            let explicit = tree.folder(folder).explicit_row;
            if explicit != NONE {
                seen[explicit as usize] += 1;
            }
        }
        assert!(seen.iter().all(|&count| count == 1), "{seen:?}");
    }

    #[test]
    fn same_names_under_other_parents_are_other_folders() {
        let built = built(&["a/x/1", "b/x/2", "a/x/3", "x/4"]);
        assert_eq!(built.tree.folder_count(), 6);
        assert_eq!(built.entry_names(built.find("a/x")), ["a/x/1", "a/x/3"]);
        assert_eq!(built.entry_names(built.find("b/x")), ["b/x/2"]);
    }

    #[test]
    fn many_folders_are_found_again() {
        let mut built = Built::new();
        for i in 0..3000 {
            built.add(&format!("d{}/e{}/f", i % 700, i % 13), 1.0);
        }
        for i in 0..3000 {
            built.add(&format!("d{}/e{}/g", (i * 7) % 700, (i * 7) % 13), 1.0);
        }
        let mut expected = std::collections::HashSet::new();
        for i in 0..3000 {
            expected.insert(format!("d{}/e{}", i % 700, i % 13));
            expected.insert(format!("d{}/e{}", (i * 7) % 700, (i * 7) % 13));
        }
        let tops: std::collections::HashSet<_> = (0..700).map(|i| format!("d{i}")).collect();
        assert_eq!(built.tree.folder_count(), 1 + tops.len() + expected.len());
        assert_eq!(built.tree.rollup(ROOT).entry_count, 6000.0);
    }

    #[test]
    fn the_seed_keys_the_hash() {
        let name = b"same-name";
        let a = hash(&FixedState::with_seed(1), 0, name);
        let b = hash(&FixedState::with_seed(2), 0, name);
        assert_ne!(a, b);
        assert_eq!(a, hash(&FixedState::with_seed(1), 0, name));
    }

    /// Names that share one table slot under a known seed are spread out
    /// under another seed, so an archive made for one seed is not slow.
    #[test]
    fn names_that_collide_for_one_seed_do_not_collide_for_another() {
        let known = FixedState::with_seed(7);
        let slot = |state: &FixedState, name: &str| hash(state, 0, name.as_bytes()) & 0xffff;
        let target = slot(&known, "n0");
        let colliding: Vec<String> = (0..)
            .map(|i| format!("n{i}"))
            .filter(|name| slot(&known, name) == target)
            .take(64)
            .collect();
        let other = FixedState::with_seed(8);
        let slots: std::collections::HashSet<u32> =
            colliding.iter().map(|name| slot(&other, name)).collect();
        assert!(slots.len() > 48, "{} slots", slots.len());
    }

    #[test]
    fn many_sibling_folders_insert_in_linear_time() {
        let mut built = Built {
            tree: Tree::with_options(MAX_FOLDERS, 99),
            ..Built::new()
        };
        let start = std::time::Instant::now();
        for i in 0..200_000 {
            built.add(&format!("folder-{i:08}/f"), 1.0);
        }
        assert_eq!(built.tree.folder_count(), 200_001);
        assert!(start.elapsed().as_secs() < 10, "{:?}", start.elapsed());
    }

    #[test]
    fn keeps_the_largest_direct_entry() {
        let mut built = Built::new();
        built.add("a/x", 5.0);
        built.add("a/y", 9.0);
        built.add("a/b/z", 50.0);
        assert_eq!(built.tree.largest_entry(built.find("a")), 9.0);
        assert_eq!(built.tree.largest_entry(ROOT), 0.0);
    }

    #[test]
    fn each_row_knows_the_folder_that_lists_it() {
        let deep = format!("{}f", "d/".repeat(MAX_DEPTH + 2));
        let built = built(&["docs/", "docs/guide.md", "docs/", "top", &deep]);
        let docs = built.find("docs");
        // The explicit row lists as the folder row of `docs`.
        assert_eq!(built.tree.row_folder(0), docs | FOLDER_TAG);
        assert_eq!(built.tree.row_folder(1), docs);
        // A second folder entry is an entry of its folder.
        assert_eq!(built.tree.row_folder(2), docs);
        assert_eq!(built.tree.row_folder(3), ROOT);
        // A deep path is in the folder that the folded segments make.
        let last = built.tree.row_folder(4);
        assert!(built.tree.entries(last).any(|row| row == 4));
        assert_eq!(last as usize, MAX_DEPTH + 1);
        assert_eq!(built.tree.row_folder(5), NONE);
    }

    #[test]
    fn deep_paths_fold_into_the_last_folder() {
        let mut built = Built::new();
        let name = format!("{}f", "d/".repeat(MAX_DEPTH + 3));
        built.add(&name, 1.0);
        assert_eq!(built.tree.folder_count(), 1 + MAX_DEPTH);
        assert!(built.tree.is_limited(0));
        let last = u32::try_from(built.tree.folder_count() - 1).unwrap();
        assert_eq!(built.tree.name(&built.names, last), b"d/d/d/d");
        assert_eq!(built.entry_names(last), [name.as_str()]);
        built.add("d/g", 1.0);
        assert!(!built.tree.is_limited(1));
    }

    #[test]
    fn a_full_folder_table_keeps_rows_in_the_deepest_folder() {
        let mut built = Built {
            tree: Tree::with_folder_limit(3),
            ..Built::new()
        };
        built.add("a/b/c/f", 1.0);
        built.add("a/x/", 1.0);
        built.add("a/b/g", 1.0);
        assert_eq!(built.tree.folder_count(), 3);
        let b = built.find("a/b");
        let a = built.find("a");
        assert_eq!(built.entry_names(b), ["a/b/c/f", "a/b/g"]);
        // A folder entry that cannot get its folder is an entry.
        assert_eq!(built.entry_names(a), ["a/x/"]);
        assert!(built.tree.is_limited(0));
        assert!(built.tree.is_limited(1));
        assert!(!built.tree.is_limited(2));
        assert_eq!(built.tree.rollup(ROOT).entry_count, 3.0);
    }

    #[test]
    fn records_changed_folders_one_time_for_each_call() {
        let mut built = built(&["a/b", "a/c", "d"]);
        let a = built.find("a");
        let mut changes = built.tree.take_changes();
        changes.sort_unstable();
        assert_eq!(changes, [ROOT, a]);
        assert_eq!(built.tree.children(ROOT), [a | FOLDER_TAG, 2]);
        assert_eq!(built.tree.take_changes(), [0u32; 0]);
        built.add("a/e", 1.0);
        assert_eq!(built.tree.take_changes(), [a]);
    }

    #[test]
    fn counts_the_two_row_vectors() {
        // Each row adds one `u32` to `next_entry` and one to `row_folders`.
        // Entries of the root add no folders.
        let mut built = Built::new();
        let before = built.tree.allocated_bytes();
        for index in 0..10_000 {
            built.add(&format!("f{index}"), 1.0);
        }
        let added = built.tree.allocated_bytes() - before;
        assert!(added >= 10_000 * 2 * size_of::<u32>(), "{added}");
    }

    #[test]
    fn has_one_child_needs_no_entries() {
        let mut built = built(&["a/b/c"]);
        let a = built.find("a");
        assert!(built.tree.has_one_child(ROOT));
        assert!(built.tree.has_one_child(a));
        assert!(!built.tree.has_one_child(built.find("a/b")));
        assert_eq!(built.tree.compact_end(ROOT), built.find("a/b"));
        built.add("a/", 1.0);
        assert!(built.tree.has_one_child(a));
        built.add("a/f", 1.0);
        assert!(!built.tree.has_one_child(a));
        assert_eq!(built.tree.compact_end(ROOT), a);
    }
}
