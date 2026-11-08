//! The wasm exports of the read module.

use rawzip::ReaderAt;
use wasm_bindgen::prelude::*;

use std::collections::TryReserveError;

use zipscope_layout::{Builder, EntrySpan, Facts, Group, Layout, Totals, Zip64};

use crate::directory::{Directory, Scan};
use crate::local::{self, Record};
use crate::sanitize::{Added, Planner};
use crate::stream::{Status, Stream};
use crate::zipout::{Data, Step, ZipOut};

#[wasm_bindgen(inline_js = "export function nfd(text) { return text.normalize(\"NFD\"); }")]
extern "C" {
    /// `String.prototype.normalize("NFD")` of JavaScript, for the collision
    /// keys of the extraction planner. The read wasm then needs no
    /// normalization tables (they cost about 63 KB gzip).
    #[wasm_bindgen(js_name = nfd)]
    fn nfd_js(text: &str) -> String;
}

fn js_nfd(text: &str) -> String {
    nfd_js(text)
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

/// The free heap that `start` makes sure of before it reads the headers
/// and makes a decoder (see `heap::probe`).
const START_PROBE_BYTES: usize = 768 * 1024;
/// The free heap that `read` and `skip` make sure of before a step.
const STEP_PROBE_BYTES: usize = 256 * 1024;

#[wasm_bindgen(
    inline_js = "export function reserveGrowth(bytes) { try { const budget = globalThis.__zipscopeReadMemory; return budget === undefined || budget.reserve(bytes) === true; } catch { return false; } }
export function releaseGrowth(bytes) { try { globalThis.__zipscopeReadMemory?.release(bytes); } catch {} }"
)]
extern "C" {
    /// Reserves a growth of the wasm memory on the shared memory budget
    /// (`globalThis.__zipscopeReadMemory`, which the read worker sets).
    /// Before the worker sets it, all growth is permitted: the worker
    /// reserves the memory size when it gets the header.
    #[wasm_bindgen(js_name = reserveGrowth)]
    fn reserve_growth(bytes: f64) -> bool;
    /// Gives back a reservation when the memory did not grow.
    #[wasm_bindgen(js_name = releaseGrowth)]
    fn release_growth(bytes: f64);
}

/// The shared memory budget of the read worker. The allocator calls it
/// before it grows the wasm memory.
#[derive(Debug)]
pub struct ReadBudget;

#[expect(
    clippy::cast_precision_loss,
    reason = "Growth is whole wasm pages, far below 2^53 bytes."
)]
impl crate::heap::Budget for ReadBudget {
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
    crate::heap::set_slack(bytes.max(0.0) as usize);
}

/// The slack that is not used.
#[wasm_bindgen(js_name = memorySlack)]
#[must_use]
#[expect(
    clippy::cast_precision_loss,
    reason = "Byte counts are exact f64 integers below 2^53."
)]
pub fn memory_slack() -> f64 {
    crate::heap::slack() as f64
}

/// Sets the most wasm memory in bytes. The allocator does not grow the
/// memory past it (see `heap`). The read worker sets it before each call
/// that can allocate: the hard stop less the store memory.
#[wasm_bindgen(js_name = setMemoryCap)]
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "Keep the JS conversion: saturate the cap and discard its fraction."
)]
pub fn set_memory_cap(bytes: f64) {
    crate::heap::set_cap(bytes.max(0.0) as usize);
}

/// The live heap bytes of the read wasm. The memory size is the high mark;
/// the heap below it can be free.
#[wasm_bindgen(js_name = heapBytes)]
#[must_use]
#[expect(
    clippy::cast_precision_loss,
    reason = "Byte counts are exact f64 integers below 2^53."
)]
pub fn heap_bytes() -> f64 {
    crate::heap::live_bytes() as f64
}

/// What `ReadArchive.start` found for a row.
#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct EntryStart {
    /// `mismatch` bits of the local header check.
    pub mismatches: u32,
    /// The raw name in the local header, when the check could read it.
    #[wasm_bindgen(getter_with_clone, js_name = localName)]
    pub local_name: Vec<u8>,
    /// Method and flags from the central-directory record.
    pub method: u16,
    pub flags: u16,
    pub crc32: u32,
    #[wasm_bindgen(js_name = uncompressedSize)]
    pub uncompressed_size: f64,
    #[wasm_bindgen(js_name = compressedSize)]
    pub compressed_size: f64,
    /// Why the data cannot be decoded, or undefined.
    #[wasm_bindgen(getter_with_clone)]
    pub error: Option<String>,
}

/// Values in the facts vector (`ReadArchive.facts`). `facts_vector` gives
/// the indexes, in order, and `web/src/read/layout.ts` reads them.
pub const FACTS_FIELDS: usize = 30;
/// Counts at the start of the layout vector (`ReadArchive.layoutFinish`).
pub const LAYOUT_COUNTS: usize = 10;
/// Values of one region in the layout vector, after the counts.
pub const REGION_FIELDS: usize = 6;

#[expect(
    clippy::cast_precision_loss,
    reason = "The JS API uses f64 values. Offsets in a file are exact; a larger hostile value is for display only."
)]
fn number(value: u64) -> f64 {
    value as f64
}

