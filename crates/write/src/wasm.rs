//! The wasm exports of the write module.

use rawzip::ReaderAt;
use wasm_bindgen::prelude::*;

use crate::encode::{self, Encoder, State};
use crate::out::RemuxOut;
use crate::remux::Remux;

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

/// The free heap that a call makes sure of before it reads headers and
/// makes a decoder (see `zipscope_heap::probe`).
const START_PROBE_BYTES: usize = 768 * 1024;
/// The free heap that a step makes sure of.
const STEP_PROBE_BYTES: usize = 256 * 1024;

#[wasm_bindgen(
    inline_js = "export function reserveGrowth(bytes) { try { const budget = globalThis.__zipscopeWriteMemory; return budget === undefined || budget.reserve(bytes) === true; } catch { return false; } }
export function releaseGrowth(bytes) { try { globalThis.__zipscopeWriteMemory?.release(bytes); } catch {} }"
)]
extern "C" {
    /// Reserves a growth of the wasm memory on the shared memory budget
    /// (`globalThis.__zipscopeWriteMemory`, which the write worker sets).
    /// Before the worker sets it, all growth is permitted: the worker
    /// reserves the memory size when it gets the header.
    #[wasm_bindgen(js_name = reserveGrowth)]
    fn reserve_growth(bytes: f64) -> bool;
    /// Gives back a reservation when the memory did not grow.
    #[wasm_bindgen(js_name = releaseGrowth)]
    fn release_growth(bytes: f64);
}

/// The shared memory budget of a write worker. The allocator calls it
/// before it grows the wasm memory.
#[derive(Debug)]
pub struct WriteBudget;

#[expect(
    clippy::cast_precision_loss,
    reason = "Growth is whole wasm pages, far below 2^53 bytes."
)]
impl zipscope_heap::Budget for WriteBudget {
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

/// Sets the most wasm memory in bytes. The allocator does not grow the
/// memory past it. The worker sets it before each call that can allocate.
#[wasm_bindgen(js_name = setMemoryCap)]
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "Keep the JS conversion: saturate the cap and discard its fraction."
)]
pub fn set_memory_cap(bytes: f64) {
    zipscope_heap::set_cap(bytes.max(0.0) as usize);
}

/// The live heap bytes of the write wasm.
#[wasm_bindgen(js_name = heapBytes)]
#[must_use]
#[expect(
    clippy::cast_precision_loss,
    reason = "Byte counts are exact f64 integers below 2^53."
)]
pub fn heap_bytes() -> f64 {
    zipscope_heap::live_bytes() as f64
}

/// The Zstandard level of the remux.
#[wasm_bindgen(js_name = zstdLevel)]
#[must_use]
pub fn zstd_level() -> i32 {
    encode::LEVEL
}

/// The most heap bytes of the lead for a copy of `entries` entries whose
/// central directory has `directory_bytes` bytes.
#[wasm_bindgen(js_name = remuxEstimate)]
#[must_use]
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "Byte counts are exact f64 integers below 2^53."
)]
pub fn remux_estimate(entries: f64, directory_bytes: f64) -> f64 {
    RemuxOut::estimate(entries.max(0.0) as u64, directory_bytes.max(0.0) as u64) as f64
}

fn js_error(message: impl AsRef<str>) -> JsError {
    JsError::new(message.as_ref())
}

/// The memory error text. It is static: at the limit, the error path
/// must not allocate (`JsError::new` passes the text to JS without a
/// copy in wasm).
const MEMORY_TEXT: &str = "The memory limit leaves no room for this step";

fn probe(bytes: usize) -> Result<(), JsError> {
    zipscope_heap::probe(bytes).map_err(|_full| JsError::new(MEMORY_TEXT))
}

/// The work of a row for the lead worker. `kind` is 0 for a file, 1 for
/// a folder and 2 for a row that the copy leaves out, with its skip code
/// in `skip` and the reason in `reason`.
#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct LeadJob {
    pub kind: u8,
    pub skip: u8,
    #[wasm_bindgen(getter_with_clone)]
    pub reason: Option<String>,
    /// The raw central-directory record, for the encoder.
    #[wasm_bindgen(getter_with_clone)]
    pub record: Vec<u8>,
    pub base: f64,
    pub offset: f64,
    pub uncompressed: f64,
    /// The bytes that the lead keeps for the row until it is written: its
    /// record and its local extra fields.
    pub held: u32,
}

