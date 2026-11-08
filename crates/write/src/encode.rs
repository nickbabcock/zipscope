//! The encoder of the remux pool: it verifies one entry through rawzip's
//! verifying reader, and then writes its new data in steps.
//!
//! An encoder does not read the central directory. The lead gives it the
//! raw record of each entry. rawzip gives a wayfinder only from a parsed
//! record, so the encoder shows rawzip a small virtual archive
//! ([`Virtual`]): the file, then the one record, then the end records of a
//! zip64 archive that point to that record. rawzip then parses the record
//! as usual, and the decode uses its wayfinder and its verifying reader.
//! The virtual archive is located one time; each entry only puts its
//! record in place.
//!
//! Each entry has two passes:
//!
//! 1. The verify pass decodes all data and drops it. The output of an
//!    entry starts only after its data verified, so an entry that does not
//!    verify is left out cleanly and is never in the copy. The pass keeps
//!    the data of a small entry, so a small entry is decoded one time.
//! 2. The output pass writes the data with the method that the first pass
//!    chose (see [`Plan`]).

use std::cell::RefCell;
use std::io::Read;
use std::rc::Rc;

use rawzip::{ReaderAt, ZipArchive, ZipLocator};
use zipscope_read::directory::Located;
use zipscope_read::local::{self, Record, mismatch};
use zipscope_read::stream::{OpenError, Status, Stream, method};
use zstd_safe::{CCtx, CParameter, InBuffer, OutBuffer};

use crate::kind::{compressed_head, compressed_name};
use crate::record::{MAX_RECORD_BYTES, RECORD_FIXED_BYTES, RawRecord};

/// The Zstandard level of the remux: the default level of the library.
///
/// It is fast, and it compresses about as well as deflate at its best
/// level. Its window (at most 8 MiB) is below the window limit of the read module
/// (32 MiB).
pub const LEVEL: i32 = 3;
/// The verify pass keeps the data of an entry of at most this size, so
/// that the entry is decoded one time and the encoder can choose the
/// smaller output after it compressed all of it.
pub const KEEP_BYTES: u64 = 4 << 20;
/// For a larger entry, the encoder compresses this much of its start in
/// the verify pass. When that does not get smaller, the entry is not
/// compressed.
const SAMPLE_BYTES: usize = 1 << 20;
/// For a large entry, the ratio of the Zstandard sample must be this part
/// smaller than the ratio of the archive (3%), because the sample is only
/// the start of the entry.
const SAMPLE_MARGIN: f64 = 0.03;

/// True when the Zstandard sample of `input` bytes (`output` bytes)
/// compresses better than `keep_size` bytes for `declared` bytes, with
/// [`SAMPLE_MARGIN`].
#[expect(
    clippy::cast_precision_loss,
    reason = "A ratio needs no exact integers."
)]
fn sample_wins(input: usize, output: usize, keep_size: u64, declared: u64) -> bool {
    let sample = output as f64 / input.max(1) as f64;
    let source = keep_size as f64 / declared.max(1) as f64;
    sample <= source * (1.0 - SAMPLE_MARGIN)
}

/// The bytes of the start that the format check reads.
const HEAD_BYTES: usize = 16;
/// Method codes of the output.
pub const STORED: u16 = 0;
pub const ZSTD: u16 = 93;

/// The end records of the virtual archive: the zip64 end record, its
/// locator and the end record.
const TAIL_BYTES: usize = 56 + 20 + 22;
/// The buffer that finds the end records of the virtual archive.
const LOCATE_BYTES: usize = 1024;

/// What the virtual archive shows at the place of the record.
#[derive(Debug, Default)]
struct Overlay {
    record: Vec<u8>,
    base: u64,
}

/// The virtual archive of one record (see the module documentation).
///
/// - From 0: the file from `base` on, so that the offsets in the record,
///   which are relative to `base`, find the local headers.
/// - From the file size: the record, then zeros, for
///   [`MAX_RECORD_BYTES`].
/// - Then the zip64 end record, its locator and the end record. The
///   directory has one entry and starts at the record.
#[derive(Debug)]
pub struct Virtual<R> {
    real: R,
    size: u64,
    overlay: Rc<RefCell<Overlay>>,
}