/// Returns the facts vector. A field that the archive does not have is -1.
fn facts_vector(facts: &Facts) -> Result<Vec<f64>, TryReserveError> {
    let end = &facts.end_record;
    let tail = facts.tail();
    let mut fields = Vec::new();
    fields.try_reserve_exact(FACTS_FIELDS)?;
    fields.resize(FACTS_FIELDS, -1.0);
    let values: [(usize, f64); 15] = [
        (0, number(facts.size)),
        (1, number(facts.end_record_offset)),
        (2, number(facts.end_offset)),
        (3, number(facts.directory_offset)),
        (4, number(facts.declared_entries)),
        (5, f64::from(facts.zip64 as u8)),
        (6, f64::from(end.disk)),
        (7, f64::from(end.directory_disk)),
        (8, f64::from(end.disk_entries)),
        (9, f64::from(end.total_entries)),
        (10, f64::from(end.directory_size)),
        (11, f64::from(end.directory_offset)),
        (12, f64::from(end.comment_length)),
        (27, f64::from(u8::from(facts.spans_disks()))),
        (28, number(facts.declared_directory_size())),
    ];
    for (index, value) in values {
        fields[index] = value;
    }
    fields[29] = number(tail[1]);
    if let Some(locator) = facts.locator {
        fields[13] = number(locator.offset);
        fields[14] = f64::from(locator.disk);
        fields[15] = number(locator.record_offset);
        fields[16] = f64::from(locator.total_disks);
    }
    if let Some(record) = facts.record {
        let values = [
            number(record.offset),
            number(record.size),
            f64::from(record.version_made_by),
            f64::from(record.version_needed),
            f64::from(record.disk),
            f64::from(record.directory_disk),
            number(record.disk_entries),
            number(record.total_entries),
            number(record.directory_size),
            number(record.directory_offset),
        ];
        fields[17..27].copy_from_slice(&values);
    }
    debug_assert!(facts.zip64 != Zip64::Used || facts.record.is_some());
    Ok(fields)
}

/// Returns the layout vector: the counts, then the regions.
fn layout_vector(layout: &Layout) -> Result<Vec<f64>, TryReserveError> {
    let counts = &layout.counts;
    let mut out = Vec::new();
    out.try_reserve_exact(LAYOUT_COUNTS + REGION_FIELDS * layout.regions.len())?;
    out.extend(
        [
            counts.rows,
            counts.bad_headers,
            counts.past_directory,
            counts.into_directory,
            counts.overlapping,
            counts.missing_descriptors,
            counts.gaps,
            counts.gap_bytes,
            counts.other_disk_rows,
            counts.zip64_rows,
        ]
        .map(number),
    );
    for region in &layout.regions {
        out.extend([
            f64::from(region.kind as u8),
            number(region.start),
            number(region.end),
            f64::from(region.label as u8),
            number(region.folded_gaps),
            number(region.folded_bytes),
        ]);
    }
    Ok(out)
}

/// The error of an allocation that the memory limit refused.
fn no_room(err: &TryReserveError) -> JsError {
    JsError::new(&format!("{}: {err}", crate::heap::limit_error()))
}

/// A `TryReserveError` for a probe that failed. The standard library makes
/// one only from a refused reservation.
fn probe_error(_err: &std::io::Error) -> TryReserveError {
    Vec::<u8>::new()
        .try_reserve(usize::MAX)
        .expect_err("a reservation of usize::MAX bytes fails")
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "Mirror values are exact to 2^53. A larger value saturates, which keeps it past the end of the file."
)]
fn whole(value: f64) -> u64 {
    value.max(0.0) as u64
}

/// Returns the totals vector: the entries, compressed and uncompressed
/// bytes of all rows, then the same four values (code, entries, compressed,
/// uncompressed) for each group, with a group count before each breakdown
/// (method, encryption, creating system).
fn totals_vector(totals: &Totals) -> Result<Vec<f64>, TryReserveError> {
    let group = |group: Group| [group.entries, group.compressed, group.uncompressed].map(number);
    let counts = [
        totals.methods().count(),
        totals.encryption().count(),
        totals.systems().count(),
    ];
    // One allocation of the exact size: the groups are counted first, so
    // no temporary list is made.
    let mut out = Vec::new();
    out.try_reserve_exact(3 + counts.len() + 4 * counts.iter().sum::<usize>())?;
    out.extend(group(totals.all));
    let mut breakdown = |count: usize, groups: &mut dyn Iterator<Item = (u16, Group)>| {
        out.push(number(count as u64));
        for (key, values) in groups {
            out.push(f64::from(key));
            out.extend(group(values));
        }
    };
    breakdown(counts[0], &mut totals.methods());
    breakdown(counts[1], &mut totals.encryption());
    breakdown(counts[2], &mut totals.systems());
    Ok(out)
}

/// The byte map and the totals while the read worker gives them the rows.
#[derive(Debug)]
struct Mapping {
    /// `None` when the rows of the map did not fit. The totals still count.
    builder: Option<Builder>,
    totals: Totals,
    /// Readers with a small window: one reads the local headers, one the
    /// central-directory records.
    locals: JsReader,
    records: JsReader,
}

