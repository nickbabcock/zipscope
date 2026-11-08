//! Health findings of an archive.
//!
//! The findings are: duplicate names, bomb-like ratios, overlapping entries,
//! data that runs into the central directory, encrypted entries, the tree
//! limits, offsets that wrapped at 4 GiB, the data before the first entry and
//! after the archive end, and what the walk to the end record saw
//! (`zipscope_layout::end`).
//!
//! Each finding of rows sets a bit in the `marks` column of its rows, but
//! `marks` has no free bit for data that runs into the central directory. The
//! overlap check can mark a row that is already committed (the earlier row of
//! an overlap), and the duplicate check runs after parsing. Such rows go into
//! a list of updates, so that the worker copies their `marks` value again.

use std::hash::BuildHasher;

use foldhash::fast::FixedState;
use zipscope_heap::{Full, Room, try_vec};
use zipscope_layout::LOCAL_HEADER_BYTES;
use zipscope_layout::end::EndNotes;

use crate::contract::{Column, NONE, health, marks};
use crate::query::BYTES_PER_UNIT;
use crate::store::Store;

/// The ratio of uncompressed to compressed size above which an entry is
/// bomb-like. The extraction warning uses the same rule.
pub const BOMB_RATIO: u64 = 100;
/// The smallest declared uncompressed size of a bomb-like entry (16 MiB).
/// A small file with a high ratio (for example a text file of a few KiB)
/// is not a risk, so it gets no finding.
pub const BOMB_MIN_BYTES: u64 = 16 << 20;

/// True when an entry of `uncompressed` declared bytes and `compressed`
/// compressed bytes is bomb-like: it declares at least [`BOMB_MIN_BYTES`]
/// and more than [`BOMB_RATIO`] times its compressed size.
#[must_use]
pub const fn bomb_like(uncompressed: u64, compressed: u64) -> bool {
    uncompressed >= BOMB_MIN_BYTES && uncompressed > compressed.saturating_mul(BOMB_RATIO)
}

/// The rows that have one finding, and the first of them.
#[derive(Debug, Clone, Copy)]
struct Count {
    rows: u32,
    example: u32,
}

impl Count {
    const fn new() -> Self {
        Count {
            rows: 0,
            example: NONE,
        }
    }

    fn add(&mut self, row: u32) {
        self.rows += 1;
        if self.example == NONE || row < self.example {
            self.example = row;
        }
    }

    fn fields(self) -> [f64; 2] {
        let example = if self.example == NONE {
            -1.0
        } else {
            f64::from(self.example)
        };
        [f64::from(self.rows), example]
    }
}

/// The values of one entry that the checks use.
#[derive(Debug, Clone, Copy)]
pub struct EntryFacts {
    pub local_header_offset: u64,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub encryption: u8,
    /// `Health::name_hash` of the stored name.
    pub name_hash: u32,
    /// The stored bytes of the name, the comment and a kept raw name.
    pub text_bytes: usize,
    /// True when the finding counts the name (`text::counts_as_control`).
    pub control_name: bool,
    /// True when the offset of the row wrapped at 4 GiB, and
    /// `local_header_offset` is the true place of the row.
    pub wrapped: bool,
    /// The lengths of the name and the extra field in the central-directory record.
    pub name_and_extra: u64,
}

/// Returns the end of the bytes that an entry uses at least: from its local
/// header offset, the fixed part of its local header and the compressed size.
/// The parse reads no local header, so the name, the extra field and a data
/// descriptor do not count. Thus the end is never after the true end of an
/// entry that a writer put there, and two such entries only touch or have a gap.
fn data_end(start: u64, compressed_size: u64) -> u64 {
    start
        .saturating_add(LOCAL_HEADER_BYTES as u64)
        .saturating_add(compressed_size)
}

/// True when an entry starts before the central directory at `directory`, and
/// its bytes end after that place. An entry that starts at or after that place
/// does not count: an optimized jar has its entries after its directory.
fn into_directory(directory: u64, start: u64, compressed_size: u64) -> bool {
    start < directory && data_end(start, compressed_size) > directory
}

/// True when an entry holds the byte at `place`.
///
/// Its bytes are the bytes of [`data_end`] and `name_and_extra`, the lengths of the
/// name and the extra field in its central-directory record. The local header can
/// have other lengths, but the parse does not read it.
#[must_use]
pub fn covers(place: u64, start: u64, compressed_size: u64, name_and_extra: u64) -> bool {
    start <= place && place < data_end(start, compressed_size).saturating_add(name_and_extra)
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "Store values are exact to 2^53. A larger value saturates."
)]
fn to_u64(value: f64) -> u64 {
    value as u64
}