impl<R> Virtual<R> {
    /// The offset of the record: the file size. The data of the file
    /// (from `base` on) ends at or before it.
    fn record_offset(&self) -> u64 {
        self.size
    }

    fn tail_offset(&self) -> u64 {
        self.size + MAX_RECORD_BYTES as u64
    }

    /// The length of the virtual archive.
    fn length(&self) -> u64 {
        self.tail_offset() + TAIL_BYTES as u64
    }

    fn tail(&self) -> [u8; TAIL_BYTES] {
        let mut tail = [0u8; TAIL_BYTES];
        let mut at = 0;
        let mut put = |bytes: &[u8]| {
            tail[at..at + bytes.len()].copy_from_slice(bytes);
            at += bytes.len();
        };
        // Zip64 end of central directory record.
        put(&0x0606_4b50u32.to_le_bytes());
        put(&44u64.to_le_bytes());
        put(&45u16.to_le_bytes());
        put(&45u16.to_le_bytes());
        put(&0u32.to_le_bytes());
        put(&0u32.to_le_bytes());
        put(&1u64.to_le_bytes());
        put(&1u64.to_le_bytes());
        put(&(MAX_RECORD_BYTES as u64).to_le_bytes());
        put(&self.record_offset().to_le_bytes());
        // Zip64 end of central directory locator.
        put(&0x0706_4b50u32.to_le_bytes());
        put(&0u32.to_le_bytes());
        put(&self.tail_offset().to_le_bytes());
        put(&1u32.to_le_bytes());
        // End of central directory record, with the zip64 markers.
        put(&0x0605_4b50u32.to_le_bytes());
        put(&0u16.to_le_bytes());
        put(&0u16.to_le_bytes());
        put(&u16::MAX.to_le_bytes());
        put(&u16::MAX.to_le_bytes());
        put(&u32::MAX.to_le_bytes());
        put(&u32::MAX.to_le_bytes());
        put(&0u16.to_le_bytes());
        tail
    }
}

impl<R: ReaderAt> ReaderAt for Virtual<R> {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let overlay = self.overlay.borrow();
        let data_end = self.size.saturating_sub(overlay.base);
        let record = self.record_offset();
        let tail = self.tail_offset();
        let fill = |buf: &mut [u8], source: &[u8], at: u64| {
            let at = usize::try_from(at).unwrap_or(usize::MAX).min(source.len());
            let length = buf.len().min(source.len() - at);
            buf[..length].copy_from_slice(&source[at..at + length]);
            length
        };
        let limit = |end: u64| {
            usize::try_from(end - offset)
                .unwrap_or(usize::MAX)
                .min(buf.len())
        };
        if offset < data_end {
            let length = limit(data_end);
            return self.real.read_at(&mut buf[..length], offset + overlay.base);
        }
        if offset < record {
            let length = limit(record);
            buf[..length].fill(0);
            return Ok(length);
        }
        if offset < tail {
            let length = limit(tail);
            let part = &mut buf[..length];
            let copied = fill(part, &overlay.record, offset - record);
            part[copied..].fill(0);
            return Ok(length);
        }
        if offset < self.length() {
            return Ok(fill(buf, &self.tail(), offset - tail));
        }
        Ok(0)
    }
}

/// How the output pass writes an entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// The data compressed with Zstandard (method 93).
    Zstd,
    /// The decoded data, stored (method 0).
    Stored,
    /// The compressed bytes of the archive, unchanged, with their method:
    /// data that is Zstandard already, or a compressed format.
    Raw,
}

/// The state of the entry of an encoder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    /// The verify pass runs. No output came yet.
    Verifying,
    /// The output pass runs.
    Writing,
    /// All output is given.
    Done,
    /// The entry stopped with an error. When the output pass had not
    /// started, no output of the entry came, and the copy can leave the
    /// entry out.
    Failed(String),
}