/// The archive of the read worker: its wayfinder table, the stream of the
/// entry that the user previews, and the byte map of the Archive panel.
#[wasm_bindgen]
#[derive(Debug)]
pub struct ReadArchive {
    directory: Directory<JsReader>,
    /// The reader of the central-directory records of a row that starts. It
    /// goes to the file each time.
    records: JsReader,
    /// The reader of the records of a job (a folder or a zip), while the job
    /// runs. A preview during the job keeps `records`.
    job_records: Option<JsReader>,
    stream: Option<Stream>,
    facts: Option<Facts>,
    mapping: Option<Mapping>,
    /// The totals vector of the last map, or why it could not be made.
    totals: Option<Result<Vec<f64>, TryReserveError>>,
    /// The zip of an extraction to one zip.
    zip: Option<ZipOut>,
}

#[wasm_bindgen]
impl ReadArchive {
    /// Finds the end of the central directory. `records` reads the record of
    /// each row that starts, so that the window of `reader` stays.
    ///
    /// # Errors
    ///
    /// Returns an error if the reader fails or the archive end cannot be found.
    pub fn open(reader: JsReader, records: JsReader, size: f64) -> Result<ReadArchive, JsError> {
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "Keep the JS conversion: saturate the size and discard its fraction."
        )]
        let size = size as u64;
        let directory =
            Directory::open(reader, size).map_err(|err| JsError::new(&err.to_string()))?;
        Ok(ReadArchive {
            directory,
            records,
            job_records: None,
            stream: None,
            facts: None,
            mapping: None,
            totals: None,
            zip: None,
        })
    }

    fn load_facts(&mut self) -> Result<&Facts, JsError> {
        if self.facts.is_none() {
            let facts = Facts::read(self.directory.archive(), self.directory.size())
                .map_err(|err| JsError::new(&format!("{}: {err}", crate::heap::limit_error())))?;
            self.facts = Some(facts);
        }
        Ok(self.facts.as_ref().expect("the facts are read"))
    }

    /// Reads the records at the end of the archive and returns the facts
    /// vector.
    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit leaves no room for the
    /// comment.
    pub fn facts(&mut self) -> Result<Vec<f64>, JsError> {
        facts_vector(self.load_facts()?).map_err(|err| no_room(&err))
    }

    /// The raw bytes of the archive comment. Call `facts` first.
    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit leaves no room for the copy.
    pub fn comment(&self) -> Result<Vec<u8>, JsError> {
        let Some(facts) = &self.facts else {
            return Ok(Vec::new());
        };
        let mut copy = Vec::new();
        copy.try_reserve_exact(facts.comment.len())
            .map_err(|err| no_room(&err))?;
        copy.extend_from_slice(&facts.comment);
        Ok(copy)
    }

    /// Starts the byte map and the totals for `rows` rows. `locals` reads
    /// the local headers and `records` the central-directory records.
    /// With `map` false, only the totals count. Returns false when there is
    /// no map: `map` is false, or the memory limit leaves no room for its
    /// rows (16 bytes each). The totals then still count.
    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit leaves no room for the facts
    /// or the totals tables.
    #[wasm_bindgen(js_name = layoutStart)]
    pub fn layout_start(
        &mut self,
        locals: JsReader,
        records: JsReader,
        rows: u32,
        map: bool,
    ) -> Result<bool, JsError> {
        self.mapping = None;
        self.totals = None;
        let mut builder = Builder::new(self.load_facts()?);
        let fits = map && builder.reserve(rows as usize).is_ok();
        let totals = Totals::new()
            .map_err(|err| JsError::new(&format!("{}: {err}", crate::heap::limit_error())))?;
        self.mapping = Some(Mapping {
            builder: fits.then_some(builder),
            totals,
            locals,
            records,
        });
        Ok(fits)
    }

    /// Adds one row to the byte map and the totals, with its values from
    /// the mirrors. Returns false when the map is not started or has no
    /// room for its rows.
    #[wasm_bindgen(js_name = layoutAdd)]
    #[expect(
        clippy::too_many_arguments,
        reason = "One call for each row, with the columns that the map and the totals use."
    )]
    pub fn layout_add(
        &mut self,
        offset: f64,
        compressed: f64,
        uncompressed: f64,
        crc32: u32,
        flags: u16,
        method: u16,
        encryption: u8,
        version_made_by: u16,
    ) -> bool {
        let Some(mapping) = &mut self.mapping else {
            return false;
        };
        let span = EntrySpan {
            local_header_offset: whole(offset),
            compressed_size: whole(compressed),
            uncompressed_size: whole(uncompressed),
            crc32,
            flags,
        };
        mapping.totals.add(
            span.compressed_size,
            span.uncompressed_size,
            method,
            encryption,
            version_made_by,
        );
        if let Some(builder) = &mut mapping.builder
            && builder
                .add(&mapping.locals, &mapping.records, span)
                .is_err()
        {
            mapping.builder = None;
        }
        mapping.builder.is_some()
    }

    /// Ends the byte map and returns the layout vector, or undefined when
    /// the map is not started or the memory limit leaves no room. Then it
    /// frees the rows of the map and the totals tables. `layoutTotals`
    /// gives the totals after it.
    ///
    /// All allocations of this call are fallible, and it first makes sure
    /// of room for the small allocations that cannot fail cleanly, so a
    /// full memory gives an error, not a trap.
    #[wasm_bindgen(js_name = layoutFinish)]
    pub fn layout_finish(&mut self) -> Option<Vec<f64>> {
        let mapping = self.mapping.take()?;
        if let Err(err) = crate::heap::probe(STEP_PROBE_BYTES) {
            drop(mapping);
            self.totals = Some(Err(probe_error(&err)));
            return None;
        }
        let Mapping {
            builder,
            totals,
            locals,
            ..
        } = mapping;
        // The map first: `finish` frees its rows, which makes room for the
        // totals vector.
        let map = builder.and_then(|builder| {
            let facts = self.facts.as_ref()?;
            let layout = builder.finish(&locals, facts).ok()?;
            layout_vector(&layout).ok()
        });
        self.totals = Some(totals_vector(&totals));
        map
    }

    /// The totals vector of the last `layoutFinish`, or undefined.
    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit left no room for the totals.
    #[wasm_bindgen(js_name = layoutTotals)]
    pub fn layout_totals(&mut self) -> Result<Option<Vec<f64>>, JsError> {
        match self.totals.take() {
            None => Ok(None),
            Some(Ok(vector)) => Ok(Some(vector)),
            Some(Err(err)) => Err(no_room(&err)),
        }
    }

    /// Reads up to `max_records` more records into the wayfinder table.
    /// Returns how many it added.
    pub fn scan(&mut self, max_records: u32) -> u32 {
        self.directory.scan(max_records)
    }

    /// The rows in the wayfinder table.
    #[must_use]
    pub fn rows(&self) -> u32 {
        u32::try_from(self.directory.rows()).unwrap_or(u32::MAX)
    }

    /// 0 while the pass reads records, 1 at the end of the central
    /// directory, 2 after an error.
    #[wasm_bindgen(js_name = scanState)]
    #[must_use]
    pub fn scan_state(&self) -> u32 {
        match self.directory.status() {
            Scan::Scanning => 0,
            Scan::Complete => 1,
            Scan::Failed(_) => 2,
        }
    }

    /// The rows that the allocated chunks of the wayfinder table hold. A
    /// scan step past them allocates one chunk (`CHUNK_BYTES`).
    #[must_use]
    pub fn capacity(&self) -> u32 {
        u32::try_from(self.directory.capacity()).unwrap_or(u32::MAX)
    }

    /// The most bytes that the next `scan(maxRecords)` allocates: 0 when
    /// the table has room, else at most one chunk and the index.
    #[must_use]
    pub fn growth(&self, max_records: u32) -> u32 {
        u32::try_from(self.directory.growth(max_records as usize)).unwrap_or(u32::MAX)
    }

    /// The bytes that the wayfinder table holds.
    #[wasm_bindgen(js_name = tableBytes)]
    #[must_use]
    pub fn table_bytes(&self) -> u32 {
        u32::try_from(self.directory.table_bytes()).unwrap_or(u32::MAX)
    }

    /// Checks the local header of a row and starts to decode it. A later
    /// `read` continues this row. A Zstandard frame that needs a window of
    /// more than `window` bytes fails. The result tells why the row cannot
    /// be decoded, if it cannot.
    ///
    /// # Errors
    ///
    /// Returns an error when the central directory has no such row.
    pub fn start(&mut self, row: u32, window: f64) -> Result<EntryStart, JsError> {
        self.stream = None;
        let (start, stream) = open_row(&mut self.directory, &self.records, row, window)?;
        self.stream = stream;
        Ok(start)
    }

    /// Sets the reader of the records of a job, or removes it. While it is
    /// set, `openEntry` and `zipFile` use it, and `start` does not.
    #[wasm_bindgen(js_name = setJobRecords)]
    pub fn set_job_records(&mut self, records: Option<JsReader>) {
        self.job_records = records;
    }

    /// As `start`, but for an extraction: the stream is a new
    /// `EntryReader`, so that a preview does not stop it.
    ///
    /// # Errors
    ///
    /// Returns an error when the central directory has no such row.
    #[wasm_bindgen(js_name = openEntry)]
    pub fn open_entry(&mut self, row: u32, window: f64) -> Result<EntryReader, JsError> {
        let records = self.job_records.as_ref().unwrap_or(&self.records);
        let (start, stream) = open_row(&mut self.directory, records, row, window)?;
        Ok(EntryReader { start, stream })
    }

    /// Decodes up to `max_bytes` more bytes of the started row. A Zstandard
    /// frame that starts in this read and needs a window of more than
    /// `window` bytes fails.
    pub fn read(&mut self, max_bytes: u32, window: f64) -> Vec<u8> {
        read_stream(self.stream.as_mut(), max_bytes, window)
    }

    /// Decodes and drops up to `count` bytes of the started row, with the
    /// Zstandard window limit of `read`. Returns the bytes it dropped.
    pub fn skip(&mut self, count: f64, window: f64) -> f64 {
        skip_stream(self.stream.as_mut(), count, window)
    }

    /// The row of the stream, or undefined.
    #[wasm_bindgen(js_name = streamRow)]
    #[must_use]
    pub fn stream_row(&self) -> Option<u32> {
        self.stream
            .as_ref()
            .map(|stream| u32::try_from(stream.row()).unwrap_or(u32::MAX))
    }

    /// The bytes that the stream decoded.
    #[expect(
        clippy::cast_precision_loss,
        reason = "Byte counts are exact f64 integers below 2^53."
    )]
    #[must_use]
    pub fn produced(&self) -> f64 {
        self.stream
            .as_ref()
            .map_or(0.0, |stream| stream.produced() as f64)
    }

    /// 0 while more bytes can follow, 1 when all bytes are decoded and
    /// verified, 2 after an error.
    #[wasm_bindgen(js_name = streamState)]
    #[must_use]
    pub fn stream_state(&self) -> u32 {
        stream_state(self.stream.as_ref())
    }

    /// The decode error of the stream, or undefined.
    #[wasm_bindgen(js_name = streamError)]
    #[must_use]
    pub fn stream_error(&self) -> Option<String> {
        match self.stream.as_ref().map(Stream::status) {
            Some(Status::Failed(message)) => Some(message.clone()),
            None => Some("No entry is started".to_string()),
            _ => None,
        }
    }

    /// Starts a zip with room for the records of `capacity` entries.
    /// Grow the heap first with `reserveHeap` to the size
    /// that `zipEstimate` gives, so that this call and the later calls
    /// use free heap.
    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit leaves no room.
    #[wasm_bindgen(js_name = zipBegin)]
    pub fn zip_begin(&mut self, capacity: u32) -> Result<(), JsError> {
        self.zip = None;
        self.zip = Some(ZipOut::new(u64::from(capacity)).map_err(|err| JsError::new(&err))?);
        Ok(())
    }

    /// Adds a folder to the zip. `path` ends with `/`.
    ///
    /// # Errors
    ///
    /// Returns an error when no zip is started, when an entry is open or
    /// when the memory limit leaves no room.
    #[wasm_bindgen(js_name = zipFolder)]
    pub fn zip_folder(&mut self, path: &str, modified: f64) -> Result<(), JsError> {
        self.zip_mut()?
            .add_folder(path, crate::zipout::modified_time(modified))
            .map_err(|err| JsError::new(&err))
    }

    /// Opens a file entry of the zip at `path` for a row. With `decode`,
    /// the zip stores the decoded bytes; else it copies the compressed
    /// bytes with their method. The read worker verified the row first.
    /// `zipStep` writes the data.
    ///
    /// # Errors
    ///
    /// Returns an error when no zip is started, when an entry is open,
    /// when the row cannot be found or decoded, or when the memory limit
    /// leaves no room.
    #[wasm_bindgen(js_name = zipFile)]
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "Keep the JS conversion: saturate the window and discard its fraction."
    )]
    pub fn zip_file(
        &mut self,
        row: u32,
        path: &str,
        decode: bool,
        modified: f64,
        window: f64,
    ) -> Result<(), JsError> {
        crate::heap::probe(START_PROBE_BYTES).map_err(|err| JsError::new(&err.to_string()))?;
        let index = row as usize;
        let located = self
            .directory
            .locate(index)
            .ok_or_else(|| JsError::new(&format!("The central directory has no row {row}")))?;
        let archive = self.directory.archive();
        let records = self.job_records.as_ref().unwrap_or(&self.records);
        let record = local::read_record_from(records, located).map_err(|err| {
            JsError::new(&format!(
                "The central-directory record cannot be read: {err}"
            ))
        })?;
        let data = if decode {
            let stream =
                Stream::open_with_window(archive, index, located, &record, window.max(0.0) as u64)
                    .map_err(|err| JsError::new(&err.to_string()))?;
            Data::Decoded(stream)
        } else {
            let entry = archive
                .get_entry(located.wayfinder)
                .map_err(|err| JsError::new(&format!("The entry data cannot be found: {err}")))?;
            Data::Raw {
                reader: Box::new(entry.reader()),
                method: record.method,
                compressed: located.wayfinder.compressed_size_hint(),
            }
        };
        let crc32 = record.crc32;
        let size = located.wayfinder.uncompressed_size_hint();
        self.zip_mut()?
            .add_file(
                path,
                data,
                crc32,
                size,
                crate::zipout::modified_time(modified),
            )
            .map_err(|err| JsError::new(&err))
    }

    /// Writes up to `max_bytes` more bytes of the open entry of the zip.
    /// Returns true when the entry is complete. `zipTake` gives the output.
    ///
    /// # Errors
    ///
    /// Returns an error when the data does not agree with the central
    /// directory, when decoding fails or when the memory limit leaves no
    /// room. The zip is then not usable.
    #[wasm_bindgen(js_name = zipStep)]
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "Keep the JS conversion: saturate the window and discard its fraction."
    )]
    pub fn zip_step(&mut self, max_bytes: u32, window: f64) -> Result<bool, JsError> {
        let step = self
            .zip_mut()?
            .step(max_bytes as usize, window.max(0.0) as u64)
            .map_err(|err| JsError::new(&err))?;
        Ok(step == Step::Done)
    }

    /// Writes the central directory and the end records of the zip. Take
    /// all output first.
    ///
    /// # Errors
    ///
    /// Returns an error when an entry is open or when the memory limit
    /// leaves no room.
    #[wasm_bindgen(js_name = zipFinish)]
    pub fn zip_finish(&mut self) -> Result<(), JsError> {
        self.zip_mut()?.finish().map_err(|err| JsError::new(&err))
    }

    /// Takes up to `max_bytes` of the output of the zip.
    #[wasm_bindgen(js_name = zipTake)]
    pub fn zip_take(&mut self, max_bytes: u32) -> Vec<u8> {
        self.zip
            .as_mut()
            .map(|zip| zip.take(max_bytes as usize))
            .unwrap_or_default()
    }

    /// The output bytes of the zip that `zipTake` did not give yet.
    #[wasm_bindgen(js_name = zipPending)]
    #[must_use]
    pub fn zip_pending(&self) -> u32 {
        self.zip
            .as_ref()
            .map_or(0, |zip| u32::try_from(zip.pending()).unwrap_or(u32::MAX))
    }

    /// Frees the zip.
    #[wasm_bindgen(js_name = zipEnd)]
    pub fn zip_end(&mut self) {
        self.zip = None;
    }
}