/// The findings of an archive as Rust values, for tests and tools. The
/// worker uses the health vector (`Ingest::health_vector`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    /// The terminal parse error.
    pub terminal_error: Option<String>,
    /// (declared count, rows) when parsing is complete and they differ, and
    /// the rule of `count_wrapped` does not apply.
    pub count_mismatch: Option<(u64, u64)>,
    /// True when parsing is complete, the archive has no Zip64 locator, and the
    /// declared count is the row count in 16 bits, but not the row count.
    pub count_wrapped: bool,
    pub prelude_bytes: u64,
    pub epilogue_bytes: u64,
    /// Rows by the low 7 bits of `encryption` (index 0 is not counted).
    pub encrypted_counts: [u64; 7],
    pub duplicate_rows: u64,
    pub bomb_rows: u64,
    pub overlap_rows: u64,
    /// The rows of `overlap_rows` with data whose range overlaps the range of
    /// another row with data.
    pub overlap_data_rows: u64,
    pub into_directory_rows: u64,
    pub depth_cap_rows: u64,
    pub folder_cap_rows: u64,
    pub control_name_rows: u64,
    pub wrapped_rows: u64,
    /// What the walk to the end record saw.
    pub end_notes: EndNotes,
}

/// Bits of one radix digit of the name hash. Two passes sort the keys by
/// the high 22 bits of the hash; a run of keys with the same high bits is
/// short, and the scan compares the full hash in it.
const DIGIT_BITS: u32 = 11;
const DIGITS: usize = 2;
const DIGITS_BITS: u32 = 2 * DIGIT_BITS;
const BUCKETS: usize = 1 << DIGIT_BITS;
/// The shift of a key to the sorted bits of its hash.
const RUN_SHIFT: u32 = 64 - DIGITS_BITS;

/// Returns digit `digit` of the sorted hash bits of a key.
#[expect(clippy::cast_possible_truncation, reason = "The mask keeps one digit.")]
fn digit(key: u64, digit: usize) -> usize {
    (key >> (RUN_SHIFT as usize + DIGIT_BITS as usize * digit)) as usize & (BUCKETS - 1)
}

/// Name bytes that the NH hash reads. A longer name uses foldhash.
const NH_BYTES: usize = 256;
/// Blocks of 8 bytes of a padded name of at most `NH_BYTES`.
const NH_BLOCKS: usize = NH_BYTES / 8 + 1;

/// A keyed hash of the name bytes, fast in wasm. It is NH (from UMAC):
/// the sum of `(a + k1) * (b + k2)` over the 32-bit word pairs of the
/// name, with a random key for each word. Wasm has no 64x64-bit multiply
/// to 128 bits, which foldhash uses, but NH needs only 32x32 to 64 bits.
/// The name gets a 0x80 byte and zeros to a whole block, and each block
/// count has its own key words. Thus two different names collide with a
/// probability of about 2^-31 for each pair, if the archive does not know
/// the key. The worker gives a random seed for each archive.
#[derive(Debug)]
struct NameHasher {
    /// The key words: `2 * n` words for each block count `n`, from
    /// `n * (n - 1)`.
    key: Vec<u32>,
    /// An odd multiplier that takes the high 32 bits of the sum.
    mix: u64,
    long: FixedState,
}

impl NameHasher {
    fn new(seed: u64) -> Self {
        // SplitMix64 makes the key from the seed.
        let mut state = seed;
        let mut next = move || {
            state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            z ^ (z >> 31)
        };
        let words = NH_BLOCKS * (NH_BLOCKS + 1);
        #[expect(
            clippy::cast_possible_truncation,
            reason = "A key word is 32 bits of the generator."
        )]
        let key = (0..words).map(|_| next() as u32).collect();
        let mix = next() | 1;
        NameHasher {
            key,
            mix,
            long: FixedState::with_seed(next()),
        }
    }

    #[expect(
        clippy::cast_possible_truncation,
        reason = "The hash is the high 32 bits of a 64-bit product."
    )]
    fn hash(&self, name: &[u8]) -> u32 {
        if name.len() >= NH_BYTES {
            return self.long.hash_one(name) as u32;
        }
        let blocks = name.len() / 8 + 1;
        let key = &self.key[blocks * (blocks - 1)..blocks * (blocks + 1)];
        let (pairs, _) = key.as_chunks::<2>();
        let (chunks, rest) = name.as_chunks::<8>();
        // The last block: the rest of the name, 0x80 and zeros. A loop of
        // at most 7 bytes is faster in wasm than a call to copy them.
        let mut last = 0x80_u64 << (8 * rest.len());
        for (index, &byte) in rest.iter().enumerate() {
            last |= u64::from(byte) << (8 * index);
        }
        let mut sum = nh_sum(chunks, pairs);
        sum = sum.wrapping_add(block(last.to_le_bytes(), pairs[blocks - 1]));
        (sum.wrapping_mul(self.mix) >> 32) as u32
    }
}