/// Why the copy leaves an entry out. The codes are the `ExtractSkip`
/// codes of `web/src/contracts.ts`.
pub mod skip {
    /// The entry is encrypted.
    pub const ENCRYPTED: u8 = 9;
    /// The read module cannot decode the method.
    pub const METHOD: u8 = 10;
    /// The local header has a name or size mismatch, or it cannot be
    /// found.
    pub const LOCAL_HEADER: u8 = 11;
    /// The data did not verify, or it is not valid.
    pub const VERIFY: u8 = 12;
    /// The copy cannot write the entry: its extra fields leave no room
    /// for the zip64 field that the writer can add.
    pub const WRITE: u8 = 13;
    /// The memory limit left no room.
    pub const MEMORY: u8 = 14;
}

/// The skip code of a decode error.
#[must_use]
pub fn skip_of(message: &str) -> u8 {
    if message.contains("memory limit") {
        skip::MEMORY
    } else {
        skip::VERIFY
    }
}

/// The result of [`Encoder::start`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Start {
    /// The mismatch bits of the local header check.
    pub mismatches: u32,
    /// A skip code when the entry is not copied, else 0.
    pub skip: u8,
    /// Why the entry is not copied.
    pub error: Option<String>,
}

/// The source of the output pass.
enum Output {
    /// Not started.
    None,
    /// The data that the verify pass kept, or its compressed form.
    Kept(Vec<u8>),
    /// A second decode pass.
    Decode(Stream),
    /// The compressed bytes of the archive.
    Raw { reader: Box<dyn Read>, left: u64 },
}

/// One entry in progress.
struct Job {
    row: usize,
    located: Located,
    record: Record,
    declared: u64,
    compressed: u64,
    /// The name or the source method says that the data is compressed.
    known_compressed: bool,
    stream: Option<Stream>,
    head: Vec<u8>,
    kept: Option<Vec<u8>>,
    /// The start of a large entry: (input bytes, Zstandard bytes).
    sample: Option<(usize, usize)>,
    plan: Plan,
    context: Option<CCtx<'static>>,
    output: Output,
    state: State,
}

/// Decodes entries and writes their new data, one entry at a time.
pub struct Encoder<R: 'static> {
    /// The job goes first: its streams borrow `archive`.
    job: Option<Job>,
    /// SAFETY invariant: this reference comes from `owned`, which is
    /// never moved or freed while it lives. The streams of `job` borrow
    /// it, and `Drop` drops `job` first.
    archive: &'static ZipArchive<Virtual<R>>,
    owned: std::ptr::NonNull<ZipArchive<Virtual<R>>>,
    overlay: Rc<RefCell<Overlay>>,
    record_offset: u64,
}

impl<R> std::fmt::Debug for Encoder<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Encoder")
            .field("job", &self.job.as_ref().map(|job| &job.state))
            .finish_non_exhaustive()
    }
}

impl<R: 'static> Drop for Encoder<R> {
    fn drop(&mut self) {
        // The streams borrow the archive, so they go first.
        self.job = None;
        // SAFETY: `owned` comes from `Box::leak` in `open`, and the job
        // that borrowed it is gone.
        drop(unsafe { Box::from_raw(self.owned.as_ptr()) });
    }
}

fn zstd_error(code: usize) -> String {
    let name = zstd_safe::get_error_name(code);
    if name.contains("llocation") {
        format!("Zstandard failed: the memory limit leaves no room ({name})")
    } else {
        format!("Zstandard failed: {name}")
    }
}

fn memory_error() -> String {
    zipscope_heap::limit_error().to_string()
}