impl ReadArchive {
    fn zip_mut(&mut self) -> Result<&mut ZipOut, JsError> {
        self.zip
            .as_mut()
            .ok_or_else(|| JsError::new("No zip is started"))
    }
}

/// Checks the local header of a row and opens its stream.
#[expect(
    clippy::cast_precision_loss,
    reason = "The JS API uses f64 sizes, exact to 2^53."
)]
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "Keep the JS conversion: saturate the window and discard its fraction."
)]
fn open_row(
    directory: &mut Directory<JsReader>,
    records: &JsReader,
    row: u32,
    window: f64,
) -> Result<(EntryStart, Option<Stream>), JsError> {
    let window = window.max(0.0) as u64;
    let index = row as usize;
    let located = directory
        .locate(index)
        .ok_or_else(|| JsError::new(&format!("The central directory has no row {row}")))?;
    let archive = directory.archive();
    let mut start = EntryStart {
        mismatches: 0,
        local_name: Vec::new(),
        method: 0,
        flags: 0,
        crc32: 0,
        uncompressed_size: located.wayfinder.uncompressed_size_hint() as f64,
        compressed_size: located.wayfinder.compressed_size_hint() as f64,
        error: None,
    };
    // The checks and the decoder state make small allocations that
    // cannot fail cleanly. Make sure they fit below the cap.
    if crate::heap::probe(START_PROBE_BYTES).is_err() {
        start.error = Some(crate::heap::limit_error().to_string());
        return Ok((start, None));
    }
    let record: Record = match local::read_record_from(records, located) {
        Ok(record) => record,
        Err(err) => {
            start.error = Some(format!(
                "The central-directory record cannot be read: {err}"
            ));
            return Ok((start, None));
        }
    };
    start.method = record.method;
    start.flags = record.flags;
    start.crc32 = record.crc32;
    match local::check_record(archive, located, record.clone()) {
        Ok(check) => {
            start.mismatches = check.mismatches;
            start.local_name = check.local_name;
        }
        Err(err) => {
            start.error = Some(format!("The local header cannot be read: {err}"));
            return Ok((start, None));
        }
    }
    match Stream::open_with_window(archive, index, located, &record, window) {
        Ok(stream) => Ok((start, Some(stream))),
        Err(err) => {
            start.error = Some(err.to_string());
            Ok((start, None))
        }
    }
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "Keep the JS conversion: saturate the window and discard its fraction."
)]
fn read_stream(stream: Option<&mut Stream>, max_bytes: u32, window: f64) -> Vec<u8> {
    let mut out = Vec::new();
    if let Some(stream) = stream {
        if crate::heap::probe(STEP_PROBE_BYTES).is_err() {
            stream.fail_for_memory();
            return out;
        }
        stream.set_window_limit(window.max(0.0) as u64);
        stream.read(&mut out, max_bytes as usize);
    }
    out
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "Byte counts are exact f64 integers below 2^53."
)]
fn skip_stream(stream: Option<&mut Stream>, count: f64, window: f64) -> f64 {
    stream.map_or(0.0, |stream| {
        if crate::heap::probe(STEP_PROBE_BYTES).is_err() {
            stream.fail_for_memory();
            return 0.0;
        }
        stream.set_window_limit(window.max(0.0) as u64);
        stream.skip(count.max(0.0) as u64) as f64
    })
}

