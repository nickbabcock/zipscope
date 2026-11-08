//! The remux: the API that ties the lead and the encoders together.
//!
//! [`Remux`] reads the central directory, gives a [`Job`] for each row,
//! takes the result of each row in any order, and writes the copy in row
//! order. [`encode`] runs one job, as an encoder of the pool does. The
//! browser workers use the same parts through the wasm exports: the lead
//! worker has a `Remux`, and each encoder worker has an [`Encoder`].

use std::collections::BTreeMap;

use rawzip::ReaderAt;

use crate::encode::{Encoder, State, skip};
use crate::lead::{Kind, Lead};

/// The step of [`encode`]: the most decoded bytes in one step.
pub const STEP_BYTES: usize = 1 << 20;
/// The Zstandard window limit of the source data.
const WINDOW_BYTES: u64 = zipscope_read::zstd::MAX_WINDOW_BYTES;

/// The work of one row for an encoder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub row: usize,
    /// True for a folder entry: it has no data.
    pub folder: bool,
    /// The raw central-directory record.
    pub record: Vec<u8>,
    /// The offset that rawzip adds to the local header offsets.
    pub base: u64,
    /// The local header offset, with `base`.
    pub offset: u64,
    /// The uncompressed size from the central directory.
    pub uncompressed: u64,
    /// The bytes that the lead keeps for the row until it is written.
    pub held: usize,
}

/// The result of one job, without its data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Encoded {
    pub row: usize,
    /// The output method.
    pub method: u16,
    pub folder: bool,
}

/// The rows that the copy left out, with the reason of each.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub left_out: Vec<(usize, String)>,
}

/// The text of a skip code.
#[must_use]
pub fn skip_text(code: u8) -> &'static str {
    match code {
        skip::ENCRYPTED => "The entry is encrypted",
        skip::METHOD => "Zipscope cannot decode the compression method of the entry",
        skip::LOCAL_HEADER => "The local header does not agree with the central directory",
        skip::MEMORY => "The memory limit leaves no room",
        skip::WRITE => {
            "The extra fields of the entry leave no room for the zip64 field of the copy"
        }
        _ => "The data did not verify",
    }
}

/// Runs one job: it decodes the data of the row through rawzip's
/// verifying reader and writes the new data to `out` in steps. Nothing
/// goes to `out` before the data verified.
///
/// # Errors
///
/// Returns why the row is left out: the entry is encrypted, has a method
/// that the read module cannot decode, a local header that disagrees, or
/// data that does not verify. Also when the memory limit leaves no room.
pub fn encode<R: ReaderAt + 'static>(
    reader: R,
    size: u64,
    job: &Job,
    out: &mut dyn std::io::Write,
) -> Result<Encoded, String> {
    if job.folder {
        return Ok(Encoded {
            row: job.row,
            method: crate::encode::STORED,
            folder: true,
        });
    }
    let mut encoder = Encoder::open(reader, size)?;
    let start = encoder.start(&job.record, job.base, job.offset, job.row, WINDOW_BYTES);
    if let Some(error) = start.error {
        return Err(error);
    }
    let mut empty = 0;
    loop {
        let part = encoder.step(STEP_BYTES, WINDOW_BYTES);
        let state = encoder.state();
        if !part.is_empty() {
            out.write_all(&part)
                .map_err(|err| format!("The copy could not be written: {err}"))?;
        }
        match state {
            State::Done => break,
            State::Failed(message) => return Err(message),
            State::Verifying | State::Writing => {}
        }
        // A step with no output and no decoded bytes waits for a new
        // Zstandard window; it cannot happen many times in a row.
        let produced = encoder.produced();
        empty = if part.is_empty() && produced == 0 {
            empty + 1
        } else {
            0
        };
        if empty > 1024 {
            return Err("Decoding did not go forward".to_string());
        }
    }
    Ok(Encoded {
        row: job.row,
        method: encoder.method(),
        folder: false,
    })
}

/// The result of a row, as [`Remux::add`] takes it.
pub type RowResult = Result<(Encoded, Vec<u8>), String>;

/// The coordinator of a remux: one ordered output stream.
pub struct Remux<R: 'static> {
    lead: Lead<R>,
    rows: usize,
    /// The next row of the copy.
    next: usize,
    /// The results that wait for the rows before them.
    waiting: BTreeMap<usize, RowResult>,
    report: Report,
    /// The row of the open file of [`Remux::begin`].
    open: Option<usize>,
    /// True after a write error: the copy is not usable.
    broken: bool,
}

impl<R> std::fmt::Debug for Remux<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Remux")
            .field("rows", &self.rows)
            .field("next", &self.next)
            .finish_non_exhaustive()
    }
}

