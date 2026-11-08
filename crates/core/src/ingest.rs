//! Central-directory iteration into the store, in batches.

use rawzip::{ReaderAt, ZipArchive, ZipEntries, ZipFileHeaderRecord};
use zipscope_layout::end::{EndNotes, EndReader, OpenedEnd, open_end};

use crate::contract::{CHUNK_BYTES, Column, ENTRIES_BUFFER_BYTES, NameSource, health, marks};
use crate::entry::Extras;
use crate::health::{EntryFacts, Health, Summary, covers};
use crate::largest::Largest;
use crate::query::{Sort, SortColumn};
use crate::store::{Row, Store, StoreFull};
use crate::text;
use crate::tree::{MAX_FOLDERS, Tree};
use crate::view::Views;
use crate::wrap::Wrap;

/// The state of an ingest after a batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// More entries can follow.
    Parsing,
    /// The central directory ended.
    Complete,
    /// Parsing stopped with an error. The rows before the error stay.
    Failed(String),
}

/// Interim until rawzip has a resumable cursor. A batch must
/// keep the entries iterator alive across calls from JS, but the iterator
/// borrows the archive and the buffer.
///
/// This function leaks both to get a `'static` iterator. Each archive has
/// its own worker. The worker stops when the archive closes, so the wasm
/// instance gives the memory back.
fn leak_entries<R: ReaderAt + 'static>(
    archive: ZipArchive<R>,
    buffer: Vec<u8>,
) -> (&'static ZipArchive<R>, ZipEntries<'static, 'static, R>) {
    let archive: &'static ZipArchive<R> = Box::leak(Box::new(archive));
    let buffer: &'static mut [u8] = Box::leak(buffer.into_boxed_slice());
    (archive, archive.entries(buffer))
}

/// The reads for the rows of an archive of the wrapped shape. One read costs
/// about 0.6 ms in the browser, so these take about 2 to 3 s at most. After them,
/// each row follows the row before it with no read (`Wrap::follow`).
const PLACE_READS: u32 = 1 << 12;

/// Finds the true place of each row of an archive of the wrapped shape.
#[derive(Debug)]
struct Placer {
    wrap: Wrap,
    /// The end of the data of the row before.
    after: u64,
    reads: u32,
}

impl Placer {
    fn place<R: ReaderAt>(&mut self, reader: &R, entry: &ZipFileHeaderRecord) -> Place {
        let given = entry.local_header_offset();
        let name = entry.file_path().as_bytes();
        let moved = if self.reads > 0 {
            self.wrap
                .place(reader, given, name, self.after, &mut self.reads)
        } else {
            self.wrap.follow(given, self.after)
        };
        let offset = moved.unwrap_or(given);
        self.after = offset.saturating_add(entry.compressed_size_hint());
        Place {
            offset,
            wrapped: moved.is_some(),
        }
    }
}

/// The local header offset of a row.
#[derive(Debug, Clone, Copy)]
struct Place {
    offset: u64,
    /// True when the offset is not the one that rawzip gives.
    wrapped: bool,
}

/// Decodes one central-directory record and adds it to the store. Returns
/// the values that the health checks use.
#[expect(
    clippy::cast_precision_loss,
    reason = "The shared store uses f64 sizes and offsets, as the contract requires."
)]
fn push_entry(
    store: &mut Store,
    tree: &mut Tree,
    health: &mut Health,
    entry: &ZipFileHeaderRecord,
    place: Place,
) -> Result<EntryFacts, StoreFull> {
    let extras = Extras::scan(entry.extra_fields().remaining_bytes());
    let flags = entry.flags();
    let raw_name = entry.file_path().as_bytes();
    let (name, name_source) = text::decode(raw_name, flags.is_utf8(), extras.unicode_path);
    // Bit 11 is for the name and the comment.
    let (comment, _) = text::decode(
        entry.comment().as_bytes(),
        flags.is_utf8(),
        extras.unicode_comment,
    );
    let (modified, time_kind) = extras.modified(entry.last_modified_dos());
    let method = entry.compression_method().as_u16();
    let (encryption, aes_method) = extras.encryption(method, flags.bits());
    let lossy = name_source == NameSource::Lossy;
    let local_header_offset = place.offset;
    let compressed_size = entry.compressed_size_hint();
    let uncompressed_size = entry.uncompressed_size_hint();
    let row = Row {
        uncompressed_size: uncompressed_size as f64,
        compressed_size: compressed_size as f64,
        local_header_offset: local_header_offset as f64,
        modified,
        name: name.as_bytes(),
        comment: comment.as_bytes(),
        crc32: entry.crc32(),
        external_attributes: entry.external_attributes(),
        method,
        flags: flags.bits(),
        version_made_by: entry.version_made_by().as_u16(),
        aes_method,
        name_source: name_source as u8,
        time_kind: time_kind as u8,
        encryption,
        marks: if lossy { marks::RAW_NAME_KEPT } else { 0 },
    };
    // Allocate all that the row needs before any part of it is added. When
    // the memory budget has no room, the store, the tree and the checks
    // stay as they were: `Store::push` allocates its part before it adds
    // the row.
    let raw = lossy.then_some(raw_name);
    tree.prepare(row.name)
        .and_then(|()| health.prepare())
        .map_err(|_full| StoreFull::Memory)?;
    store.push(&row, raw)?;
    Ok(EntryFacts {
        local_header_offset,
        compressed_size,
        uncompressed_size,
        encryption,
        name_hash: health.name_hash(row.name),
        text_bytes: row.name.len() + row.comment.len() + if lossy { raw_name.len() } else { 0 },
        control_name: text::counts_as_control(&name),
        wrapped: place.wrapped,
        name_and_extra: (raw_name.len() + entry.extra_fields().remaining_bytes().len()) as u64,
    })
}