/// Returns the NH product of one block of 8 bytes and its key pair.
#[expect(
    clippy::cast_possible_truncation,
    reason = "The two halves of a block are its 32-bit words."
)]
fn block(bytes: [u8; 8], pair: [u32; 2]) -> u64 {
    let value = u64::from_le_bytes(bytes);
    let a = (value as u32).wrapping_add(pair[0]);
    let b = ((value >> 32) as u32).wrapping_add(pair[1]);
    u64::from(a) * u64::from(b)
}

/// Returns the NH sum of the blocks with their key pairs. (A wasm SIMD
/// version of this loop was slower.)
fn nh_sum(chunks: &[[u8; 8]], pairs: &[[u32; 2]]) -> u64 {
    chunks.iter().zip(pairs).fold(0, |sum, (bytes, pair)| {
        sum.wrapping_add(block(*bytes, *pair))
    })
}

/// The duplicate-name check after parsing. A stable radix sort puts the
/// name keys in the order of their hashes, and the rows of one hash stay in
/// row order. A scan then compares the names of each run of equal hashes.
#[derive(Debug, Default)]
struct NameCheck {
    other: Vec<u64>,
    /// 0 counts the digits, 1 to `DIGITS` move the keys by one digit, and
    /// `DIGITS + 1` scans.
    stage: usize,
    at: usize,
    /// The next position of each bucket, for each digit.
    offsets: Vec<usize>,
    /// The key of the first row of each name in the current run.
    firsts: Vec<u64>,
    /// In the scan: the entries of `firsts` that the key at `at` was
    /// compared with. A step can stop between two comparisons.
    compared: usize,
}

#[derive(Debug, Default)]
struct OverlapCheck {
    rows: Vec<u32>,
    other: Vec<u32>,
    stage: u8,
    at: usize,
    width: usize,
    start: usize,
    left: usize,
    right: usize,
}

/// The health checks of one archive.
#[derive(Debug)]
pub struct Health {
    hasher: NameHasher,
    /// A key for each row: the name hash in the high 32 bits, the row in
    /// the low 32 bits. A hash table of names costs a cache miss for each
    /// row, so the check sorts these keys after parsing.
    keys: Vec<u64>,
    /// The rows that the duplicate check has checked.
    names_checked: usize,
    names: Option<NameCheck>,
    duplicates: Count,
    bombs: Count,
    overlaps: Count,
    /// The rows with data that overlap another row with data. `marks` has no
    /// bit for this, so `sweep_data` counts each row one time by its order.
    data_overlaps: Count,
    /// The value of `data_overlaps` before the sort after parsing starts again
    /// from the first row. The sort finds all of these rows, but a stop at the
    /// memory limit can end it before it finds them.
    data_overlaps_live: Count,
    into_directory: Count,
    depth_cap: Count,
    folder_cap: Count,
    control_names: Count,
    wrapped: Count,
    /// Rows by the low 7 bits of `encryption`.
    encryption: [u32; 8],
    /// True while the local header offsets did not decrease. Then the
    /// overlap check runs while rows arrive.
    in_order: bool,
    last_start: u64,
    /// The start of the central directory, in the same base as each row: rawzip
    /// adds its prefix repair to both, and `Wrap` gives a row the true place.
    /// It is 0 for a part of a spanned archive, so that no row starts before it.
    directory: u64,
    /// The largest end so far, and its row.
    max_end: u64,
    max_row: u32,
    /// The largest end of a row with data, its row, and true when that row is
    /// in `data_overlaps`.
    max_data_end: u64,
    max_data_row: u32,
    max_data_counted: bool,
    /// The rows that `check_overlaps` has checked.
    checked_rows: usize,
    check: Option<OverlapCheck>,
    min_offset: u64,
    /// Rows whose `marks` changed after the row was added.
    updates: Vec<u32>,
}