/// Compresses `input` into `out`. With `end`, it also ends the frame.
fn compress(
    context: &mut CCtx<'static>,
    input: &[u8],
    end: bool,
    out: &mut Vec<u8>,
) -> Result<(), String> {
    const ROOM: usize = 64 * 1024;
    out.try_reserve(zstd_safe::compress_bound(input.len()) + ROOM)
        .map_err(|_full| memory_error())?;
    let mut source = InBuffer::around(input);
    loop {
        if out.capacity() - out.len() < ROOM {
            out.try_reserve(2 * ROOM).map_err(|_full| memory_error())?;
        }
        // The library writes into the free capacity.
        let filled = out.len();
        out.resize(out.capacity(), 0);
        let mut target = OutBuffer::around(&mut out[filled..]);
        let directive = if end {
            zstd_safe::zstd_sys::ZSTD_EndDirective::ZSTD_e_end
        } else {
            zstd_safe::zstd_sys::ZSTD_EndDirective::ZSTD_e_continue
        };
        // The C library reports a null allocation as an error, so its
        // allocations are fallible: they never take the slack.
        let result = zipscope_heap::fallible(|| {
            context.compress_stream2(&mut target, &mut source, directive)
        });
        let written = target.pos();
        out.truncate(filled + written);
        let left = result.map_err(zstd_error)?;
        if end {
            if left == 0 {
                return Ok(());
            }
        } else if source.pos() == input.len() {
            return Ok(());
        }
    }
}

/// Makes a compression context for `declared` bytes.
fn context(declared: u64) -> Result<CCtx<'static>, String> {
    let mut context = zipscope_heap::fallible(CCtx::try_create)
        .ok_or_else(|| "Zstandard cannot start: the memory limit leaves no room".to_string())?;
    for parameter in [
        CParameter::CompressionLevel(LEVEL),
        CParameter::ChecksumFlag(false),
        CParameter::ContentSizeFlag(true),
    ] {
        context.set_parameter(parameter).map_err(zstd_error)?;
    }
    context
        .set_pledged_src_size(Some(declared))
        .map_err(zstd_error)?;
    Ok(context)
}

/// Compresses all of `input` in one frame.
fn compress_all(input: &[u8], declared: u64) -> Result<Vec<u8>, String> {
    let mut context = context(declared)?;
    let mut out = Vec::new();
    compress(&mut context, input, true, &mut out)?;
    Ok(out)
}

/// Puts the record in the virtual archive.
fn place(overlay: &RefCell<Overlay>, record: &RawRecord<'_>, base: u64) -> Result<(), String> {
    let mut overlay = overlay.borrow_mut();
    overlay.record.clear();
    overlay
        .record
        .try_reserve(record.length())
        .map_err(|_full| memory_error())?;
    overlay.record.extend_from_slice(record.bytes());
    overlay.base = base;
    Ok(())
}

/// Reads up to `want` decoded bytes into `input`. Returns true when the
/// data is complete and verified.
fn decode(stream: &mut Stream, input: &mut Vec<u8>, want: usize) -> Result<bool, String> {
    while input.len() < want && *stream.status() == Status::Reading {
        if stream.read(input, want - input.len()) == 0 {
            // A Zstandard frame waits for the next step, or the data
            // ended (the status tells).
            break;
        }
    }
    match stream.status() {
        Status::Failed(message) => Err(message.clone()),
        Status::Verified => Ok(true),
        Status::Reading => Ok(false),
    }
}