impl<R: ReaderAt + 'static> Remux<R> {
    /// Reads the central directory of the source archive one time, to
    /// count its rows. The records are read again for the jobs.
    ///
    /// # Errors
    ///
    /// Returns an error when the source is not a zip archive, when a
    /// record cannot be read, or when the memory limit leaves no room.
    pub fn open(reader: R, size: u64) -> Result<Self, String>
    where
        R: Clone,
    {
        let lead = Lead::open(reader, size)?;
        let rows = lead.count()?;
        Ok(Self::with_rows(lead, rows))
    }

    /// As [`Remux::open`], for a copy whose first byte is at `offset` of
    /// the output (only for tests of zip64 output).
    ///
    /// # Errors
    ///
    /// As [`Remux::open`].
    pub fn open_at(reader: R, size: u64, offset: u64) -> Result<Self, String>
    where
        R: Clone,
    {
        let lead = Lead::with_out(reader, size, crate::out::RemuxOut::with_offset(offset)?)?;
        let rows = lead.count()?;
        Ok(Self::with_rows(lead, rows))
    }

    /// As [`Remux::open`], with the row count from the listing, and with
    /// one reader for the central directory (`records`) and one for the
    /// local headers (`locals`). The browser lead knows the count, so it
    /// does not read the central directory two times. A different count
    /// fails the copy.
    ///
    /// # Errors
    ///
    /// As [`Remux::open`].
    pub fn open_with_rows(records: R, locals: R, size: u64, rows: usize) -> Result<Self, String> {
        Ok(Self::with_rows(
            Lead::open_split(records, locals, size)?,
            rows,
        ))
    }

    fn with_rows(lead: Lead<R>, rows: usize) -> Self {
        Remux {
            lead,
            rows,
            next: 0,
            waiting: BTreeMap::new(),
            report: Report::default(),
            open: None,
            broken: false,
        }
    }

    /// The rows of the source central directory.
    #[must_use]
    pub fn rows(&self) -> usize {
        self.rows
    }

    /// The bytes of the source central directory.
    #[must_use]
    pub fn directory_bytes(&self) -> u64 {
        self.lead.directory_bytes()
    }

    /// The work of one row. The lead keeps the records from the next row
    /// of the copy to the last row that a job asked for.
    ///
    /// # Errors
    ///
    /// Returns why the row is left out (give it to [`Remux::add`]), or an
    /// error for a row that is written or does not exist.
    pub fn job(&mut self, row: usize) -> Result<Job, String> {
        if row >= self.rows {
            return Err(format!("The archive has no row {row}"));
        }
        if row < self.next {
            return Err(format!("Row {row} is in the copy already"));
        }
        let pending = self.lead.pending(row - self.next)?;
        let held = pending.record.len() + pending.local_extra.len();
        match pending.kind {
            Kind::Skip(code) => Err(skip_text(code).to_string()),
            kind => Ok(Job {
                row,
                folder: kind == Kind::Folder,
                record: pending.record.clone(),
                base: pending.base,
                offset: pending.offset,
                uncompressed: pending.uncompressed,
                held,
            }),
        }
    }

    /// The bytes that the lead keeps for a row until it is written: its
    /// record and the extra fields of its local header.
    ///
    /// # Errors
    ///
    /// As [`Remux::job`].
    pub fn held(&mut self, row: usize) -> Result<usize, String> {
        if row < self.next || row >= self.rows {
            return Err(format!("The archive has no row {row} to write"));
        }
        let pending = self.lead.pending(row - self.next)?;
        Ok(pending.record.len() + pending.local_extra.len())
    }

    /// The skip code of a row that the lead leaves out, or 0.
    ///
    /// # Errors
    ///
    /// As [`Remux::job`].
    pub fn skip_code(&mut self, row: usize) -> Result<u8, String> {
        if row < self.next || row >= self.rows {
            return Err(format!("The archive has no row {row} to write"));
        }
        Ok(match self.lead.pending(row - self.next)?.kind {
            Kind::Skip(code) => code,
            _ => 0,
        })
    }

    /// Gives the result of one row. Results come in any order; the output
    /// keeps the row order. An `Err` result leaves the row out and puts
    /// it in the report.
    ///
    /// # Errors
    ///
    /// Returns an error for a row that came before or does not exist, and
    /// when the copy cannot write a row. After a write error the copy is
    /// not usable.
    pub fn add(&mut self, row: usize, result: RowResult) -> Result<(), String> {
        if row >= self.rows {
            return Err(format!("The archive has no row {row}"));
        }
        if row < self.next || self.waiting.contains_key(&row) || self.open == Some(row) {
            return Err(format!("Row {row} came two times"));
        }
        self.waiting.insert(row, result);
        while let Some(result) = self.waiting.remove(&self.next) {
            self.write_row(result)?;
        }
        Ok(())
    }

    fn write_row(&mut self, result: RowResult) -> Result<(), String> {
        let row = self.next;
        match result {
            Ok((encoded, _)) if encoded.folder => self.folder(row).map(drop),
            Ok((encoded, data)) => {
                if self.begin(row, encoded.method)? {
                    self.write(&data)?;
                    self.end()?;
                }
                Ok(())
            }
            Err(reason) => self.leave_out(row, reason),
        }
    }

    fn guard<T>(
        &mut self,
        step: impl FnOnce(&mut Lead<R>) -> Result<T, String>,
    ) -> Result<T, String> {
        if self.broken {
            return Err("The copy could not be written".to_string());
        }
        // The lead must have the record of the next row.
        self.lead.pending(0)?;
        step(&mut self.lead).inspect_err(|_| self.broken = true)
    }

    /// Opens the file of `row`, the next row of the copy, with the output
    /// method `method`. Its data comes in [`Remux::write`] (the streamed
    /// form of [`Remux::add`]).
    ///
    /// # Errors
    ///
    /// Returns an error when `row` is not the next row, or when the copy
    /// cannot write it. Returns false, and leaves the row out, when its
    /// extra fields leave no room for the zip64 field of the copy.
    pub fn begin(&mut self, row: usize, method: u16) -> Result<bool, String> {
        if row != self.next || self.open.is_some() {
            return Err(format!("Row {row} is not the next row of the copy"));
        }
        if !self.guard(|lead| lead.begin_file(method))? {
            self.leave_out(row, skip_text(skip::WRITE).to_string())?;
            return Ok(false);
        }
        self.open = Some(row);
        Ok(true)
    }

    /// Writes a part of the open file.
    ///
    /// # Errors
    ///
    /// Returns an error when no file is open or the copy cannot write it.
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        if self.open.is_none() {
            return Err("No file is open".to_string());
        }
        self.guard(|lead| lead.write(bytes))
    }

    /// Ends the open file. The encoder verified its data.
    ///
    /// # Errors
    ///
    /// Returns an error when no file is open.
    pub fn end(&mut self) -> Result<(), String> {
        if self.open.is_none() {
            return Err("No file is open".to_string());
        }
        self.guard(Lead::end_file)?;
        self.open = None;
        self.next += 1;
        Ok(())
    }

    /// Writes the next row, a folder.
    ///
    /// # Errors
    ///
    /// Returns an error when `row` is not the next row or not a folder.
    /// Returns false, and leaves the row out, as [`Remux::begin`].
    pub fn folder(&mut self, row: usize) -> Result<bool, String> {
        if row != self.next || self.open.is_some() {
            return Err(format!("Row {row} is not the next row of the copy"));
        }
        if !self.guard(Lead::folder)? {
            self.leave_out(row, skip_text(skip::WRITE).to_string())?;
            return Ok(false);
        }
        self.next += 1;
        Ok(true)
    }

    /// Leaves out `row`, the next row of the copy, and puts it in the
    /// report.
    ///
    /// # Errors
    ///
    /// Returns an error when `row` is not the next row.
    pub fn leave_out(&mut self, row: usize, reason: String) -> Result<(), String> {
        if row != self.next || self.open.is_some() {
            return Err(format!("Row {row} is not the next row of the copy"));
        }
        self.lead.pending(0)?;
        self.lead.skip();
        let reason = if reason.is_empty() {
            skip_text(skip::VERIFY).to_string()
        } else {
            reason
        };
        self.report.left_out.push((row, reason));
        self.next += 1;
        Ok(())
    }

    /// Takes up to `max` bytes of output that are ready, in order.
    #[must_use]
    pub fn take(&mut self, max: usize) -> Vec<u8> {
        self.lead.take(max)
    }

    /// The output bytes that [`Remux::take`] did not give yet.
    #[must_use]
    pub fn pending(&self) -> usize {
        self.lead.output_pending()
    }

    /// The rows in the copy or left out.
    #[must_use]
    pub fn done(&self) -> usize {
        self.next
    }

    /// The entries in the copy.
    #[must_use]
    pub fn written(&self) -> usize {
        self.lead.written()
    }

    /// The report so far.
    #[must_use]
    pub fn report(&self) -> &Report {
        &self.report
    }

    /// Writes the central directory and the end records.
    ///
    /// # Errors
    ///
    /// Returns an error when a row did not come, when the central
    /// directory has more rows than [`Remux::rows`], or when the copy
    /// cannot write it. Then no end record is written, so the output does
    /// not look complete.
    pub fn finish(&mut self) -> Result<Report, String> {
        if self.broken {
            return Err("The copy could not be written".to_string());
        }
        if self.next < self.rows {
            return Err(format!(
                "{} of {} rows are not in the copy",
                self.rows - self.next,
                self.rows
            ));
        }
        self.lead.finish()?;
        Ok(std::mem::take(&mut self.report))
    }
}