/// The lead of a remux (see `remux::Remux`).
#[wasm_bindgen]
#[derive(Debug)]
pub struct RemuxLead {
    remux: Remux<JsReader>,
}

#[wasm_bindgen]
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "Keep the JS conversion: sizes, offsets and rows are exact f64 integers."
)]
impl RemuxLead {
    /// Finds the end of the central directory and starts the copy of
    /// `rows` rows (the listing count). `reader` reads the local headers,
    /// and `records` reads the end records and the central directory.
    ///
    /// # Errors
    ///
    /// Throws when the file is not a zip archive or when the memory limit
    /// leaves no room.
    pub fn open(
        reader: JsReader,
        records: JsReader,
        size: f64,
        rows: u32,
    ) -> Result<RemuxLead, JsError> {
        probe(START_PROBE_BYTES)?;
        Remux::open_with_rows(records, reader, size.max(0.0) as u64, rows as usize)
            .map(|remux| RemuxLead { remux })
            .map_err(js_error)
    }

    /// The bytes of the central directory.
    #[wasm_bindgen(js_name = directoryBytes)]
    #[must_use]
    pub fn directory_bytes(&self) -> f64 {
        self.remux.directory_bytes() as f64
    }

    /// The work of `row`.
    ///
    /// # Errors
    ///
    /// Throws when the row is in the copy already, when the central
    /// directory has no such row, or when the memory limit leaves no room.
    pub fn job(&mut self, row: u32) -> Result<LeadJob, JsError> {
        probe(START_PROBE_BYTES)?;
        let row = row as usize;
        let code = self.remux.skip_code(row).map_err(js_error)?;
        let held = self.remux.held(row).map_err(js_error)? as u32;
        match self.remux.job(row) {
            Ok(job) => Ok(LeadJob {
                kind: u8::from(job.folder),
                skip: 0,
                reason: None,
                record: job.record,
                base: job.base as f64,
                offset: job.offset as f64,
                uncompressed: job.uncompressed as f64,
                held,
            }),
            Err(reason) if code != 0 => Ok(LeadJob {
                kind: 2,
                skip: code,
                reason: Some(reason),
                record: Vec::new(),
                base: 0.0,
                offset: 0.0,
                uncompressed: 0.0,
                held,
            }),
            Err(reason) => Err(js_error(reason)),
        }
    }

    /// Opens the file of `row`, the next row, with the output method.
    /// False when the copy left the row out (its extra fields leave no
    /// room for the zip64 field).
    ///
    /// # Errors
    ///
    /// Throws when `row` is not the next row or the copy cannot write it.
    pub fn begin(&mut self, row: u32, method: u16) -> Result<bool, JsError> {
        probe(STEP_PROBE_BYTES)?;
        self.remux.begin(row as usize, method).map_err(js_error)
    }

    /// Writes a part of the open file.
    ///
    /// # Errors
    ///
    /// Throws when the copy cannot write it.
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.remux.write(bytes).map_err(js_error)
    }

    /// Ends the open file.
    ///
    /// # Errors
    ///
    /// Throws when no file is open.
    pub fn end(&mut self) -> Result<(), JsError> {
        self.remux.end().map_err(js_error)
    }

    /// Writes `row`, the next row, a folder.
    ///
    /// # Errors
    ///
    /// Throws when `row` is not the next row or not a folder.
    pub fn folder(&mut self, row: u32) -> Result<bool, JsError> {
        probe(STEP_PROBE_BYTES)?;
        self.remux.folder(row as usize).map_err(js_error)
    }

    /// Leaves `row`, the next row, out of the copy.
    ///
    /// # Errors
    ///
    /// Throws when `row` is not the next row.
    #[wasm_bindgen(js_name = leaveOut)]
    pub fn leave_out(&mut self, row: u32, reason: String) -> Result<(), JsError> {
        self.remux.leave_out(row as usize, reason).map_err(js_error)
    }

    /// Writes the central directory and the end records.
    ///
    /// # Errors
    ///
    /// Throws when rows are not in the copy yet or the copy cannot write
    /// it. Then no end record is written.
    pub fn finish(&mut self) -> Result<(), JsError> {
        probe(STEP_PROBE_BYTES)?;
        self.remux.finish().map(drop).map_err(js_error)
    }

    /// Takes up to `max_bytes` of the output.
    #[must_use]
    pub fn take(&mut self, max_bytes: u32) -> Vec<u8> {
        self.remux.take(max_bytes as usize)
    }

    /// The output bytes that `take` did not give yet.
    #[must_use]
    pub fn pending(&self) -> u32 {
        self.remux.pending() as u32
    }

    /// The entries in the copy.
    #[must_use]
    pub fn written(&self) -> u32 {
        self.remux.written() as u32
    }
}

