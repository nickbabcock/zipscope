//! The wasm exports of the core. `web/src/contracts.ts` has their protocols.

use rawzip::ReaderAt;
use wasm_bindgen::prelude::*;

use crate::contract::{
    Column, LAYOUT_VERSION, SORT_DESCENDING, State, TREE_ORDER_ARCHIVE, TREE_ORDER_NAME,
};
use crate::ingest::{Ingest, Status};
use crate::query::{DEFAULT_SORT, SortColumn};

/// Returns the version of this crate.
#[wasm_bindgen]
#[must_use]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Returns the values that `web/src/contracts.ts` must repeat, one
/// `NAME=VALUE` line each. Only `contracts.test.ts` calls it.
#[wasm_bindgen(js_name = contractValues)]
#[must_use]
pub fn contract_values() -> String {
    crate::contract::values()
}

/// Returns the shared-memory layout version that this build writes.
#[wasm_bindgen(js_name = layoutVersion)]
#[must_use]
pub fn layout_version() -> u32 {
    LAYOUT_VERSION
}

#[wasm_bindgen(
    inline_js = "export function reserveGrowth(bytes) { try { const budget = globalThis.__zipscopeStoreMemory; return budget === undefined || budget.reserve(bytes) === true; } catch { return false; } }
export function releaseGrowth(bytes) { try { globalThis.__zipscopeStoreMemory?.release(bytes); } catch {} }"
)]
extern "C" {
    /// Reserves a growth of the wasm memory on the shared memory budget
    /// (`globalThis.__zipscopeStoreMemory`, which the parse worker sets).
    /// Before the worker sets it, all growth is permitted: the worker
    /// reserves the memory size when it makes the header.
    #[wasm_bindgen(js_name = reserveGrowth)]
    fn reserve_growth(bytes: f64) -> bool;
    /// Gives back a reservation when the memory did not grow.
    #[wasm_bindgen(js_name = releaseGrowth)]
    fn release_growth(bytes: f64);
}

/// The shared memory budget of the parse worker. The allocator calls it
/// before it grows the wasm memory.
#[derive(Debug)]
pub struct StoreBudget;

#[expect(
    clippy::cast_precision_loss,
    reason = "Growth is whole wasm pages, far below 2^53 bytes."
)]
impl zipscope_heap::Budget for StoreBudget {
    /// The core does not read the live bytes. Without the count, a parse
    /// of 1,000,000 rows is about 3% faster.
    const LIVE_COUNT: bool = false;

    fn reserve(bytes: usize) -> bool {
        reserve_growth(bytes as f64)
    }

    fn release(bytes: usize) {
        release_growth(bytes as f64);
    }
}

/// Sets the slack: bytes that the worker reserved on the budget for the
/// small allocations that cannot fail (see `zipscope_heap::set_slack`).
#[wasm_bindgen(js_name = setMemorySlack)]
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "Keep the JS conversion: saturate the slack and discard its fraction."
)]
pub fn set_memory_slack(bytes: f64) {
    zipscope_heap::set_slack(bytes.max(0.0) as usize);
}

/// The slack that is not used.
#[wasm_bindgen(js_name = memorySlack)]
#[must_use]
#[expect(
    clippy::cast_precision_loss,
    reason = "Byte counts are exact f64 integers below 2^53."
)]
pub fn memory_slack() -> f64 {
    zipscope_heap::slack() as f64
}

/// Returns true after the budget refused a growth.
///
/// Then the work that grows stops: each call below that can allocate does
/// nothing, and the worker stops at the hard stop. The store keeps whole
/// rows, so the worker can read them.
#[wasm_bindgen(js_name = memoryFull)]
#[must_use]
pub fn memory_full() -> bool {
    zipscope_heap::refused()
}