fn stream_state(stream: Option<&Stream>) -> u32 {
    match stream.map(Stream::status) {
        None | Some(Status::Failed(_)) => 2,
        Some(Status::Reading) => 0,
        Some(Status::Verified) => 1,
    }
}

/// The decode stream of one row for an extraction. It is not
/// the stream of the preview, so a preview and an extraction can decode at
/// the same time.
#[wasm_bindgen]
#[derive(Debug)]
pub struct EntryReader {
    start: EntryStart,
    stream: Option<Stream>,
}

#[wasm_bindgen]
impl EntryReader {
    /// What `openEntry` found: the local header check and the record.
    #[must_use]
    pub fn info(&self) -> EntryStart {
        self.start.clone()
    }

    /// Decodes up to `max_bytes` more bytes, as `ReadArchive.read`.
    pub fn read(&mut self, max_bytes: u32, window: f64) -> Vec<u8> {
        read_stream(self.stream.as_mut(), max_bytes, window)
    }

    /// Decodes and drops up to `count` bytes, as `ReadArchive.skip`.
    pub fn skip(&mut self, count: f64, window: f64) -> f64 {
        skip_stream(self.stream.as_mut(), count, window)
    }

    /// The bytes decoded so far.
    #[expect(
        clippy::cast_precision_loss,
        reason = "Byte counts are exact f64 integers below 2^53."
    )]
    #[must_use]
    pub fn produced(&self) -> f64 {
        self.stream
            .as_ref()
            .map_or(0.0, |stream| stream.produced() as f64)
    }

    /// 0 while more bytes can follow, 1 when all bytes are decoded and
    /// verified, 2 after an error or when no stream started.
    #[must_use]
    pub fn state(&self) -> u32 {
        stream_state(self.stream.as_ref())
    }

    /// The error, or undefined.
    #[must_use]
    pub fn error(&self) -> Option<String> {
        match self.stream.as_ref().map(Stream::status) {
            Some(Status::Failed(message)) => Some(message.clone()),
            None => Some(
                self.start
                    .error
                    .clone()
                    .unwrap_or_else(|| "The entry cannot be decoded".to_string()),
            ),
            _ => None,
        }
    }
}