impl<R: ReaderAt + 'static> Encoder<R> {
    /// Locates the virtual archive over `reader`, the file of `size`
    /// bytes.
    ///
    /// # Errors
    ///
    /// Returns an error when a buffer does not fit below the memory limit.
    pub fn open(reader: R, size: u64) -> Result<Self, String> {
        let overlay = Rc::new(RefCell::new(Overlay::default()));
        let mut buffer = zipscope_heap::try_buffer(LOCATE_BYTES).map_err(|err| err.to_string())?;
        let virtual_archive = Virtual {
            real: reader,
            size,
            overlay: Rc::clone(&overlay),
        };
        let record_offset = virtual_archive.record_offset();
        let length = virtual_archive.length();
        let archive = ZipLocator::new()
            .locate_in_reader(virtual_archive, &mut buffer, length)
            .map_err(|(_, err)| format!("The archive cannot be read: {err}"))?;
        let owned = std::ptr::NonNull::from(Box::leak(Box::new(archive)));
        // SAFETY: see the invariant on `Encoder::archive`. `Drop` frees
        // the box after the job.
        let archive: &'static ZipArchive<Virtual<R>> = unsafe { owned.as_ref() };
        Ok(Encoder {
            job: None,
            archive,
            owned,
            overlay,
            record_offset,
        })
    }

    /// Starts an entry from its raw central-directory record. `base` is
    /// the offset that rawzip adds to the local header offsets of the
    /// archive, and `offset` is the local header offset with it, as the
    /// lead found it. `window` limits the Zstandard window of the source
    /// data.
    pub fn start(
        &mut self,
        record: &[u8],
        base: u64,
        offset: u64,
        row: usize,
        window: u64,
    ) -> Start {
        self.job = None;
        match self.try_start(record, base, offset, row, window) {
            Ok(start) => start,
            Err((skip, message)) => Start {
                mismatches: 0,
                skip,
                error: Some(message),
            },
        }
    }

    fn try_start(
        &mut self,
        record: &[u8],
        base: u64,
        offset: u64,
        row: usize,
        window: u64,
    ) -> Result<Start, (u8, String)> {
        let local_header = |message: String| (skip::LOCAL_HEADER, message);
        let parsed = RawRecord::parse(record).map_err(|err| local_header(err.to_string()))?;
        place(&self.overlay, &parsed, base).map_err(|message| (skip::MEMORY, message))?;
        // A buffer of the record length: the iterator reads only the
        // record.
        let mut buffer = zipscope_heap::try_buffer(parsed.length().max(RECORD_FIXED_BYTES))
            .map_err(|_full| (skip::MEMORY, memory_error()))?;
        let wayfinder = {
            let mut entries = self.archive.entries(&mut buffer);
            match entries.next_entry() {
                Ok(Some(found))
                    if found.local_header_offset().checked_add(base) == Some(offset) =>
                {
                    found.wayfinder()
                }
                Ok(_) => return Err(local_header("The entry data cannot be found".to_string())),
                Err(err) => {
                    return Err(local_header(format!(
                        "The central-directory record cannot be read: {err}"
                    )));
                }
            }
        };
        let located = Located {
            wayfinder,
            record_offset: self.record_offset,
        };
        let check = local::check(self.archive, located)
            .map_err(|err| local_header(format!("The local header cannot be read: {err}")))?;
        if check.mismatches & (mismatch::NAME | mismatch::SIZES | mismatch::METHOD) != 0 {
            return Err(local_header(
                "The local header does not agree with the central directory".to_string(),
            ));
        }
        let stream = Stream::open_with_window(self.archive, row, located, &check.record, window)
            .map_err(|err| match err {
                OpenError::Encrypted => (skip::ENCRYPTED, err.to_string()),
                OpenError::Unsupported(_) => (skip::METHOD, err.to_string()),
                OpenError::Archive(_) => (skip::LOCAL_HEADER, err.to_string()),
                OpenError::Decode(_) => (skip::VERIFY, err.to_string()),
            })?;
        let declared = wayfinder.uncompressed_size_hint();
        let source_zstd = matches!(check.record.method, method::ZSTD | method::ZSTD_OLD);
        self.job = Some(Job {
            row,
            located,
            declared,
            compressed: wayfinder.compressed_size_hint(),
            known_compressed: compressed_name(parsed.name()) || source_zstd,
            record: check.record,
            stream: Some(stream),
            head: Vec::new(),
            kept: (declared <= KEEP_BYTES).then(Vec::new),
            sample: None,
            plan: Plan::Zstd,
            context: None,
            output: Output::None,
            state: State::Verifying,
        });
        Ok(Start {
            mismatches: check.mismatches,
            skip: 0,
            error: None,
        })
    }

    /// Takes one step of up to `max` bytes and returns its output (empty
    /// in the verify pass). `window` limits the Zstandard window of a
    /// source frame that starts in this step.
    pub fn step(&mut self, max: usize, window: u64) -> Vec<u8> {
        let archive = self.archive;
        let Some(job) = self.job.as_mut() else {
            return Vec::new();
        };
        let result = match job.state {
            State::Verifying => job.verify(max, window).map(|()| Vec::new()),
            State::Writing => job.write(archive, max, window),
            State::Done | State::Failed(_) => return Vec::new(),
        };
        result.unwrap_or_else(|message| {
            job.fail(message);
            Vec::new()
        })
    }

    /// The state of the entry. `Failed` when no entry started.
    #[must_use]
    pub fn state(&self) -> State {
        self.job.as_ref().map_or_else(
            || State::Failed("No entry started".to_string()),
            |job| job.state.clone(),
        )
    }

    /// The output method: [`ZSTD`], [`STORED`], or the method of the
    /// archive for a raw copy. Valid when the output pass started.
    #[must_use]
    pub fn method(&self) -> u16 {
        self.job.as_ref().map_or(STORED, |job| match job.plan {
            Plan::Zstd => ZSTD,
            Plan::Stored => STORED,
            Plan::Raw => job.record.method,
        })
    }

    /// The plan of the output pass, when it started.
    #[must_use]
    pub fn plan(&self) -> Option<Plan> {
        self.job
            .as_ref()
            .filter(|job| !matches!(job.state, State::Verifying))
            .map(|job| job.plan)
    }

    /// The decoded bytes of the current pass.
    #[must_use]
    pub fn produced(&self) -> u64 {
        let Some(job) = self.job.as_ref() else {
            return 0;
        };
        match (&job.stream, &job.output) {
            (Some(stream), _) | (None, Output::Decode(stream)) => stream.produced(),
            _ => 0,
        }
    }

    /// Stops the entry with an error, for a step that cannot run.
    pub fn fail(&mut self, message: String) {
        if let Some(job) = self.job.as_mut() {
            job.fail(message);
        }
    }

    /// Ends the entry and frees its state.
    pub fn end(&mut self) {
        self.job = None;
    }
}