impl Health {
    /// Makes the checks. `seed` keys the name hash, as for the folder hash.
    /// `directory` is the start of the central directory, or 0 when the rows
    /// have no place in this file to compare with it.
    #[must_use]
    pub fn new(seed: u64, directory: u64) -> Self {
        Health {
            hasher: NameHasher::new(seed ^ 0x6865_616c_7468),
            keys: Vec::new(),
            names_checked: 0,
            names: None,
            duplicates: Count::new(),
            bombs: Count::new(),
            overlaps: Count::new(),
            data_overlaps: Count::new(),
            data_overlaps_live: Count::new(),
            into_directory: Count::new(),
            depth_cap: Count::new(),
            folder_cap: Count::new(),
            control_names: Count::new(),
            wrapped: Count::new(),
            encryption: [0; 8],
            in_order: true,
            last_start: 0,
            directory,
            max_end: 0,
            max_row: NONE,
            max_data_end: 0,
            max_data_row: NONE,
            max_data_counted: false,
            checked_rows: 0,
            check: None,
            min_offset: u64::MAX,
            updates: Vec::new(),
        }
    }

    /// Returns the keyed hash of a stored name for `EntryFacts`.
    #[must_use]
    pub fn name_hash(&self, name: &[u8]) -> u32 {
        self.hasher.hash(name)
    }

    /// Reserves the name keys for `rows` rows.
    ///
    /// # Errors
    ///
    /// Returns [`Full`] when the memory budget has no room.
    pub fn reserve(&mut self, rows: usize) -> Result<(), Full> {
        self.keys.room(rows)
    }

    /// Allocates what `add` of one row needs: its key and the updates of
    /// the overlap check. The checks do not change.
    ///
    /// # Errors
    ///
    /// Returns [`Full`] when the memory budget has no room.
    pub fn prepare(&mut self) -> Result<(), Full> {
        self.keys.room(1)?;
        self.updates.room(2)
    }

    /// Checks the last row of the store. `limits` are the `marks` bits that
    /// the tree returned for the row. The row gets the marks of its
    /// findings. Earlier rows can get marks too.
    ///
    /// # Panics
    ///
    /// Panics if the store has no rows.
    pub fn add(&mut self, store: &mut Store, facts: EntryFacts, limits: u8) {
        let row = store.rows() - 1;
        let id = u32::try_from(row).expect("rows fit in u32");
        let key = u64::from(facts.name_hash) << 32 | u64::from(id);
        self.keys.push(key);
        self.min_offset = self.min_offset.min(facts.local_header_offset);
        let kind = usize::from(facts.encryption & 0x7f);
        if kind != 0 {
            self.encryption[kind.min(7)] += 1;
        }
        let mut bits = limits;
        if limits != 0 {
            if limits & marks::DEPTH_CAP != 0 {
                self.depth_cap.add(id);
            }
            if limits & marks::FOLDER_CAP != 0 {
                self.folder_cap.add(id);
            }
        }
        if bomb_like(facts.uncompressed_size, facts.compressed_size) {
            bits |= marks::BOMB_RATIO;
            self.bombs.add(id);
        }
        if facts.control_name {
            bits |= marks::CONTROL_NAME;
            self.control_names.add(id);
        }
        if facts.wrapped {
            bits |= marks::WRAPPED_OFFSET;
            self.wrapped.add(id);
        }
        if bits != 0 {
            store.add_marks(row, bits);
        }
        if into_directory(
            self.directory,
            facts.local_header_offset,
            facts.compressed_size,
        ) {
            self.into_directory.add(id);
        }
        if self.in_order {
            // `prepare` made room for the update of the sweep. If the caller
            // did not call it and the budget has no room, the update is lost,
            // and `refused()` stops the worker.
            let _: Result<(), Full> = self.sweep(
                store,
                id,
                facts.local_header_offset,
                facts.compressed_size,
                true,
            );
            if self.in_order {
                self.checked_rows = row + 1;
            }
        }
    }