/// The plan of an extraction: the safe output folders and files of the
/// rows of one folder, and the skipped rows (see `sanitize::Planner`).
#[wasm_bindgen]
#[derive(Debug)]
pub struct ExtractPlan {
    planner: Planner,
}

#[wasm_bindgen]
impl ExtractPlan {
    /// Starts a plan for the folder at `folder`, as the tree gives its
    /// path. An empty path is the whole archive.
    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit leaves no room.
    #[wasm_bindgen(constructor)]
    pub fn new(folder: &str) -> Result<ExtractPlan, JsError> {
        room(folder.len())?;
        Planner::new(folder, js_nfd)
            .map(|planner| ExtractPlan { planner })
            .map_err(|_full| plan_no_room())
    }

    /// Adds a row with its UTF-8 name, the NFC form of the name and the
    /// fields of its record.
    /// Returns 0 when the row is not in the folder, 1 for a file, 2 for a
    /// folder entry and 3 for a skipped row.
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
    ) -> Result<u32, JsError> {
        let added = self
            .planner
            .add(row, name, nfc, attributes, method, flags)
            .map_err(|_full| plan_no_room())?;
        Ok(match added {
            Added::Outside => 0,
            Added::File => 1,
            Added::Folder => 2,
            Added::Skipped(_) => 3,
        })
    }

    /// The output files.
    #[must_use]
    pub fn files(&self) -> u32 {
        u32::try_from(self.planner.files().len()).unwrap_or(u32::MAX)
    }

    #[wasm_bindgen(js_name = fileRow)]
    #[must_use]
    pub fn file_row(&self, index: u32) -> u32 {
        self.planner.files()[index as usize].row
    }

    #[wasm_bindgen(js_name = fileFolder)]
    #[must_use]
    pub fn file_folder(&self, index: u32) -> u32 {
        self.planner.files()[index as usize].folder
    }

    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit leaves no room for the copy.
    #[wasm_bindgen(js_name = fileName)]
    pub fn file_name(&self, index: u32) -> Result<String, JsError> {
        text_copy(&self.planner.files()[index as usize].name)
    }

    /// The `renamed` bits of the file name.
    #[wasm_bindgen(js_name = fileRenamed)]
    #[must_use]
    pub fn file_renamed(&self, index: u32) -> u8 {
        self.planner.files()[index as usize].renamed
    }

    /// The output folders. Index 0 is the output folder itself.
    #[must_use]
    pub fn folders(&self) -> u32 {
        u32::try_from(self.planner.folders().len()).unwrap_or(u32::MAX)
    }

    #[wasm_bindgen(js_name = folderParent)]
    #[must_use]
    pub fn folder_parent(&self, index: u32) -> u32 {
        self.planner.folders()[index as usize].parent
    }

    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit leaves no room for the copy.
    #[wasm_bindgen(js_name = folderName)]
    pub fn folder_name(&self, index: u32) -> Result<String, JsError> {
        text_copy(&self.planner.folders()[index as usize].name)
    }

    #[wasm_bindgen(js_name = folderRenamed)]
    #[must_use]
    pub fn folder_renamed(&self, index: u32) -> u8 {
        self.planner.folders()[index as usize].renamed
    }

    /// The path of a renamed folder in the archive, or an empty string.
    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit leaves no room for the copy.
    #[wasm_bindgen(js_name = folderSource)]
    pub fn folder_source(&self, index: u32) -> Result<String, JsError> {
        text_copy(&self.planner.folders()[index as usize].source)
    }

    /// The folder entry of the folder, or the first row below it.
    #[wasm_bindgen(js_name = folderRow)]
    #[must_use]
    pub fn folder_row(&self, index: u32) -> u32 {
        self.planner.folders()[index as usize].row
    }

    /// The path of a folder below the output folder, with a `/` after
    /// each segment.
    ///
    /// # Errors
    ///
    /// Returns an error when the memory limit leaves no room for the copy.
    #[wasm_bindgen(js_name = folderPath)]
    pub fn folder_path(&self, index: u32) -> Result<String, JsError> {
        // The path has at most `MAX_PATH_BYTES` bytes and its folders.
        room(crate::sanitize::MAX_PATH_BYTES)?;
        text_copy(&self.planner.folder_path(index))
    }

    /// The skipped rows.
    #[must_use]
    pub fn skipped(&self) -> u32 {
        u32::try_from(self.planner.skipped().len()).unwrap_or(u32::MAX)
    }

    #[wasm_bindgen(js_name = skippedRow)]
    #[must_use]
    pub fn skipped_row(&self, index: u32) -> u32 {
        self.planner.skipped()[index as usize].0
    }

    /// The `Skip` code of a skipped row.
    #[wasm_bindgen(js_name = skippedReason)]
    #[must_use]
    pub fn skipped_reason(&self, index: u32) -> u8 {
        self.planner.skipped()[index as usize].1 as u8
    }

    /// The UTF-8 bytes of all output paths.
    #[wasm_bindgen(js_name = pathBytes)]
    #[expect(
        clippy::cast_precision_loss,
        reason = "Byte counts are exact f64 integers below 2^53."
    )]
    #[must_use]
    pub fn path_bytes(&self) -> f64 {
        self.planner.path_bytes() as f64
    }
}