/// What `RemuxEncoder.start` found.
#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct EncodeStart {
    pub mismatches: u32,
    /// A skip code when the copy leaves the entry out, else 0.
    pub skip: u8,
    #[wasm_bindgen(getter_with_clone)]
    pub error: Option<String>,
}

/// An encoder of the pool (see `encode::Encoder`).
#[wasm_bindgen]
#[derive(Debug)]
pub struct RemuxEncoder {
    encoder: Encoder<JsReader>,
    memory_failed: bool,
}

#[wasm_bindgen]
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "Keep the JS conversion: sizes and offsets are exact f64 integers."
)]
impl RemuxEncoder {
    /// Makes the encoder of the file of `size` bytes.
    ///
    /// # Errors
    ///
    /// Throws when the memory limit leaves no room.
    pub fn open(reader: JsReader, size: f64) -> Result<RemuxEncoder, JsError> {
        probe(START_PROBE_BYTES)?;
        Encoder::open(reader, size.max(0.0) as u64)
            .map(|encoder| RemuxEncoder {
                encoder,
                memory_failed: false,
            })
            .map_err(js_error)
    }

    /// Starts an entry from its raw record (see `Encoder::start`).
    pub fn start(
        &mut self,
        record: &[u8],
        base: f64,
        offset: f64,
        row: u32,
        window: f64,
    ) -> EncodeStart {
        if zipscope_heap::probe(START_PROBE_BYTES).is_err() {
            return EncodeStart {
                mismatches: 0,
                skip: encode::skip::MEMORY,
                // No text: the JS side gives it, because this path must
                // not allocate.
                error: None,
            };
        }
        self.memory_failed = false;
        let start = self.encoder.start(
            record,
            base.max(0.0) as u64,
            offset.max(0.0) as u64,
            row as usize,
            window.max(0.0) as u64,
        );
        EncodeStart {
            mismatches: start.mismatches,
            skip: start.skip,
            error: start.error,
        }
    }

    /// Decodes up to `max_bytes` more bytes and returns the output of the
    /// step.
    pub fn step(&mut self, max_bytes: u32, window: f64) -> Vec<u8> {
        if zipscope_heap::probe(STEP_PROBE_BYTES).is_err() {
            // No text: this path must not allocate (`memoryFailed`).
            self.encoder.fail(String::new());
            self.memory_failed = true;
            return Vec::new();
        }
        self.encoder
            .step(max_bytes as usize, window.max(0.0) as u64)
    }

    /// 0 in the verify pass (no output yet), 3 in the output pass, 1 when
    /// all output is given, 2 after an error.
    #[must_use]
    pub fn state(&self) -> u32 {
        match self.encoder.state() {
            State::Verifying => 0,
            State::Writing => 3,
            State::Done => 1,
            State::Failed(_) => 2,
        }
    }

    /// The error, or undefined.
    #[must_use]
    pub fn error(&self) -> Option<String> {
        match self.encoder.state() {
            State::Failed(message) => Some(message),
            _ => None,
        }
    }

    /// The output method (0 stored, 93 Zstandard), after the first step.
    #[must_use]
    pub fn method(&self) -> u16 {
        self.encoder.method()
    }

    /// The decoded bytes of the entry.
    #[must_use]
    pub fn produced(&self) -> f64 {
        self.encoder.produced() as f64
    }

    /// True when the last entry stopped because a step had no room. Its
    /// `error` is then empty, and the JS side gives the text.
    #[wasm_bindgen(js_name = memoryFailed)]
    #[must_use]
    pub fn memory_failed(&self) -> bool {
        self.memory_failed
    }

    /// Ends the entry.
    pub fn end(&mut self) {
        self.encoder.end();
        self.memory_failed = false;
    }
}