    /// Runs at most about `budget` units of the duplicate check. Returns
    /// true when it covers all rows.
    fn check_names_step(&mut self, store: &mut Store, budget: &mut usize) -> Result<bool, Full> {
        let count = self.keys.len();
        if self.names_checked == count {
            return Ok(true);
        }
        if self.names.is_none() && self.names_checked != 0 {
            // Rows came after a complete check. Put the keys in row order
            // again, so the first row of a name stays first.
            self.keys
                .sort_unstable_by_key(|&key| key & u64::from(u32::MAX));
        }
        let mut job = match self.names.take() {
            Some(job) => job,
            None => NameCheck {
                offsets: try_vec(0, DIGITS * BUCKETS)?,
                ..NameCheck::default()
            },
        };
        while *budget > 0 {
            if job.stage > DIGITS {
                match self.scan_names(store, &mut job, budget) {
                    Ok(true) => {
                        self.names_checked = count;
                        return Ok(true);
                    }
                    Ok(false) => break,
                    Err(full) => {
                        self.names = Some(job);
                        return Err(full);
                    }
                }
            }
            let end = count.min(job.at.saturating_add(*budget));
            *budget -= end - job.at;
            if job.stage == 0 {
                for &key in &self.keys[job.at..end] {
                    for d in 0..DIGITS {
                        job.offsets[d * BUCKETS + digit(key, d)] += 1;
                    }
                }
            } else {
                let offsets = &mut job.offsets[(job.stage - 1) * BUCKETS..job.stage * BUCKETS];
                for &key in &self.keys[job.at..end] {
                    let bucket = &mut offsets[digit(key, job.stage - 1)];
                    job.other[*bucket] = key;
                    *bucket += 1;
                }
            }
            job.at = end;
            if end < count {
                continue;
            }
            job.at = 0;
            if job.stage == 0 {
                // Make each count the start of its bucket.
                for counts in job.offsets.chunks_mut(BUCKETS) {
                    let mut sum = 0;
                    for slot in counts {
                        let size = *slot;
                        *slot = sum;
                        sum += size;
                    }
                }
                job.other = match try_vec(0, count) {
                    Ok(other) => other,
                    Err(full) => {
                        self.names = Some(job);
                        return Err(full);
                    }
                };
            } else {
                std::mem::swap(&mut self.keys, &mut job.other);
                if job.stage == DIGITS {
                    job.other = Vec::new();
                }
            }
            job.stage += 1;
        }
        self.names = Some(job);
        Ok(false)
    }