/// A safe file name for one entry that the user saves on its own: the
/// last segment of `name`, cleaned (see `sanitize::file_name`).
///
/// # Errors
///
/// Returns an error when the memory limit leaves no room.
#[wasm_bindgen(js_name = safeFileName)]
pub fn safe_file_name(name: &str, fallback: &str) -> Result<String, JsError> {
    room(name.len() + fallback.len())?;
    Ok(crate::sanitize::file_name(name, fallback).0)
}

/// The `renamed` bits of `safeFileName` for the same arguments.
///
/// # Errors
///
/// Returns an error when the memory limit leaves no room.
#[wasm_bindgen(js_name = safeFileRenamed)]
pub fn safe_file_renamed(name: &str, fallback: &str) -> Result<u8, JsError> {
    room(name.len() + fallback.len())?;
    Ok(crate::sanitize::file_name(name, fallback).1)
}

/// Makes sure of free heap for the small allocations of a call that
/// handles a text of `bytes` bytes (four times the text and 64 KiB), so a
/// full memory gives an error, not a trap.
fn room(bytes: usize) -> Result<(), JsError> {
    crate::heap::probe(4 * bytes + 64 * 1024).map_err(|err| JsError::new(&err.to_string()))
}

/// The error of a plan that does not fit below the memory limit. A plan
/// fails only for memory, so the message has only the memory-limit text.
fn plan_no_room() -> JsError {
    JsError::new("The memory limit leaves no room for the plan of this extraction")
}