#[wasm_bindgen]
extern "C" {
    /// A JS object with `readAt(offset, buffer)`. It fills `buffer` with the
    /// file bytes at `offset` and returns the number of bytes it read.
    #[derive(Debug)]
    pub type JsReader;

    #[wasm_bindgen(method, catch, js_name = readAt)]
    fn read_into(this: &JsReader, offset: f64, buffer: &mut [u8]) -> Result<u32, JsValue>;
}

impl ReaderAt for JsReader {
    #[expect(
        clippy::cast_precision_loss,
        reason = "The JS reader takes an f64 offset, as the file API requires."
    )]
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        match self.read_into(offset as f64, buf) {
            Ok(read) => Ok(read as usize),
            Err(err) => Err(std::io::Error::other(
                err.as_string()
                    .unwrap_or_else(|| "The file could not be read".to_string()),
            )),
        }
    }
}

/// Parses the central directory of one archive into the store.
#[wasm_bindgen]
#[derive(Debug)]
pub struct Parser {
    ingest: Ingest<JsReader>,
}

#[wasm_bindgen]
impl Parser {
    /// Finds the end of the central directory. Throws when the file is not a
    /// zip archive.
    ///
    /// # Errors
    ///
    /// Returns an error if the reader fails or the archive end cannot be found.
    /// `seed` keys the folder hash. Give a random value for each archive.
    /// `probes` reads the local headers of an archive whose offsets wrap at
    /// 4 GiB, so that the window of `reader` stays. No other archive reads
    /// them.
    pub fn open(
        reader: JsReader,
        size: f64,
        seed: u64,
        probes: Option<JsReader>,
    ) -> Result<Parser, JsError> {
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "Keep the JS conversion: saturate the size and discard its fraction."
        )]
        let size = size as u64;
        let mut ingest =
            Ingest::with_seed(reader, size, seed).map_err(|err| JsError::new(&err.to_string()))?;
        if let Some(probes) = probes {
            ingest.set_probes(probes);
        }
        Ok(Parser { ingest })
    }

    /// Returns the entry count that the archive declares. It is a hint only.
    #[wasm_bindgen(js_name = entriesHint)]
    #[must_use]
    #[expect(
        clippy::cast_precision_loss,
        reason = "The JS API returns an f64 hint; parsing does not use this count."
    )]
    pub fn entries_hint(&self) -> f64 {
        self.ingest.entries_hint() as f64
    }

    /// Parses up to `max_entries` entries and returns how many it added.
    /// With `max_bytes`, it stops after the entry whose estimated
    /// allocation makes the total of this call `max_bytes` or more, or
    /// before an entry whose page or chunk does not fit (see
    /// `Ingest::parse_within`).
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "A byte limit saturates to the usize range."
    )]
    pub fn parse(&mut self, max_entries: u32, max_bytes: Option<f64>) -> u32 {
        if memory_full() {
            return 0;
        }
        let limit = max_bytes.map_or(usize::MAX, |bytes| bytes.max(0.0) as usize);
        self.ingest.parse_within(max_entries, limit)
    }

    /// Returns the header state value: parsing, complete or failed.
    #[must_use]
    pub fn state(&self) -> u32 {
        match self.ingest.status() {
            Status::Parsing => State::Parsing as u32,
            Status::Complete => State::Complete as u32,
            Status::Failed(_) => State::Failed as u32,
        }
    }

    /// Returns the terminal error, if parsing failed.
    #[must_use]
    pub fn error(&self) -> Option<String> {
        match self.ingest.status() {
            Status::Failed(message) => Some(message.clone()),
            _ => None,
        }
    }

    /// Returns the number of rows in the store.
    #[must_use]
    pub fn rows(&self) -> u32 {
        wasm_word(self.ingest.store().rows())
    }

    /// Returns the part of the central directory that is parsed, from 0 to 1.
    #[must_use]
    pub fn progress(&self) -> f64 {
        self.ingest.progress()
    }

    /// Returns the address in wasm memory of row 0 of a column in a page, or
    /// 0 when the page or the column does not exist.
    #[wasm_bindgen(js_name = columnPtr)]
    #[must_use]
    pub fn column_ptr(&self, page: u32, column: u32) -> u32 {
        match Column::from_id(column) {
            Some(column) => {
                wasm_word(self.ingest.store().column_ptr(page as usize, column) as usize)
            }
            None => 0,
        }
    }

    /// Returns the number of name arena chunks.
    #[wasm_bindgen(js_name = nameChunkCount)]
    #[must_use]
    pub fn name_chunk_count(&self) -> u32 {
        wasm_word(self.ingest.store().names().chunk_count())
    }

    /// Returns the address in wasm memory of a name arena chunk.
    #[wasm_bindgen(js_name = nameChunkPtr)]
    #[must_use]
    pub fn name_chunk_ptr(&self, chunk: u32) -> u32 {
        wasm_word(self.ingest.store().names().chunk(chunk as usize).as_ptr() as usize)
    }

    /// Returns the filled bytes of a name arena chunk.
    #[wasm_bindgen(js_name = nameChunkLength)]
    #[must_use]
    pub fn name_chunk_length(&self, chunk: u32) -> u32 {
        wasm_word(self.ingest.store().names().chunk(chunk as usize).len())
    }

    /// Returns the number of comment arena chunks.
    #[wasm_bindgen(js_name = commentChunkCount)]
    #[must_use]
    pub fn comment_chunk_count(&self) -> u32 {
        wasm_word(self.ingest.store().comments().chunk_count())
    }

    /// Returns the address in wasm memory of a comment arena chunk.
    #[wasm_bindgen(js_name = commentChunkPtr)]
    #[must_use]
    pub fn comment_chunk_ptr(&self, chunk: u32) -> u32 {
        wasm_word(
            self.ingest
                .store()
                .comments()
                .chunk(chunk as usize)
                .as_ptr() as usize,
        )
    }

    /// Returns the filled bytes of a comment arena chunk.
    #[wasm_bindgen(js_name = commentChunkLength)]
    #[must_use]
    pub fn comment_chunk_length(&self, chunk: u32) -> u32 {
        wasm_word(self.ingest.store().comments().chunk(chunk as usize).len())
    }

    /// Returns the number of folders, including the root.
    #[wasm_bindgen(js_name = folderCount)]
    #[must_use]
    pub fn folder_count(&self) -> u32 {
        wasm_word(self.ingest.tree().folder_count())
    }

    /// Returns the address in wasm memory of folder record 0. The records
    /// of all folders follow without gaps.
    #[wasm_bindgen(js_name = folderPtr)]
    #[must_use]
    pub fn folder_ptr(&self) -> u32 {
        wasm_word(self.ingest.tree().folders().as_ptr() as usize)
    }

    /// Returns the address in wasm memory of rollup record 0, one for each
    /// folder.
    #[wasm_bindgen(js_name = rollupPtr)]
    #[must_use]
    pub fn rollup_ptr(&self) -> u32 {
        wasm_word(self.ingest.tree().rollups().as_ptr() as usize)
    }

    /// Returns the number of folders whose explicit row changed after the
    /// worker copied their record.
    #[wasm_bindgen(js_name = folderUpdateCount)]
    #[must_use]
    pub fn folder_update_count(&self) -> u32 {
        wasm_word(self.ingest.tree().updates().len())
    }

    /// Returns the address in wasm memory of the changed folder ids.
    #[wasm_bindgen(js_name = folderUpdatesPtr)]
    #[must_use]
    pub fn folder_updates_ptr(&self) -> u32 {
        wasm_word(self.ingest.tree().updates().as_ptr() as usize)
    }

    /// Clears the changed folder ids, after the worker copied them.
    #[wasm_bindgen(js_name = clearFolderUpdates)]
    pub fn clear_folder_updates(&mut self) {
        self.ingest.clear_folder_updates();
    }

    /// Makes the listing and the flattened tree again where the tree
    /// changed. Returns true when a view changed.
    #[wasm_bindgen(js_name = refreshViews)]
    pub fn refresh_views(&mut self) -> bool {
        if memory_full() {
            return false;
        }
        self.ingest.refresh_views()
    }

    /// Returns the folder that the permutation lists, or `NONE` for search
    /// results.
    #[wasm_bindgen(js_name = permutationFolder)]
    #[must_use]
    pub fn permutation_folder(&self) -> u32 {
        self.ingest.views().permutation_folder()
    }

    /// Returns the address in wasm memory of the permutation.
    #[wasm_bindgen(js_name = permutationPtr)]
    #[must_use]
    pub fn permutation_ptr(&self) -> u32 {
        wasm_word(self.ingest.views().permutation().as_ptr() as usize)
    }

    /// Returns the address in wasm memory of the information words of the
    /// permutation, one for each value.
    #[wasm_bindgen(js_name = permutationInfoPtr)]
    #[must_use]
    pub fn permutation_info_ptr(&self) -> u32 {
        wasm_word(self.ingest.views().permutation_info().as_ptr() as usize)
    }

    /// Returns the number of values in the permutation.
    #[wasm_bindgen(js_name = permutationLength)]
    #[must_use]
    pub fn permutation_length(&self) -> u32 {
        wasm_word(self.ingest.views().permutation().len())
    }

    /// Returns the address in wasm memory of the flattened tree records.
    #[wasm_bindgen(js_name = treePtr)]
    #[must_use]
    pub fn tree_ptr(&self) -> u32 {
        wasm_word(self.ingest.views().tree().as_ptr() as usize)
    }

    /// Returns the number of flattened tree rows.
    #[wasm_bindgen(js_name = treeLength)]
    #[must_use]
    pub fn tree_length(&self) -> u32 {
        wasm_word(self.ingest.views().tree_rows())
    }

    /// Returns a number that changes when the rollups change.
    #[wasm_bindgen(js_name = rollupVersion)]
    #[must_use]
    pub fn rollup_version(&self) -> u32 {
        self.ingest.tree().version()
    }

    /// Returns a number that changes when the permutation changes.
    #[wasm_bindgen(js_name = permutationVersion)]
    #[must_use]
    pub fn permutation_version(&self) -> u32 {
        self.ingest.views().listing_version()
    }

    /// Returns a number that changes when the flattened tree changes.
    #[wasm_bindgen(js_name = treeVersion)]
    #[must_use]
    pub fn tree_version(&self) -> u32 {
        self.ingest.views().tree_version()
    }

    /// Returns the largest uncompressed size of a row of the listing.
    #[wasm_bindgen(js_name = permutationLargest)]
    #[must_use]
    pub fn permutation_largest(&self) -> f64 {
        self.ingest.listing_largest()
    }

    /// Returns the address in wasm memory of the largest files below the
    /// folder of the permutation, as `u32` store rows.
    #[wasm_bindgen(js_name = largestFilesPtr)]
    #[must_use]
    pub fn largest_files_ptr(&self) -> u32 {
        wasm_word(self.ingest.views().largest_files().as_ptr() as usize)
    }

    /// Returns the number of the largest files, from 0 to 10.
    #[wasm_bindgen(js_name = largestFilesLength)]
    #[must_use]
    pub fn largest_files_length(&self) -> u32 {
        wasm_word(self.ingest.views().largest_files().len())
    }

    /// Returns a number that changes when the largest files change.
    #[wasm_bindgen(js_name = largestFilesVersion)]
    #[must_use]
    pub fn largest_files_version(&self) -> u32 {
        self.ingest.views().largest_version()
    }

    /// Runs up to `budget` units of final checks. Zero completes all work.
    /// Returns true when the checks end. Call it after parsing.
    #[wasm_bindgen(js_name = finishChecks)]
    pub fn finish_checks(&mut self, budget: u32) -> bool {
        if memory_full() {
            return true;
        }
        if budget == 0 {
            self.ingest.finish_checks();
            true
        } else {
            self.ingest.finish_checks_step(budget as usize)
        }
    }

    /// Returns the health vector. `contract::health` gives the indexes.
    #[must_use]
    pub fn health(&self) -> Vec<f64> {
        self.ingest.health_vector().to_vec()
    }

    /// Returns the number of rows from `first` on with a bit of `marks`.
    #[wasm_bindgen(js_name = markedFrom)]
    #[must_use]
    pub fn marked_from(&self, first: u32, bit: u8) -> u32 {
        wasm_word(self.ingest.marked_from(first as usize, bit))
    }

    /// Returns the number of rows from `first` on with data that runs into the
    /// central directory.
    #[wasm_bindgen(js_name = intoDirectoryFrom)]
    #[must_use]
    pub fn into_directory_from(&self, first: u32) -> u32 {
        wasm_word(self.ingest.into_directory_from(first as usize))
    }

    /// Returns the number of rows whose `marks` changed after the row was
    /// added, since `clearMarkUpdates`.
    #[wasm_bindgen(js_name = markUpdateCount)]
    #[must_use]
    pub fn mark_update_count(&self) -> u32 {
        wasm_word(self.ingest.mark_updates().len())
    }

    /// Returns the address in wasm memory of those rows, as `u32`.
    #[wasm_bindgen(js_name = markUpdatesPtr)]
    #[must_use]
    pub fn mark_updates_ptr(&self) -> u32 {
        wasm_word(self.ingest.mark_updates().as_ptr() as usize)
    }

    /// Clears the changed rows, after the worker copied their marks.
    #[wasm_bindgen(js_name = clearMarkUpdates)]
    pub fn clear_mark_updates(&mut self) {
        self.ingest.clear_mark_updates();
    }

    /// Lists a folder. Returns false for an unknown folder.
    pub fn list(&mut self, folder: u32) -> bool {
        if memory_full() {
            return true;
        }
        self.ingest.list(folder)
    }

    /// Expands or collapses the tree row that ends at a folder. Returns
    /// false for an unknown folder.
    pub fn expand(&mut self, folder: u32, open: bool) -> bool {
        if memory_full() {
            return true;
        }
        self.ingest.expand(folder, open)
    }

    /// Returns the folder that lists a row: for an entry, its folder; for
    /// the explicit row of a folder, that folder with `FOLDER_TAG`.
    /// Returns `NONE` for an unknown row.
    #[wasm_bindgen(js_name = entryFolder)]
    #[must_use]
    pub fn entry_folder(&self, row: u32) -> u32 {
        self.ingest.entry_folder(row)
    }

    /// Opens or closes the table row that ends at a folder in place. With
    /// `deep`, all folders below it change too. Returns false for an
    /// unknown folder.
    #[wasm_bindgen(js_name = expandInline)]
    pub fn expand_inline(&mut self, folder: u32, open: bool, deep: bool) -> bool {
        if memory_full() {
            return true;
        }
        self.ingest.expand_inline(folder, open, deep)
    }

    /// Sets the sort order that the user chose. Returns false for an unknown
    /// column code.
    pub fn sort(&mut self, column: u32, descending: bool) -> bool {
        if memory_full() {
            return true;
        }
        let Some(column) = SortColumn::from_code(column) else {
            return false;
        };
        self.ingest.sort(column, descending);
        true
    }

    /// Sets the default sort, which is not a choice of the user. Returns its
    /// value for `LISTING_SORT_n`, or 0 when the budget refuses more work.
    #[wasm_bindgen(js_name = defaultSort)]
    pub fn default_sort(&mut self) -> u32 {
        if memory_full() {
            return 0;
        }
        self.ingest.default_sort();
        let direction = if DEFAULT_SORT.descending {
            SORT_DESCENDING
        } else {
            0
        };
        DEFAULT_SORT.column as u32 | direction
    }

    /// Returns true when the listing as it is now is in the best-match order.
    #[wasm_bindgen(js_name = listingBestMatch)]
    #[must_use]
    pub fn listing_best_match(&self) -> bool {
        self.ingest.views().listing_best_match()
    }

    /// Sets the search. An empty query lists the selected folder again.
    pub fn search(&mut self, query: &str) {
        if memory_full() {
            return;
        }
        self.ingest.search(query);
    }

    /// Merges rows that wait into the listing in the sort order, or makes
    /// one step of a build (see `viewsBuilding`), for about `budget` units
    /// of work. One unit is about one comparison of two short names. The listing
    /// changes only when the merge or the build ends: then it returns true.
    /// A budget of 0 ends the merge or the build in one call.
    #[wasm_bindgen(js_name = mergeViews)]
    pub fn merge_views(&mut self, budget: u32) -> bool {
        if memory_full() {
            return false;
        }
        let budget = if budget == 0 {
            usize::MAX
        } else {
            budget as usize
        };
        self.ingest.merge_views(budget)
    }

    /// Starts the job that puts the tree in name order. Call it only when no
    /// more rows come: after it, `parse` adds no rows. A job with little work
    /// ends in this call. It does nothing when the budget refused a growth.
    #[wasm_bindgen(js_name = startTreeOrder)]
    pub fn start_tree_order(&mut self) {
        if memory_full() {
            return;
        }
        self.ingest.start_tree_order();
    }

    /// Runs the job of the tree order for about `budget` units of work. Returns
    /// true when the job ended: the tree changed, so publish it.
    #[wasm_bindgen(js_name = treeOrderStep)]
    pub fn tree_order_step(&mut self, budget: u32) -> bool {
        if memory_full() {
            return false;
        }
        self.ingest.tree_order_step(budget as usize)
    }

    /// Returns true while the job of the tree order has work.
    #[wasm_bindgen(js_name = treeOrderPending)]
    #[must_use]
    pub fn tree_order_pending(&self) -> bool {
        self.ingest.views().tree_order_pending()
    }

    /// Returns the order of the flattened tree, as `TREE_ORDER_n` holds it.
    #[wasm_bindgen(js_name = treeOrder)]
    #[must_use]
    pub fn tree_order(&self) -> u32 {
        if self.ingest.views().tree_in_name_order() {
            TREE_ORDER_NAME
        } else {
            TREE_ORDER_ARCHIVE
        }
    }

    /// Returns true while a new sort, search or folder listing is made in
    /// steps by `mergeViews`. The old listing shows until it ends.
    #[wasm_bindgen(js_name = viewsBuilding)]
    #[must_use]
    pub fn views_building(&self) -> bool {
        self.ingest.views_building()
    }

    /// Returns a number that changes each time a new listing starts, also
    /// one that replaces a listing that `mergeViews` builds. A request that
    /// changes it waits until that listing is published.
    #[wasm_bindgen(js_name = viewsBuildEpoch)]
    #[must_use]
    pub fn views_build_epoch(&self) -> u32 {
        self.ingest.views_build_epoch()
    }

    /// Returns true when parsed rows are not in the listing yet.
    #[wasm_bindgen(js_name = rowsWaiting)]
    #[must_use]
    pub fn rows_waiting(&self) -> bool {
        self.ingest.views().rows_waiting()
    }

    /// Returns true when the listing waits for `mergeViews`.
    #[wasm_bindgen(js_name = mergePending)]
    #[must_use]
    pub fn merge_pending(&self) -> bool {
        self.ingest.merge_pending()
    }
}

#[expect(
    clippy::cast_possible_truncation,
    reason = "The JS API uses wasm32 addresses and lengths."
)]
fn wasm_word(value: usize) -> u32 {
    value as u32
}