impl Job {
    fn fail(&mut self, message: String) {
        if matches!(self.state, State::Verifying | State::Writing) {
            self.state = State::Failed(message);
        }
        self.context = None;
        self.stream = None;
        self.output = Output::None;
        self.kept = None;
    }

    /// One step of the verify pass.
    fn verify(&mut self, max: usize, window: u64) -> Result<(), String> {
        let stream = self
            .stream
            .as_mut()
            .ok_or_else(|| "No entry started".to_string())?;
        stream.set_window_limit(window);
        let mut input = Vec::new();
        input
            .try_reserve_exact(max.min(usize::try_from(self.declared).unwrap_or(max)))
            .map_err(|_full| memory_error())?;
        let verified = decode(stream, &mut input, max)?;
        if self.head.len() < HEAD_BYTES {
            let take = (HEAD_BYTES - self.head.len()).min(input.len());
            self.head.extend_from_slice(&input[..take]);
        }
        if let Some(kept) = self.kept.as_mut() {
            kept.try_reserve(input.len())
                .map_err(|_full| memory_error())?;
            kept.extend_from_slice(&input);
        } else if self.sample.is_none() && !self.known_compressed && !input.is_empty() {
            let part = &input[..input.len().min(SAMPLE_BYTES)];
            let compressed = compress_all(part, part.len() as u64)?;
            self.sample = Some((part.len(), compressed.len()));
        }
        if verified {
            self.stream = None;
            self.choose()?;
        }
        Ok(())
    }