    /// Scans the sorted keys from `job.at`. The first key of a run costs one
    /// unit of `budget`, and a name comparison costs one unit and one more
    /// for each `BYTES_PER_UNIT` bytes that it reads (as for search). Returns
    /// true at the end of the keys, and false when the budget is used.
    fn scan_names(
        &mut self,
        store: &mut Store,
        job: &mut NameCheck,
        budget: &mut usize,
    ) -> Result<bool, Full> {
        while job.at < self.keys.len() {
            if *budget == 0 {
                return Ok(false);
            }
            let key = self.keys[job.at];
            #[expect(
                clippy::cast_possible_truncation,
                reason = "The low 32 bits are the row."
            )]
            let row = key as u32;
            if job.compared == 0
                && (job.at == 0 || self.keys[job.at - 1] >> RUN_SHIFT != key >> RUN_SHIFT)
            {
                // The first key of a run costs one unit. A key in a run
                // costs one unit for each first key that it is compared
                // with, so each step makes progress.
                *budget -= 1;
                job.firsts.clear();
                job.firsts.try_push(key)?;
                job.at += 1;
                continue;
            }
            let mut duplicate = false;
            while job.compared < job.firsts.len() {
                if *budget == 0 {
                    return Ok(false);
                }
                *budget -= 1;
                let first = job.firsts[job.compared];
                job.compared += 1;
                if first >> 32 != key >> 32 {
                    continue;
                }
                let name = store.name(row as usize);
                #[expect(
                    clippy::cast_possible_truncation,
                    reason = "The low 32 bits are the row."
                )]
                let first_row = first as u32;
                let other = store.name(first_row as usize);
                if other.len() == name.len() {
                    // Equal lengths: the comparison reads the bytes. A
                    // stored name has at most about 192 KiB (a CP437 name of
                    // 65,535 bytes), so one comparison is short.
                    *budget = budget.saturating_sub(name.len() / BYTES_PER_UNIT);
                }
                if other == name {
                    duplicate = true;
                    break;
                }
            }
            if duplicate {
                if store.marks(row as usize) & marks::DUPLICATE_NAME == 0 {
                    self.updates.room(1)?;
                    store.add_marks(row as usize, marks::DUPLICATE_NAME);
                    self.duplicates.add(row);
                    self.updates.push(row);
                }
            } else {
                job.firsts.try_push(key)?;
            }
            job.compared = 0;
            job.at += 1;
        }
        Ok(true)
    }

    /// One step of the overlap sweep over rows in the order of their local
    /// header offsets. A row overlaps when it starts before the largest end
    /// of the rows before it (`data_end`). Ranges that only touch do not
    /// overlap. An empty entry has its 30 bytes too, so two empty entries at
    /// one local header overlap. Rows with data also go through `sweep_data`.
    fn sweep(
        &mut self,
        store: &mut Store,
        row: u32,
        start: u64,
        compressed: u64,
        live: bool,
    ) -> Result<(), Full> {
        if live && self.max_row != NONE && start < self.last_start {
            // The offsets go back. `check_overlaps` sorts the rows later.
            self.in_order = false;
            return Ok(());
        }
        if self.max_row != NONE && start < self.max_end {
            self.updates.room(2)?;
            self.last_start = start;
            self.mark_overlap(store, row, !live);
            self.mark_overlap(store, self.max_row, true);
        } else {
            self.last_start = start;
        }
        let end = data_end(start, compressed);
        if self.max_row == NONE || end > self.max_end {
            self.max_end = end;
            self.max_row = row;
        }
        if compressed != 0 {
            self.sweep_data(row, start, end);
        }
        Ok(())
    }

    /// One step of the sweep over only the rows with data. A row that overlaps
    /// counts when it arrives. The row with the largest end counts at the first
    /// row that overlaps it. A row before it that overlaps a later row also
    /// overlaps it, so that row counted when the row with the largest end came.
    fn sweep_data(&mut self, row: u32, start: u64, end: u64) {
        let overlaps = self.max_data_row != NONE && start < self.max_data_end;
        if overlaps {
            self.data_overlaps.add(row);
            if !self.max_data_counted {
                self.data_overlaps.add(self.max_data_row);
                self.max_data_counted = true;
            }
        }
        if self.max_data_row == NONE || end > self.max_data_end {
            self.max_data_end = end;
            self.max_data_row = row;
            self.max_data_counted = overlaps;
        }
    }

    /// Returns the rows with data that overlap another row with data: the count
    /// of the last sweep, or of the sweep before it while the last has fewer.
    fn data_overlap_count(&self) -> Count {
        if self.data_overlaps_live.rows > self.data_overlaps.rows {
            self.data_overlaps_live
        } else {
            self.data_overlaps
        }
    }

    fn mark_overlap(&mut self, store: &mut Store, row: u32, update: bool) {
        if store.marks(row as usize) & marks::OVERLAP == 0 {
            store.add_marks(row as usize, marks::OVERLAP);
            self.overlaps.add(row);
            if update {
                self.updates.push(row);
            }
        }
    }

    /// Runs the checks that need all rows, after parsing ends: the
    /// duplicate check, and the overlap check when the local header offsets
    /// were not in order.
    ///
    /// # Panics
    ///
    /// Panics if the store has more than `u32::MAX` rows.
    pub fn finish(&mut self, store: &mut Store) {
        while !self.finish_step(store, usize::MAX) {}
    }

    /// Runs at most about `budget` units of the final checks. Call again
    /// until it returns true. Parsing must not add rows between these calls.
    ///
    /// # Panics
    ///
    /// Panics if the store has more than `u32::MAX` rows.
    /// When the memory budget has no room for a check, the checks end
    /// without it: it returns true, `refused()` is true, and the checked
    /// flags stay false.
    pub fn finish_step(&mut self, store: &mut Store, budget: usize) -> bool {
        let mut budget = budget.max(1);
        match self.check_names_step(store, &mut budget) {
            Ok(true) => {}
            Ok(false) => return false,
            Err(Full) => return true,
        }
        if budget == 0 {
            // The duplicate check used the budget. The checks end only when
            // the overlap check is also complete.
            return self.overlaps_checked(store);
        }
        self.check_overlaps_step(store, budget).unwrap_or(true)
    }

    /// Runs at most `budget` units of the overlap check after parsing.
    fn check_overlaps_step(&mut self, store: &mut Store, budget: usize) -> Result<bool, Full> {
        if self.checked_rows == store.rows() {
            return Ok(true);
        }
        let mut job = self.check.take().unwrap_or_default();
        let result = self.overlap_steps(store, &mut job, budget);
        if result != Ok(true) {
            self.check = Some(job);
        }
        result
    }

    /// The steps of `check_overlaps_step` on `job`. Returns true when the
    /// check covers all rows.
    fn overlap_steps(
        &mut self,
        store: &mut Store,
        job: &mut OverlapCheck,
        budget: usize,
    ) -> Result<bool, Full> {
        let mut budget = budget.max(1);
        let count = store.rows();
        let order = |a: u32, b: u32| {
            store
                .value(a as usize, Column::LocalHeaderOffset)
                .total_cmp(&store.value(b as usize, Column::LocalHeaderOffset))
                .then(a.cmp(&b))
        };
        while budget > 0 {
            match job.stage {
                0 => {
                    let end = count.min(job.at.saturating_add(budget));
                    job.rows.room(end - job.at)?;
                    job.rows.extend(
                        (job.at..end).map(|row| u32::try_from(row).expect("rows fit in u32")),
                    );
                    budget -= end - job.at;
                    job.at = end;
                    if end == count {
                        job.at = 0;
                        job.stage = 1;
                    }
                }
                1 => {
                    let end = count.min(job.at + 512);
                    job.rows[job.at..end].sort_unstable_by(|&a, &b| order(a, b));
                    budget = budget.saturating_sub((end - job.at) * 12);
                    job.at = end;
                    if end == count {
                        // The merge passes write all rows to `other`.
                        job.other.room(count)?;
                        job.stage = 2;
                        job.at = 0;
                        job.width = 512;
                        job.right = count.min(512);
                    }
                }
                2 => {
                    if job.width >= count {
                        job.stage = 3;
                        job.at = 0;
                        break;
                    }
                    let middle = count.min(job.start + job.width);
                    let end = count.min(job.start + job.width * 2);
                    let left = job.left < middle;
                    let right = job.right < end;
                    if left || right {
                        let take_left = left
                            && (!right || order(job.rows[job.left], job.rows[job.right]).is_le());
                        let next = if take_left {
                            let at = job.left;
                            job.left += 1;
                            at
                        } else {
                            let at = job.right;
                            job.right += 1;
                            at
                        };
                        job.other.push(job.rows[next]);
                        budget -= 1;
                    } else {
                        job.start = end;
                        if end == count {
                            std::mem::swap(&mut job.rows, &mut job.other);
                            job.other.clear();
                            job.width *= 2;
                            job.start = 0;
                        }
                        job.left = job.start;
                        job.right = count.min(job.start + job.width);
                    }
                }
                _ => break,
            }
        }
        if job.stage == 3 {
            if job.at == 0 {
                self.max_row = NONE;
                self.max_end = 0;
                self.data_overlaps_live = self.data_overlap_count();
                self.data_overlaps = Count::new();
                self.max_data_row = NONE;
                self.max_data_end = 0;
            }
            let end = count.min(job.at.saturating_add(budget));
            while job.at < end {
                let row = job.rows[job.at];
                let start = to_u64(store.value(row as usize, Column::LocalHeaderOffset));
                let compressed = to_u64(store.value(row as usize, Column::CompressedSize));
                self.sweep(store, row, start, compressed, false)?;
                job.at += 1;
            }
            if end == count {
                self.checked_rows = count;
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Returns the rows from `first` on with data that runs into the central
    /// directory. It reads only these rows. The store is exact to 2^53, and a
    /// file is smaller, so this is the same rule as in `add`.
    #[must_use]
    pub fn into_directory_from(&self, store: &Store, first: usize) -> usize {
        (first..store.rows())
            .filter(|&row| {
                into_directory(
                    self.directory,
                    to_u64(store.value(row, Column::LocalHeaderOffset)),
                    to_u64(store.value(row, Column::CompressedSize)),
                )
            })
            .count()
    }

    /// Returns true when the duplicate check covers all rows.
    #[must_use]
    pub fn names_checked(&self, store: &Store) -> bool {
        self.names_checked == store.rows()
    }

    /// Returns true when the overlap check covers all rows.
    #[must_use]
    pub fn overlaps_checked(&self, store: &Store) -> bool {
        self.checked_rows == store.rows()
    }

    /// Returns the rows whose `marks` changed after the row was added, since
    /// the last `clear_updates`.
    #[must_use]
    pub fn updates(&self) -> &[u32] {
        &self.updates
    }

    pub fn clear_updates(&mut self) {
        self.updates.clear();
    }

    /// Returns the smallest local header offset, or `None` with no rows.
    #[must_use]
    pub fn first_offset(&self) -> Option<u64> {
        (self.min_offset != u64::MAX).then_some(self.min_offset)
    }

    /// Writes the row findings into a health vector (see
    /// `contract::health`).
    pub fn write(&self, store: &Store, fields: &mut [f64; health::FIELDS]) {
        let pairs = [
            (health::DUPLICATE_ROWS, self.duplicates),
            (health::BOMB_ROWS, self.bombs),
            (health::OVERLAP_ROWS, self.overlaps),
            (health::OVERLAP_DATA_ROWS, self.data_overlap_count()),
            (health::INTO_DIRECTORY_ROWS, self.into_directory),
            (health::DEPTH_CAP_ROWS, self.depth_cap),
            (health::FOLDER_CAP_ROWS, self.folder_cap),
            (health::CONTROL_NAME_ROWS, self.control_names),
            (health::WRAPPED_ROWS, self.wrapped),
        ];
        for (index, count) in pairs {
            let [rows, example] = count.fields();
            fields[index] = rows;
            fields[index + 1] = example;
        }
        fields[health::OVERLAPS_CHECKED] = f64::from(u8::from(self.overlaps_checked(store)));
        fields[health::DUPLICATES_CHECKED] = f64::from(u8::from(self.names_checked(store)));
        for kind in 1..=6 {
            fields[health::ENCRYPTED + kind - 1] = f64::from(self.encryption[kind]);
        }
    }

    /// Fills the row findings of a summary.
    pub fn summarize(&self, summary: &mut Summary) {
        summary.duplicate_rows = u64::from(self.duplicates.rows);
        summary.bomb_rows = u64::from(self.bombs.rows);
        summary.overlap_rows = u64::from(self.overlaps.rows);
        summary.overlap_data_rows = u64::from(self.data_overlap_count().rows);
        summary.into_directory_rows = u64::from(self.into_directory.rows);
        summary.depth_cap_rows = u64::from(self.depth_cap.rows);
        summary.folder_cap_rows = u64::from(self.folder_cap.rows);
        summary.control_name_rows = u64::from(self.control_names.rows);
        summary.wrapped_rows = u64::from(self.wrapped.rows);
        for kind in 1..7 {
            summary.encrypted_counts[kind] = u64::from(self.encryption[kind]);
        }
    }

    /// Returns the bytes that the checks have allocated.
    #[must_use]
    pub fn allocated_bytes(&self) -> usize {
        (self.keys.capacity() + self.names.as_ref().map_or(0, |job| job.other.capacity()))
            * size_of::<u64>()
            + self.names.as_ref().map_or(0, |job| {
                (job.offsets.capacity()) * size_of::<usize>()
                    + job.firsts.capacity() * size_of::<u64>()
            })
            + (self.updates.capacity()
                + self
                    .check
                    .as_ref()
                    .map_or(0, |job| job.rows.capacity() + job.other.capacity()))
                * size_of::<u32>()
    }
}

#[cfg(test)]
mod tests {
    use super::{NH_BYTES, NameHasher};

    #[test]
    fn the_name_hash_separates_padding_lengths_and_seeds() {
        let hasher = NameHasher::new(7);
        let names: [&[u8]; 9] = [
            b"",
            b"\0",
            b"\x80",
            b"ab",
            b"ab\0",
            b"ab\x80",
            b"12345678",
            b"12345678\x80",
            b"a/b\\c",
        ];
        for (index, a) in names.iter().enumerate() {
            assert_eq!(hasher.hash(a), hasher.hash(a));
            for b in &names[index + 1..] {
                assert_ne!(hasher.hash(a), hasher.hash(b), "{a:?} {b:?}");
            }
        }
        // Long names use foldhash, also keyed by the seed.
        let long = vec![b'x'; NH_BYTES + 10];
        assert_eq!(hasher.hash(&long), hasher.hash(&long));
        let other = NameHasher::new(8);
        assert_ne!(hasher.hash(b"name"), other.hash(b"name"));
        assert_ne!(hasher.hash(&long), other.hash(&long));
    }

    #[test]
    fn the_name_hash_has_few_collisions_in_similar_names() {
        let hasher = NameHasher::new(0x1234_5678);
        let mut values: Vec<u32> = (0..200_000)
            .map(|row| {
                hasher.hash(
                    format!("project/src/module-{:03}/file-{row:07}.txt", row / 1000).as_bytes(),
                )
            })
            .collect();
        values.sort_unstable();
        let equal = values.windows(2).filter(|pair| pair[0] == pair[1]).count();
        // About n^2 / 2^33 = 4.7 for random 32-bit values.
        assert!(equal < 40, "{equal} equal hashes");
    }
}