/// The estimated bytes of one row, not counting its name and comment: the
/// columns, the health key, the tree links and the views, with room for
/// the growth of these lists.
const ROW_BYTES: usize = 256;
/// The estimated bytes of one folder (about 170, see `tree::MAX_FOLDERS`).
const FOLDER_BYTES: usize = 256;
/// The estimate for each stored byte of a name or comment, for the copies
/// that a decode makes. The arena chunks count when the store allocates
/// them.
const TEXT_FACTOR: usize = 2;

/// The work units of the final checks that the last `parse` call of a
/// listing of at most 16,384 rows runs (about 1 ms).
const INLINE_CHECK_UNITS: usize = 1 << 18;

/// An end record with no Zip64 holds the low 16 bits of the entry count.
const COUNT_WRAP: u64 = 1 << 16;

/// Reads the central directory of one archive into a store.
#[derive(Debug)]
pub struct Ingest<R: 'static> {
    archive: &'static ZipArchive<EndReader<R>>,
    entries: ZipEntries<'static, 'static, EndReader<R>>,
    /// What the walk to the end record saw.
    end_notes: EndNotes,
    /// The end records before the chosen record with a directory, as places of
    /// the record and the directory, that no row has covered so far.
    earlier: Vec<(u64, u64)>,
    /// True when a Zip64 locator is before the end record.
    locator: bool,
    store: Store,
    tree: Tree,
    views: Views,
    /// The query of `largest_files`.
    query: Largest,
    health: Health,
    status: Status,
    last_record_offset: u64,
    size: u64,
    /// Is present only for an archive of the wrapped shape.
    placer: Option<Placer>,
    /// The reader of the local headers of `placer`, so that the window of
    /// the reader of the archive stays. Without it, the reader of the
    /// archive reads them.
    probes: Option<R>,
}