    /// Chooses the plan after the data verified, and starts the output
    /// pass.
    fn choose(&mut self) -> Result<(), String> {
        let source_stored = self.record.method == method::STORED;
        // A raw copy that is not larger than the data, else the data
        // stored.
        let raw_or_stored = if source_stored || self.compressed <= self.declared {
            Plan::Raw
        } else {
            Plan::Stored
        };
        let compressed = self.known_compressed || compressed_head(&self.head);
        // The size of the copy without Zstandard: the compressed bytes of
        // the archive, or the data stored, the smaller one. Zstandard must
        // be smaller than this, so that the copy is never larger than the
        // archive (level 3 loses to deflate on some text).
        let keep_size = self.compressed.min(self.declared);
        self.plan = if self.declared == 0 {
            Plan::Stored
        } else if matches!(self.record.method, method::ZSTD | method::ZSTD_OLD) {
            // Zstandard already: the verified bytes, unchanged.
            Plan::Raw
        } else if compressed {
            raw_or_stored
        } else {
            Plan::Zstd
        };
        if let Some(kept) = self.kept.take() {
            self.output = Output::Kept(match self.plan {
                Plan::Zstd => {
                    let out = compress_all(&kept, self.declared)?;
                    if (out.len() as u64) < keep_size {
                        out
                    } else {
                        // Zstandard does not make it smaller.
                        self.plan = raw_or_stored;
                        if self.plan == Plan::Raw {
                            Vec::new()
                        } else {
                            kept
                        }
                    }
                }
                Plan::Stored => kept,
                Plan::Raw => Vec::new(),
            });
        } else if self.plan == Plan::Zstd
            && self.sample.is_some_and(|(input, output)| {
                !sample_wins(input, output, keep_size, self.declared)
            })
        {
            // Zstandard does not make the start of a large entry smaller
            // than the archive has it.
            self.plan = raw_or_stored;
        }
        self.state = State::Writing;
        Ok(())
    }

    /// One step of the output pass.
    fn write<R: ReaderAt + 'static>(
        &mut self,
        archive: &'static ZipArchive<Virtual<R>>,
        max: usize,
        window: u64,
    ) -> Result<Vec<u8>, String> {
        if let Output::Kept(bytes) = &mut self.output {
            if self.plan != Plan::Raw {
                let out = std::mem::take(bytes);
                self.output = Output::None;
                self.state = State::Done;
                return Ok(out);
            }
            // A small raw copy: read it as a large one.
            self.output = Output::None;
        }
        if matches!(self.output, Output::None) {
            self.output = match self.plan {
                Plan::Raw => {
                    let entry = archive
                        .get_entry(self.located.wayfinder)
                        .map_err(|err| format!("The entry data cannot be found: {err}"))?;
                    Output::Raw {
                        reader: Box::new(entry.reader()),
                        left: self.compressed,
                    }
                }
                Plan::Zstd | Plan::Stored => {
                    let stream = Stream::open_with_window(
                        archive,
                        self.row,
                        self.located,
                        &self.record,
                        window,
                    )
                    .map_err(|err| err.to_string())?;
                    if self.plan == Plan::Zstd {
                        self.context = Some(context(self.declared)?);
                    }
                    Output::Decode(stream)
                }
            };
        }
        match &mut self.output {
            Output::None | Output::Kept(_) => Ok(Vec::new()),
            Output::Raw { reader, left } => {
                let want = usize::try_from(*left).unwrap_or(max).min(max);
                let mut out = zipscope_heap::try_buffer(want).map_err(|err| err.to_string())?;
                let mut filled = 0;
                while filled < want {
                    let read = reader
                        .read(&mut out[filled..])
                        .map_err(|err| format!("The entry data cannot be read: {err}"))?;
                    if read == 0 {
                        return Err(format!(
                            "The compressed data ended {} bytes early",
                            *left - filled as u64
                        ));
                    }
                    filled += read;
                }
                *left -= filled as u64;
                if *left == 0 {
                    self.output = Output::None;
                    self.state = State::Done;
                }
                Ok(out)
            }
            Output::Decode(stream) => {
                stream.set_window_limit(window);
                let mut input = Vec::new();
                input
                    .try_reserve_exact(max.min(usize::try_from(self.declared).unwrap_or(max)))
                    .map_err(|_full| memory_error())?;
                let verified = decode(stream, &mut input, max)?;
                let out = match self.context.as_mut() {
                    Some(context) => {
                        let mut out = Vec::new();
                        compress(context, &input, verified, &mut out)?;
                        out
                    }
                    None => input,
                };
                if verified {
                    self.context = None;
                    self.output = Output::None;
                    self.state = State::Done;
                }
                Ok(out)
            }
        }
    }
}