/// A fallible copy of a text for JS.
fn text_copy(text: &str) -> Result<String, JsError> {
    room(text.len())?;
    let mut copy = String::new();
    copy.try_reserve_exact(text.len())
        .map_err(|_full| JsError::new(&crate::heap::limit_error().to_string()))?;
    copy.push_str(text);
    Ok(copy)
}

/// True when the external attributes mark a link.
#[wasm_bindgen(js_name = isLink)]
#[must_use]
pub fn is_link(attributes: u32) -> bool {
    crate::sanitize::is_link(attributes)
}

/// The most heap bytes of a zip of `entries` entries with `nameBytes`
/// bytes of paths (see `ZipOut::estimate`).
#[wasm_bindgen(js_name = zipEstimate)]
#[must_use]
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "Byte counts are exact f64 integers below 2^53."
)]
pub fn zip_estimate(entries: f64, name_bytes: f64) -> f64 {
    ZipOut::estimate(entries.max(0.0) as u64, name_bytes.max(0.0) as u64) as f64
}

/// Allocates and holds one block of `bytes` (see `heap::reserve`).
/// Returns false when it does not fit below the cap.
#[wasm_bindgen(js_name = reserveHeap)]
#[must_use]
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "Keep the JS conversion: saturate the size and discard its fraction."
)]
pub fn reserve_heap(bytes: f64) -> bool {
    crate::heap::reserve(bytes.max(0.0) as usize)
}

/// Frees the blocks of `reserveHeap`.
#[wasm_bindgen(js_name = releaseHeap)]
pub fn release_heap() {
    crate::heap::release();
}