impl<R: ReaderAt + 'static> Ingest<R> {
    /// Finds the end of the central directory of an archive of `size` bytes.
    ///
    /// # Errors
    ///
    /// Returns an error if the reader fails or the archive end cannot be found.
    pub fn open(reader: R, size: u64) -> Result<Self, rawzip::Error> {
        Self::with_buffer(reader, size, ENTRIES_BUFFER_BYTES)
    }

    /// Like `open`, with a different buffer size. Tests use it.
    ///
    /// # Errors
    ///
    /// Returns an error if the reader fails or the archive end cannot be found.
    pub fn with_buffer(reader: R, size: u64, buffer_bytes: usize) -> Result<Self, rawzip::Error> {
        Self::with_limits(reader, size, buffer_bytes, MAX_FOLDERS, 0)
    }

    /// Like `open`, with a seed for the folder hash. The worker gives a
    /// random seed for each archive, so that an archive cannot make folder
    /// names that collide.
    ///
    /// # Errors
    ///
    /// Returns an error if the reader fails or the archive end cannot be found.
    pub fn with_seed(reader: R, size: u64, seed: u64) -> Result<Self, rawzip::Error> {
        Self::with_limits(reader, size, ENTRIES_BUFFER_BYTES, MAX_FOLDERS, seed)
    }

    /// Like `open`, with a smaller folder table. Tests use it.
    ///
    /// # Errors
    ///
    /// Returns an error if the reader fails or the archive end cannot be found.
    pub fn with_folder_limit(
        reader: R,
        size: u64,
        max_folders: usize,
    ) -> Result<Self, rawzip::Error> {
        Self::with_limits(reader, size, ENTRIES_BUFFER_BYTES, max_folders, 0)
    }

    fn with_limits(
        reader: R,
        size: u64,
        buffer_bytes: usize,
        max_folders: usize,
        seed: u64,
    ) -> Result<Self, rawzip::Error> {
        let buffer = vec![0u8; buffer_bytes];
        let OpenedEnd {
            archive,
            notes: end_notes,
            locator,
            other_disk,
            earlier,
        } = open_end(reader, size)?;
        let directory_offset = archive.directory_offset();
        let placer = Wrap::detect(&archive).map(|wrap| Placer {
            wrap,
            after: 0,
            reads: PLACE_READS,
        });
        let store = Store::with_hint(archive.entries_hint());
        let mut health = Health::new(seed, if other_disk { 0 } else { directory_offset });
        // The entry count can be false. Reserve at most 65,536 keys
        // (512 KiB) before the memory budget can check the rows, and not
        // more than the records that fit after the directory start (a record
        // has at least 46 bytes). The keys of a larger archive grow by
        // doubling.
        let records = size.saturating_sub(archive.directory_offset()) / 46;
        let reserve = archive.entries_hint().min(records).min(1 << 16);
        // When the budget has no room, `refused()` stops the parse.
        let _: Result<(), zipscope_heap::Full> =
            health.reserve(usize::try_from(reserve).unwrap_or(0));
        let (archive, entries) = leak_entries(archive, buffer);
        Ok(Ingest {
            archive,
            entries,
            end_notes,
            earlier,
            locator,
            store,
            tree: Tree::with_options(max_folders, seed),
            views: Views::new(),
            query: Largest::new(),
            health,
            status: Status::Parsing,
            last_record_offset: directory_offset,
            size,
            placer,
            probes: None,
        })
    }

    /// Sets the reader of the local headers of an archive of the wrapped
    /// shape. No other archive reads local headers while it parses.
    pub fn set_probes(&mut self, probes: R) {
        self.probes = Some(probes);
    }

    /// Sets the reads for the rows of an archive of the wrapped shape.
    /// Tests use a small value.
    #[doc(hidden)]
    pub fn set_place_reads(&mut self, reads: u32) {
        if let Some(placer) = &mut self.placer {
            placer.reads = reads;
        }
    }

    /// Parses up to `max_entries` entries and returns how many it added.
    pub fn parse(&mut self, max_entries: u32) -> u32 {
        self.parse_within(max_entries, usize::MAX)
    }

    /// Like `parse`, but stops after the entry whose estimated allocation
    /// makes the total of this call `max_bytes` or more. Thus the caller
    /// can limit the memory that one batch adds. The estimate counts the
    /// pages and the arena chunks (4 MiB) that the store allocates, when
    /// it allocates them, and the text bytes of the rows more than once.
    ///
    /// After the first entry of the call, it also stops before an entry
    /// that can allocate a page or a chunk that does not fit in the rest
    /// of `max_bytes` (`room_for_next`). Thus a page or a chunk starts a
    /// call, and the caller can check the room for it and its mirror
    /// before the rows of the call are lost to a refusal.
    pub fn parse_within(&mut self, max_entries: u32, max_bytes: usize) -> u32 {
        let mut added = 0;
        let mut used = 0_usize;
        // After the budget refused a growth, the worker stops at the hard
        // stop. The status stays `Parsing`: the stop is not a parse error.
        while added < max_entries
            && self.status == Status::Parsing
            && used < max_bytes
            && (added == 0 || self.room_for_next(used, max_bytes))
            && !zipscope_heap::refused()
            && !self.views.tree_order_started()
        {
            match self.entries.next_entry() {
                Ok(Some(entry)) => {
                    self.last_record_offset = entry.central_directory_offset();
                    let store_bytes = self.store.allocated_bytes();
                    let folders = self.tree.folder_count();
                    let place = match &mut self.placer {
                        None => Place {
                            offset: entry.local_header_offset(),
                            wrapped: false,
                        },
                        Some(placer) => placer.place(
                            self.probes
                                .as_ref()
                                .unwrap_or(self.archive.get_ref().inner()),
                            &entry,
                        ),
                    };
                    let facts = match push_entry(
                        &mut self.store,
                        &mut self.tree,
                        &mut self.health,
                        &entry,
                        place,
                    ) {
                        Ok(facts) => facts,
                        Err(StoreFull::Memory) => break,
                        Err(full) => {
                            self.status = Status::Failed(full.to_string());
                            break;
                        }
                    };
                    self.earlier.retain(|&(place, _)| {
                        !covers(
                            place,
                            facts.local_header_offset,
                            facts.compressed_size,
                            facts.name_and_extra,
                        )
                    });
                    let text = facts.text_bytes;
                    let limits = self.add_to_tree();
                    self.health.add(&mut self.store, facts, limits);
                    added += 1;
                    used = used
                        .saturating_add(ROW_BYTES + TEXT_FACTOR * text)
                        .saturating_add(self.store.allocated_bytes() - store_bytes)
                        .saturating_add((self.tree.folder_count() - folders) * FOLDER_BYTES);
                }
                Ok(None) => self.status = Status::Complete,
                Err(err) => self.status = Status::Failed(err.to_string()),
            }
        }
        if self.status != Status::Parsing
            && self.store.rows() <= 16_384
            && !zipscope_heap::refused()
        {
            // Run small checks here, with a bounded budget. The worker runs
            // the remaining checks in bounded steps after parsing.
            self.finish_checks_step(INLINE_CHECK_UNITS);
        }
        added
    }

    /// Returns false when the next entry can allocate a page or a chunk
    /// that does not fit in the part of `max_bytes` that is not `used`.
    /// Then the call stops, and the next call starts with that entry.
    ///
    /// Most archives have no comments, so the first chunk of the comment
    /// arena counts only when it fits in `max_bytes`. Else, near the hard
    /// stop, each call of an archive without comments would add only one
    /// row. Near the hard stop, that chunk and its mirror cannot fit, so
    /// the first comment then stops the parse.
    fn room_for_next(&self, used: usize, max_bytes: usize) -> bool {
        let mut bound = self.store.next_growth_bound();
        if !self.store.has_comment_chunk() && CHUNK_BYTES < max_bytes {
            bound += CHUNK_BYTES;
        }
        used.saturating_add(bound) < max_bytes
    }

    /// Adds the last row of the store to the tree. Returns the `marks` bits
    /// of the tree limits that moved the row.
    fn add_to_tree(&mut self) -> u8 {
        let store = &self.store;
        let row = store.rows() - 1;
        self.tree.insert(
            store.names(),
            u32::try_from(row).expect("rows fit in u32"),
            store.name(row),
            store.name_offset(row),
            store.value(row, Column::UncompressedSize),
            store.value(row, Column::CompressedSize),
        )
    }

    /// Runs the checks that need all rows: the duplicate check, and the
    /// overlap check when the local header offsets were not in order. Call
    /// it when parsing ends, also after an error or a stop.
    pub fn finish_checks(&mut self) {
        self.health.finish(&mut self.store);
    }

    /// Runs a bounded part of the final checks. Returns true when they end.
    pub fn finish_checks_step(&mut self, budget: usize) -> bool {
        self.health.finish_step(&mut self.store, budget)
    }

    /// True when the declared count is what a writer with no Zip64 keeps of
    /// the row count: its low 16 bits. A count of a Zip64 record has 64 bits, so
    /// this rule does not apply when a locator is there.
    fn count_wrapped(&self) -> bool {
        let rows = self.store.rows() as u64;
        let declared = self.entries_hint();
        self.status == Status::Complete
            && !self.locator
            && declared != rows
            && declared == rows % COUNT_WRAP
    }

    /// True when parsing is complete, and the declared count is not the row
    /// count by any rule.
    fn count_mismatch(&self) -> bool {
        self.status == Status::Complete
            && self.entries_hint() != self.store.rows() as u64
            && !self.count_wrapped()
    }

    fn prelude_bytes(&self) -> u64 {
        self.health.first_offset().unwrap_or_else(|| {
            if self.status == Status::Complete && self.store.rows() == 0 {
                self.archive.directory_offset()
            } else {
                0
            }
        })
    }

    /// Returns the findings as Rust values.
    #[must_use]
    pub fn health(&self) -> Summary {
        let rows = self.store.rows() as u64;
        let declared = self.entries_hint();
        let mut summary = Summary {
            terminal_error: match &self.status {
                Status::Failed(message) => Some(message.clone()),
                _ => None,
            },
            count_mismatch: self.count_mismatch().then_some((declared, rows)),
            count_wrapped: self.count_wrapped(),
            prelude_bytes: self.prelude_bytes(),
            epilogue_bytes: self.size.saturating_sub(self.archive.end_offset()),
            encrypted_counts: [0; 7],
            duplicate_rows: 0,
            bomb_rows: 0,
            overlap_rows: 0,
            overlap_data_rows: 0,
            into_directory_rows: 0,
            depth_cap_rows: 0,
            folder_cap_rows: 0,
            control_name_rows: 0,
            wrapped_rows: 0,
            end_notes: self.end_notes,
        };
        self.health.summarize(&mut summary);
        summary
    }

    /// Returns the health vector. `contract::health` gives the indexes.
    #[must_use]
    #[expect(
        clippy::cast_precision_loss,
        reason = "Health values are counts and byte counts for display."
    )]
    pub fn health_vector(&self) -> [f64; health::FIELDS] {
        let mut fields = [0.0; health::FIELDS];
        self.health.write(&self.store, &mut fields);
        fields[health::DECLARED_ENTRIES] = self.entries_hint() as f64;
        fields[health::COUNT_MISMATCH] = f64::from(u8::from(self.count_mismatch()));
        fields[health::COUNT_WRAPPED] = f64::from(u8::from(self.count_wrapped()));
        fields[health::PRELUDE_BYTES] = self.prelude_bytes() as f64;
        fields[health::EPILOGUE_BYTES] = self.size.saturating_sub(self.archive.end_offset()) as f64;
        let notes = self.end_notes;
        if let Some(cut) = notes.cut_comment {
            fields[health::COMMENT_DECLARED] = f64::from(cut.declared);
            fields[health::COMMENT_PRESENT] = f64::from(cut.present);
        }
        fields[health::END_SKIPPED] = f64::from(notes.skipped);
        fields[health::END_OTHERS] = f64::from(notes.other_records);
        fields[health::END_UNCHECKED] = f64::from(notes.unchecked);
        fields[health::END_SECOND_DIRECTORY] = f64::from(u8::from(notes.second_directory));
        if let Some(declared) = notes.declared_after_directory {
            fields[health::END_DECLARED_DIRECTORY] = declared as f64;
            fields[health::END_FOUND_DIRECTORY] = self.archive.directory_offset() as f64;
        }
        // Only all rows can show that no row covers a record.
        if self.status == Status::Complete
            && let Some(&(record, directory)) = self.earlier.first()
        {
            fields[health::END_EARLIER_RECORDS] = self.earlier.len() as f64;
            fields[health::END_EARLIER_RECORD] = record as f64;
            fields[health::END_EARLIER_DIRECTORY] = directory as f64;
        }
        fields
    }

    /// Returns the number of rows from `first` on with a bit of `marks`. It
    /// reads only these rows, and at the hard stop these are the rows of the
    /// last batch, which no publish counted.
    #[must_use]
    pub fn marked_from(&self, first: usize, bit: u8) -> usize {
        (first..self.store.rows())
            .filter(|&row| self.store.marks(row) & bit != 0)
            .count()
    }

    /// Returns the number of rows from `first` on with data that runs into the
    /// central directory. No bit of `marks` holds this finding, so `marked_from`
    /// cannot count them.
    #[must_use]
    pub fn into_directory_from(&self, first: usize) -> usize {
        self.health.into_directory_from(&self.store, first)
    }

    /// Returns the rows whose `marks` changed after the row was added.
    #[must_use]
    pub fn mark_updates(&self) -> &[u32] {
        self.health.updates()
    }

    /// Clears the rows whose `marks` changed. The worker calls it after it
    /// copies their `marks` values.
    pub fn clear_mark_updates(&mut self) {
        self.health.clear_updates();
    }

    /// Returns the bytes that the store, the tree, the views and the checks
    /// have allocated, with the entries buffer.
    #[must_use]
    pub fn allocated_bytes(&self) -> usize {
        self.store.allocated_bytes()
            + self.tree.allocated_bytes()
            + self.views.allocated_bytes()
            + self.health.allocated_bytes()
            + ENTRIES_BUFFER_BYTES
    }

    /// Returns the folder tree.
    #[must_use]
    pub fn tree(&self) -> &Tree {
        &self.tree
    }

    /// Returns the views of the tree.
    #[must_use]
    pub fn views(&self) -> &Views {
        &self.views
    }

    /// Makes the views again where the tree changed. Returns true when a
    /// view changed.
    pub fn refresh_views(&mut self) -> bool {
        self.views.refresh(&mut self.tree, &self.store)
    }

    /// Merges pending rows into the listing in the sort order, or makes a
    /// step of a build, for about `budget` units of work. Returns true
    /// when the merge or the build ended and the listing changed.
    pub fn merge_views(&mut self, budget: usize) -> bool {
        self.views.merge(&self.tree, &self.store, budget)
    }

    /// Starts the job that puts the tree in name order. After it, this parse
    /// adds no more rows, also when the status is still `Parsing`, as it is
    /// after a cancel. A job with little work ends in this call.
    pub fn start_tree_order(&mut self) {
        self.views.start_tree_order(&self.tree, &self.store);
    }

    /// Runs the job of the tree order for about `budget` units of work.
    /// Returns true when the job ended and the tree changed.
    pub fn tree_order_step(&mut self, budget: usize) -> bool {
        self.views.tree_order_step(&self.tree, &self.store, budget)
    }

    /// Sets the units of work above which a view request runs in steps.
    /// Tests use a small value, so that small archives build in steps.
    #[doc(hidden)]
    pub fn set_view_step_threshold(&mut self, units: usize) {
        self.views.set_step_threshold(units);
    }

    /// Returns true while a new sort, search or folder listing is made in
    /// steps by `merge_views`.
    #[must_use]
    pub fn views_building(&self) -> bool {
        self.views.building()
    }

    /// Returns a number that changes each time a new listing starts.
    #[must_use]
    pub fn views_build_epoch(&self) -> u32 {
        self.views.build_epoch()
    }

    /// Returns true when the listing waits for `merge_views`.
    #[must_use]
    pub fn merge_pending(&self) -> bool {
        self.views.merge_pending()
    }

    /// Makes the views again and ends any merge, so the listing shows all
    /// parsed rows in the sort order. The worker uses `refresh_views` and
    /// `merge_views` to spread this work over steps.
    pub fn settle_views(&mut self) -> bool {
        let mut changed = self.refresh_views();
        while self.merge_pending() {
            changed |= self.merge_views(usize::MAX);
        }
        changed
    }

    /// Sets the sort order that the user chose.
    pub fn sort(&mut self, column: SortColumn, descending: bool) {
        self.views.set_sort(Sort { column, descending });
    }

    /// Sets the default sort, which is not a choice of the user. A search
    /// with no sort chosen stays in the best-match order. It does nothing
    /// after a choice.
    pub fn default_sort(&mut self) {
        self.views.set_default_sort();
    }

    /// Sets the search. An empty query lists the selected folder again.
    pub fn search(&mut self, query: impl AsRef<[u8]>) {
        self.views.set_search(query.as_ref());
    }

    /// Returns the rows of the largest files below `folder`, from the
    /// largest (see `largest`). It does not depend on the
    /// views: a query of its own follows the folder of the last call, so
    /// a call for the same folder reads only the rows that came after the
    /// last call. Returns `None` for an unknown folder, and after the
    /// memory budget refused a growth.
    pub fn largest_files(&mut self, folder: u32) -> Option<Vec<u32>> {
        if folder as usize >= self.tree.folder_count() || zipscope_heap::refused() {
            return None;
        }
        self.query.follow(&self.tree, &self.store, folder);
        self.query.take_rows(&self.tree, &self.store);
        while self.query.scanning() {
            self.query.step(&self.tree, &self.store, usize::MAX);
        }
        let ranked = self.query.ranked();
        let mut rows = zipscope_heap::try_with_capacity(ranked.len()).ok()?;
        rows.extend_from_slice(ranked);
        Some(rows)
    }

    /// Returns the largest uncompressed size of a row of the listing.
    #[must_use]
    pub fn listing_largest(&self) -> f64 {
        self.views.listing_largest(&self.tree)
    }

    /// Lists a folder. Returns false for an unknown folder.
    pub fn list(&mut self, folder: u32) -> bool {
        self.views.list(&self.tree, folder)
    }

    /// Expands or collapses the tree row that ends at a folder. Returns
    /// false for an unknown folder.
    pub fn expand(&mut self, folder: u32, open: bool) -> bool {
        self.views.expand(&self.tree, folder, open)
    }

    /// Returns the folder that lists a row: for an entry, its folder; for
    /// the explicit row of a folder, that folder with `FOLDER_TAG`.
    /// Returns `NONE` for an unknown row.
    #[must_use]
    pub fn entry_folder(&self, row: u32) -> u32 {
        self.tree.row_folder(row)
    }

    /// Opens or closes the table row that ends at a folder in place. With
    /// `deep`, all folders below it change too. Returns false for an
    /// unknown folder.
    pub fn expand_inline(&mut self, folder: u32, open: bool, deep: bool) -> bool {
        self.views.expand_inline(&self.tree, folder, open, deep)
    }

    /// Clears the list of folders whose explicit row changed. The worker
    /// calls it after it copies those records.
    pub fn clear_folder_updates(&mut self) {
        self.tree.clear_updates();
    }

    #[must_use]
    pub fn status(&self) -> &Status {
        &self.status
    }

    #[must_use]
    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Returns the entry count from the end of central directory record. It
    /// is a hint only, because an archive can give a false count.
    #[must_use]
    pub fn entries_hint(&self) -> u64 {
        self.archive.entries_hint()
    }

    #[must_use]
    pub fn directory_offset(&self) -> u64 {
        self.archive.directory_offset()
    }

    #[must_use]
    pub fn eocd_offset(&self) -> u64 {
        self.archive.eocd_offset()
    }

    /// Returns the part of the central directory that is parsed, from 0 to 1.
    #[must_use]
    #[expect(
        clippy::cast_precision_loss,
        reason = "Progress is an approximate ratio of byte offsets."
    )]
    pub fn progress(&self) -> f64 {
        if self.status == Status::Complete {
            return 1.0;
        }
        let start = self.directory_offset();
        let end = self.eocd_offset();
        if end <= start {
            return 0.0;
        }
        let done = self.last_record_offset.saturating_sub(start) as f64;
        (done / (end - start) as f64).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{TimeKind, encryption};
    use crate::testzip::{Record, archive};
    use rawzip::extra_fields::ExtraFieldId;
    use rawzip::path::EntryPath;
    use rawzip::{Header, ZipArchiveWriter};
    use std::io::Write;

    fn build(entries: &[(EntryPath<'_>, Vec<u8>)]) -> Vec<u8> {
        let mut output = Vec::new();
        let mut archive = ZipArchiveWriter::new(&mut output);
        for (path, body) in entries {
            let (mut entry, config) = archive.new_file(path.clone()).start().unwrap();
            let mut writer = config.wrap(&mut entry);
            writer.write_all(body).unwrap();
            let (_, descriptor) = writer.finish().unwrap();
            entry.finish(descriptor).unwrap();
        }
        archive.finish().unwrap();
        output
    }

    fn names(count: usize) -> Vec<String> {
        (0..count)
            .map(|i| format!("dir-{:02}/file-{i:05}.txt", i % 17))
            .collect()
    }

    fn archive_of(names: &[String]) -> Vec<u8> {
        let entries: Vec<_> = names
            .iter()
            .map(|name| (EntryPath::conformant(name.as_str()), Vec::new()))
            .collect();
        build(&entries)
    }

    fn open(data: Vec<u8>) -> Ingest<Vec<u8>> {
        let size = data.len() as u64;
        Ingest::open(data, size).unwrap()
    }

    fn stored_names(ingest: &Ingest<Vec<u8>>) -> Vec<String> {
        let store = ingest.store();
        (0..store.rows())
            .map(|row| String::from_utf8(store.name(row).to_vec()).unwrap())
            .collect()
    }

    #[test]
    fn parses_in_batches() {
        let expected = names(2_000);
        let mut ingest = open(archive_of(&expected));
        assert_eq!(ingest.entries_hint(), 2_000);
        let mut progress = ingest.progress();
        assert_eq!(progress, 0.0);
        let mut batches = 0;
        while *ingest.status() == Status::Parsing {
            let added = ingest.parse(7);
            assert!(added <= 7);
            assert!(ingest.progress() >= progress);
            progress = ingest.progress();
            batches += 1;
        }
        assert_eq!(*ingest.status(), Status::Complete);
        assert_eq!(batches, 2_000_usize.div_ceil(7));
        assert_eq!(ingest.progress(), 1.0);
        assert_eq!(stored_names(&ingest), expected);
        assert_eq!(ingest.parse(10), 0);
    }

    #[test]
    fn parses_more_than_u16_entries() {
        let expected = names(70_000);
        let mut ingest = open(archive_of(&expected));
        assert_eq!(ingest.parse(u32::MAX), 70_000);
        assert_eq!(*ingest.status(), Status::Complete);
        assert_eq!(ingest.store().page_count(), 2);
        assert_eq!(stored_names(&ingest), expected);
    }

    #[test]
    fn rejects_data_that_is_not_a_zip() {
        let data = b"not a zip".to_vec();
        Ingest::open(data, 9).unwrap_err();
    }

    #[test]
    fn keeps_rows_before_an_error() {
        let expected = names(100);
        let mut data = archive_of(&expected);
        // Break the signature of the central-directory record for row 40.
        let records: Vec<usize> = data
            .windows(4)
            .enumerate()
            .filter(|(_, window)| *window == b"PK\x01\x02")
            .map(|(index, _)| index)
            .collect();
        assert_eq!(records.len(), 100);
        data[records[40]] = b'X';
        let mut ingest = open(data);
        assert_eq!(ingest.parse(u32::MAX), 40);
        assert!(matches!(ingest.status(), Status::Failed(_)));
        assert_eq!(stored_names(&ingest), &expected[..40]);
        assert_eq!(ingest.parse(10), 0);
    }

    fn largest_record() -> Vec<u8> {
        let name = "n".repeat(u16::MAX as usize);
        let mut output = Vec::new();
        let mut archive = ZipArchiveWriter::new(&mut output);
        let (mut entry, config) = archive
            .new_file(name.as_str())
            .extra_field(
                ExtraFieldId::new(0xcafe),
                &vec![1u8; 65_531],
                Header::CENTRAL,
            )
            .unwrap()
            .comment(vec![b'c'; u16::MAX as usize])
            .start()
            .unwrap();
        let writer = config.wrap(&mut entry);
        let (_, descriptor) = writer.finish().unwrap();
        entry.finish(descriptor).unwrap();
        archive.finish().unwrap();
        output
    }

    #[test]
    fn reads_the_largest_central_directory_record() {
        let mut ingest = open(largest_record());
        assert_eq!(ingest.parse(10), 1);
        assert_eq!(*ingest.status(), Status::Complete);
        assert_eq!(ingest.store().name(0).len(), u16::MAX as usize);
    }

    #[test]
    fn the_default_rawzip_buffer_is_too_small() {
        let data = largest_record();
        let size = data.len() as u64;
        let mut ingest = Ingest::with_buffer(data, size, rawzip::RECOMMENDED_BUFFER_SIZE).unwrap();
        assert_eq!(ingest.parse(10), 0);
        assert!(matches!(ingest.status(), Status::Failed(_)));
    }

    fn ingest_all(records: &[Record]) -> Ingest<Vec<u8>> {
        let mut ingest = open(archive(records));
        ingest.parse(u32::MAX);
        assert_eq!(*ingest.status(), Status::Complete);
        ingest
    }

    fn value(ingest: &Ingest<Vec<u8>>, row: usize, column: Column) -> f64 {
        ingest.store().value(row, column)
    }

    fn unicode_path(raw: &[u8], name: &str) -> Vec<u8> {
        let mut field = vec![1];
        field.extend_from_slice(&rawzip::crc32(raw).to_le_bytes());
        field.extend_from_slice(name.as_bytes());
        field
    }

    #[test]
    fn decodes_names_from_each_source() {
        let cp437 = b"caf\x82/\x8e.txt";
        let records = [
            Record {
                flags: 1 << 11,
                ..Record::new("日本語/ملف.txt")
            },
            Record::new("naïve.txt"),
            Record::new(&cp437[..]),
            Record::new(&cp437[..]).field(0x7075, &unicode_path(cp437, "Ünïcode.txt")),
            // The CRC is of another name, so the field does not apply.
            Record::new(&cp437[..]).field(0x7075, &unicode_path(b"other", "wrong.txt")),
            Record {
                flags: 1 << 11,
                ..Record::new(&b"bad\xff\xfe.txt"[..])
            },
        ];
        let ingest = ingest_all(&records);
        assert_eq!(
            stored_names(&ingest),
            [
                "日本語/ملف.txt",
                "naïve.txt",
                "café/Ä.txt",
                "Ünïcode.txt",
                "café/Ä.txt",
                "bad\u{fffd}\u{fffd}.txt",
            ]
        );
        let sources: Vec<_> = (0..6)
            .map(|row| value(&ingest, row, Column::NameSource))
            .collect();
        assert_eq!(
            sources,
            [
                f64::from(NameSource::Utf8Flag as u8),
                f64::from(NameSource::Utf8 as u8),
                f64::from(NameSource::Cp437 as u8),
                f64::from(NameSource::UnicodePath as u8),
                f64::from(NameSource::Cp437 as u8),
                f64::from(NameSource::Lossy as u8),
            ]
        );
        // Only the lossy name keeps its raw bytes. All records have local
        // header offset 0, so they also have the overlap mark.
        for row in 0..5 {
            assert_eq!(ingest.store().raw_name(row), None);
            assert_eq!(ingest.store().marks(row) & marks::RAW_NAME_KEPT, 0);
        }
        assert_eq!(ingest.store().raw_name(5), Some(&b"bad\xff\xfe.txt"[..]));
        assert_eq!(
            ingest.store().marks(5) & marks::RAW_NAME_KEPT,
            marks::RAW_NAME_KEPT
        );
    }

    #[test]
    fn decodes_comments() {
        let raw = b"r\x82sum\x82";
        let mut field = vec![1];
        field.extend_from_slice(&rawzip::crc32(raw).to_le_bytes());
        field.extend_from_slice("résumé (unicode)".as_bytes());
        let records = [
            Record::new("a"),
            Record {
                comment: raw.to_vec(),
                ..Record::new("b")
            },
            Record {
                comment: raw.to_vec(),
                ..Record::new("c").field(0x6375, &field)
            },
        ];
        let ingest = ingest_all(&records);
        let store = ingest.store();
        assert_eq!(store.comment(0), b"");
        assert_eq!(store.comment(1), "résumé".as_bytes());
        assert_eq!(store.comment(2), "résumé (unicode)".as_bytes());
        assert_eq!(store.comments().chunk_count(), 1);
    }

    #[test]
    fn dos_times_have_no_time_zone() {
        let records = [
            Record::new("dos"),
            Record {
                dos_date: 0,
                dos_time: 0,
                ..Record::new("none")
            },
        ];
        let ingest = ingest_all(&records);
        // 2026-10-28 09:13:06, as if UTC.
        assert_eq!(value(&ingest, 0, Column::Modified), 1_793_178_786_000.0);
        assert_eq!(
            value(&ingest, 0, Column::TimeKind),
            f64::from(TimeKind::Dos as u8)
        );
        assert!(value(&ingest, 1, Column::Modified).is_nan());
        assert_eq!(
            value(&ingest, 1, Column::TimeKind),
            f64::from(TimeKind::None as u8)
        );
    }

    #[test]
    fn extended_timestamps_win_over_dos() {
        let mut ut = vec![1];
        ut.extend_from_slice(&1_700_000_000u32.to_le_bytes());
        let mut ntfs = vec![0, 0, 0, 0, 1, 0, 24, 0];
        let ticks: u64 = (11_644_473_600 + 1_600_000_000) * 10_000_000 + 5_000_000;
        ntfs.extend_from_slice(&ticks.to_le_bytes());
        ntfs.extend_from_slice(&[0; 16]);
        let records = [
            Record::new("ut").field(0x5455, &ut),
            Record::new("ntfs").field(0x000a, &ntfs),
        ];
        let data = archive(&records);
        let ingest = ingest_all(&records);
        assert_eq!(value(&ingest, 0, Column::Modified), 1_700_000_000_000.0);
        assert_eq!(
            value(&ingest, 0, Column::TimeKind),
            f64::from(TimeKind::Extended as u8)
        );
        assert_eq!(value(&ingest, 1, Column::Modified), 1_600_000_000_500.0);
        assert_eq!(
            value(&ingest, 1, Column::TimeKind),
            f64::from(TimeKind::Ntfs as u8)
        );

        // The same seconds as rawzip's best timestamp.
        let zip = rawzip::ZipArchive::from_slice(&data).unwrap();
        let mut entries = zip.entries();
        let mut row = 0;
        while let Some(entry) = entries.next_entry().unwrap() {
            let rawzip::time::ZipDateTimeKind::Utc(time) = entry.last_modified() else {
                panic!("not UTC");
            };
            let ms = value(&ingest, row, Column::Modified);
            assert_eq!(
                f64::from(i32::try_from(time.to_unix()).unwrap()),
                (ms / 1000.0).floor()
            );
            row += 1;
        }
    }

    #[test]
    fn reads_the_timestamp_from_the_rawzip_writer() {
        let time = rawzip::time::UtcDateTime::from_components(2024, 2, 29, 23, 59, 58, 0).unwrap();
        let mut output = Vec::new();
        let mut zip = ZipArchiveWriter::new(&mut output);
        let (mut entry, config) = zip
            .new_file("leap.txt")
            .last_modified(time)
            .start()
            .unwrap();
        let writer = config.wrap(&mut entry);
        let (_, descriptor) = writer.finish().unwrap();
        entry.finish(descriptor).unwrap();
        zip.finish().unwrap();
        let mut ingest = open(output);
        ingest.parse(10);
        assert_eq!(
            value(&ingest, 0, Column::Modified),
            f64::from(i32::try_from(time.to_unix()).unwrap()) * 1000.0
        );
        assert_eq!(
            value(&ingest, 0, Column::TimeKind),
            f64::from(TimeKind::Extended as u8)
        );
    }

    #[test]
    fn decodes_encryption() {
        let records = [
            Record::new("plain"),
            Record {
                flags: 1,
                ..Record::new("zipcrypto")
            },
            Record {
                flags: 1,
                method: 99,
                ..Record::new("ae2-256").field(0x9901, &[2, 0, b'A', b'E', 3, 8, 0])
            },
            Record {
                flags: 1,
                method: 99,
                ..Record::new("ae1-192").field(0x9901, &[1, 0, b'A', b'E', 2, 0, 0])
            },
            Record {
                flags: 1,
                method: 99,
                ..Record::new("ae2-128").field(0x9901, &[2, 0, b'A', b'E', 1, 12, 0])
            },
            Record {
                flags: 1,
                method: 99,
                ..Record::new("no field")
            },
            Record {
                flags: 0x41,
                ..Record::new("strong")
            },
        ];
        let ingest = ingest_all(&records);
        let column = |column| -> Vec<f64> {
            (0..records.len())
                .map(|row| value(&ingest, row, column))
                .collect()
        };
        let ae2 = u16::from(encryption::AE2);
        assert_eq!(
            column(Column::Encryption),
            [
                f64::from(encryption::NONE),
                f64::from(encryption::ZIP_CRYPTO),
                f64::from(u16::from(encryption::AES_256) | ae2),
                f64::from(encryption::AES_192),
                f64::from(u16::from(encryption::AES_128) | ae2),
                f64::from(encryption::AES_UNKNOWN),
                f64::from(encryption::OTHER),
            ]
        );
        assert_eq!(
            column(Column::AesMethod),
            [0.0, 0.0, 8.0, 0.0, 12.0, 0.0, 0.0]
        );
        assert_eq!(
            column(Column::Method),
            [8.0, 8.0, 99.0, 99.0, 99.0, 99.0, 8.0]
        );
    }

    #[test]
    fn keeps_the_header_columns() {
        let mut zip64 = Vec::new();
        zip64.extend_from_slice(&(1u64 << 40).to_le_bytes());
        zip64.extend_from_slice(&(3u64 << 32).to_le_bytes());
        zip64.extend_from_slice(&(5u64 << 33).to_le_bytes());
        let records = [
            Record {
                version_made_by: 0x0317,
                flags: 1 << 3,
                method: 0,
                crc32: 0xdead_beef,
                compressed_size: 100,
                uncompressed_size: 250,
                external_attributes: 0o100_644 << 16,
                local_header_offset: 1234,
                ..Record::new("small")
            },
            Record {
                compressed_size: u32::MAX,
                uncompressed_size: u32::MAX,
                local_header_offset: u32::MAX,
                ..Record::new("zip64").field(0x0001, &zip64)
            },
        ];
        let ingest = ingest_all(&records);
        let row = |row: usize| -> Vec<f64> {
            Column::ALL
                .iter()
                .filter(|column| !matches!(column, Column::Modified))
                .map(|&column| value(&ingest, row, column))
                .collect()
        };
        assert_eq!(
            row(0),
            [
                250.0,
                100.0,
                1234.0,
                0.0,
                5.0,
                0.0,
                0.0,
                f64::from(0xdead_beef_u32),
                f64::from(0o100_644u32 << 16),
                0.0,
                8.0,
                f64::from(0x0317u16),
                0.0,
                f64::from(NameSource::Utf8 as u8),
                f64::from(TimeKind::Dos as u8),
                0.0,
                0.0,
            ]
        );
        assert_eq!(value(&ingest, 1, Column::UncompressedSize), 2f64.powi(40));
        assert_eq!(
            value(&ingest, 1, Column::CompressedSize),
            3.0 * 2f64.powi(32)
        );
        assert_eq!(
            value(&ingest, 1, Column::LocalHeaderOffset),
            5.0 * 2f64.powi(33)
        );
    }

    #[test]
    fn the_eocd_count_is_only_a_hint() {
        let mut data = archive(&[Record::new("only")]);
        // Make the end record claim 65,535 entries.
        let eocd = data.len() - 22;
        data[eocd + 8..eocd + 12].copy_from_slice(&[0xff; 4]);
        let mut ingest = open(data);
        assert_eq!(ingest.entries_hint(), 65_535);
        assert_eq!(ingest.store().page_count(), 0);
        assert_eq!(ingest.parse(u32::MAX), 1);
        assert_eq!(*ingest.status(), Status::Complete);
        assert_eq!(ingest.store().page_count(), 1);
    }
}
