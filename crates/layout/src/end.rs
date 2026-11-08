//! The one rule that chooses the end record of an archive.
//!
//! The parse worker, the read worker and the write path open an archive with
//! [`open_end`]. Thus they cannot choose different end records for one file.
//! When rawzip takes this walk (R3 in the rawzip notes), this module goes
//! away.
//!
//! rawzip stops at the last end signature in the last 1 MiB of a file. Bytes in
//! a comment or after the archive can hold that signature. A file then fails
//! to open, or it opens at a false record. [`open_end`] looks at each signature,
//! nearest the end first, and sorts it:
//!
//! - A *sound* record is complete, its comment is in the file, and a central
//!   directory is at the place that rawzip reads. See [`EndReader::soundness`].
//!   The nearest sound record wins.
//! - A sound record with a directory that does not end at it is *weak*. An
//!   optimized jar has this shape, with its directory at the start of the file.
//!   A weak record loses only to a strong record that holds it in a comment, as
//!   when a comment holds a copy of the true record.
//! - A *cut* record is complete, but its comment goes past the end of the file.
//!   The nearest cut record with a central directory wins only when no sound
//!   record exists.
//! - Each other record is false. When no record above exists, the nearest
//!   record whose comment fits is opened, as rawzip opens it, and the parse
//!   reports the error of its central directory.
//!
//! After the choice, the notes tell what the walk saw. rawzip refuses some records
//! that have a directory, for example a Zip64 record whose values differ from the
//! classic fields. Thus the notes do not ask rawzip. They look at each place that a
//! record gives for its directory, and [`EndNotes::other_records`] counts each record
//! with a directory at such a place. The places are the declared offset, the
//! declared size before the record, and with a locator, the offset and the size
//! before a Zip64 record. A place that is the chosen directory does not count.
//!
//! The walk also gives the end records before the chosen record that have a
//! directory ([`OpenedEnd::earlier`]). The parse removes each record that a row
//! covers: a row covers its local header of 30 bytes, its name, its extra field
//! and its compressed data. The walk looks only in the `COVER_BYTES` before the
//! chosen record and keeps at most `MAX_EARLIER` records, so the count of the
//! records that stay is a lower limit.
//!
//! All values in the file are untrusted. A record that is plainly false costs
//! no read. Each other record costs one *trial*, a call of rawzip with at most
//! 3 reads. The notes spend the reads that the trials leave. [`MAX_TRIALS`] limits
//! the reads, so a hostile tail stays in budget.

use std::cell::Cell;
use std::io;

use rawzip::{Error, ErrorKind, ReaderAt, ZipArchive, ZipLocator};

use crate::{END_RECORD_BYTES, LOCATOR_BYTES};

const END_SIGNATURE: [u8; 4] = *b"PK\x05\x06";
const CENTRAL_SIGNATURE: [u8; 4] = *b"PK\x01\x02";
const LOCATOR_SIGNATURE: [u8; 4] = *b"PK\x06\x07";
const ZIP64_SIGNATURE: [u8; 4] = *b"PK\x06\x06";
/// The fixed part of a Zip64 end record.
const ZIP64_FIXED_BYTES: usize = 56;
const ZIP64_RECORD_BYTES: u64 = ZIP64_FIXED_BYTES as u64;
/// The fixed part of a central-directory record.
const CENTRAL_RECORD_BYTES: u64 = 46;
/// The bytes before a record where another record can hold it in its comment:
/// the most bytes of an end record, and the locator and the Zip64 record before
/// that record.
const COVER_BYTES: u64 =
    ZIP64_RECORD_BYTES + LOCATOR_BYTES as u64 + END_RECORD_BYTES as u64 + u16::MAX as u64;

/// The search limit of rawzip (`END_OF_CENTRAL_DIR_MAX_OFFSET`).
///
/// No signature before the last 1 MiB is a candidate. A test checks this value
/// with rawzip.
pub const SEARCH_BYTES: u64 = 1 << 20;
/// The bytes of the first read.
///
/// rawzip finds the record in its first read when the signature is in the last
/// 1 KiB. This read holds these bytes and all bytes where another record can
/// hold that signature in its comment. Thus a usual archive makes one read at
/// the end of the file, as with rawzip alone.
pub const FIRST_READ_BYTES: u64 = 1024 + COVER_BYTES;
/// The most calls of rawzip to try a record for one open.
///
/// Each one counts as [`READS_PER_TRIAL`] reads of a budget. A look at a record
/// for the notes spends one read of that budget for each read that it makes. With
/// too little left for a trial, the open fails if no record was chosen. With no
/// read left for the notes, they count the record as not checked.
pub const MAX_TRIALS: u32 = 16;
/// The most reads of one call of rawzip: a Zip64 record, the declared place of
/// the directory, and its place by the size.
const READS_PER_TRIAL: u32 = 3;
/// The most end records before the chosen record that one open keeps, nearest the
/// chosen record first.
const MAX_EARLIER: usize = 16;
/// The most reads of one open.
///
/// That is at most 3 reads of the end of the file, the budget, and one more call
/// of rawzip when no record has a central directory. A test reaches this value.
pub const MAX_OPEN_READS: u64 = 3 + (READS_PER_TRIAL * MAX_TRIALS) as u64 + 3;
/// The buffer of a call of rawzip. A false locator makes one read of this size.
const TRIAL_BUFFER_BYTES: usize = 4096;
/// The most bytes that one open asks from its reader.
///
/// That is the end of the file, and the reads of the calls of rawzip. A reader that
/// keeps a window reads more from the file for a far place: each read outside the
/// window fills the window. The number of reads has a limit, so this cost is
/// bounded also for a hostile file.
pub const MAX_OPEN_BYTES: u64 = SEARCH_BYTES
    + COVER_BYTES
    + (MAX_TRIALS as u64 + 1) * (TRIAL_BUFFER_BYTES as u64 + 2 * CENTRAL_RECORD_BYTES);

/// The error when too many records are false. It is shown after "Cannot open:"
/// and in a sentence, so it has no last period.
pub const TOO_MANY_TEXT: &str = "The end of this file has too many marks that look like a zip end \
                                 record. Zipscope stopped at its limit of reads";
/// The error when the file has signatures, but no record can be used.
pub const NO_RECORD_TEXT: &str = "The end of this file looks like a zip end record, but the \
                                  record cannot be used. The file can be cut off or damaged, or \
                                  it is not a zip archive";

fn le16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn le32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn le64(bytes: &[u8], at: usize) -> u64 {
    let mut word = [0u8; 8];
    word.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(word)
}

/// A comment that the end of the file cut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CutComment {
    /// The length that the end record declares.
    pub declared: u16,
    /// The bytes of the comment that are in the file.
    pub present: u16,
}

/// What the walk saw. The findings of the health panel come from these values.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EndNotes {
    /// The comment of the chosen record, when the end of the file cut it.
    pub cut_comment: Option<CutComment>,
    /// The end signatures after the chosen record with no other directory at a
    /// place that they give.
    pub skipped: u32,
    /// The other records with a directory at a place that they give: a record
    /// after the chosen record, a record before it that holds it in its comment, or
    /// a record before a chosen record with no entries. A directory that is the
    /// chosen directory does not count.
    pub other_records: u32,
    /// The other records of that shape that were not checked, because the budget
    /// of reads was used up.
    pub unchecked: u32,
    /// True when the chosen record also gives a place with another directory.
    pub second_directory: bool,
    /// The directory offset that the chosen record declares, when this offset is
    /// after the central directory that the open found.
    pub declared_after_directory: Option<u64>,
}

/// An opened archive: the chosen record, and what the walk saw.
#[derive(Debug)]
pub struct OpenedEnd<R> {
    pub archive: ZipArchive<EndReader<R>>,
    pub notes: EndNotes,
    /// True when the bytes before the chosen record have the signature of a
    /// Zip64 locator. Then the writer knew Zip64, also when rawzip does not use
    /// the locator. The open has these bytes in memory, so this costs no read.
    pub locator: bool,
    /// True when a disk field of the chosen record is not 0: the file is one
    /// part of a spanned archive. The offset of a row then gives a place in the
    /// part of that row, not a place in this file.
    pub other_disk: bool,
    /// The end records before the chosen record with a directory, nearest first:
    /// the place of the record and the place of its directory.
    pub earlier: Vec<(u64, u64)>,
}

/// The fields of an end record.
#[derive(Debug, Clone, Copy)]
struct Record {
    offset: u64,
    disk: u16,
    directory_disk: u16,
    entries: u16,
    directory_size: u32,
    directory_offset: u32,
    comment_length: u16,
}

impl Record {
    fn parse(offset: u64, bytes: &[u8]) -> Record {
        Record {
            offset,
            disk: le16(bytes, 4),
            directory_disk: le16(bytes, 6),
            entries: le16(bytes, 10),
            directory_size: le32(bytes, 12),
            directory_offset: le32(bytes, 16),
            comment_length: le16(bytes, 20),
        }
    }

    /// The offset after the comment that the record declares. It can be past
    /// the end of the file.
    fn comment_end(&self) -> u64 {
        self.offset + END_RECORD_BYTES as u64 + u64::from(self.comment_length)
    }

    /// True when the record says that the archive has no entries, and the
    /// directory is the place of the record: rawzip then reads no records.
    fn is_empty_at_its_place(&self) -> bool {
        self.entries == 0
            && self.directory_size == 0
            && u64::from(self.directory_offset) == self.offset
    }

    /// True when a disk field is not 0. The offsets are then places in other parts
    /// of a spanned archive, not places in this file.
    fn other_disk(&self) -> bool {
        self.disk != 0 || self.directory_disk != 0
    }
}

/// How good the central directory of a record is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sound {
    False,
    Weak,
    Strong,
}

/// What a look at the places of a record found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirectoryLook {
    /// No other directory is at the places of the record.
    Nothing,
    /// Another directory is at this place.
    Other(u64),
    /// The budget of reads ended before the last place.
    Unchecked,
}

/// What a look for a Zip64 record found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Zip64Look {
    /// It takes a read, and the budget has none.
    NoRead,
    /// The place has no Zip64 signature.
    Nothing,
    /// A Zip64 record with this directory size and offset.
    Found { size: u64, offset: u64 },
}

/// The first bytes of a read.
#[derive(Debug, Clone, Copy)]
struct Seen {
    offset: u64,
    head: [u8; 4],
}

/// The reader of an opened archive.
///
/// While the archive opens, it keeps the end of the file in memory. After the
/// open, it only gives each read to the reader of the file, so the reads of the
/// entries do not change.
#[derive(Debug)]
pub struct EndReader<R> {
    inner: R,
    size: u64,
    opening: bool,
    /// The bytes of the file from `tail_start` to its end.
    tail: Vec<u8>,
    tail_start: u64,
    /// True after the first read for bytes before the first read. The next one
    /// reads all bytes that the walk can need, so a file with many signatures
    /// does not read again for each of them.
    extended: bool,
    /// The last byte of a cut comment. rawzip reads this one byte to see that
    /// the comment is in the file.
    cut_comment_end: Option<u64>,
    /// The start of the last reads that went to the file. A call of rawzip has
    /// at most 3 reads there.
    seen: Cell<[Seen; 3]>,
    next_seen: Cell<usize>,
}

impl<R> EndReader<R> {
    /// The reader of the file.
    #[must_use]
    pub fn inner(&self) -> &R {
        &self.inner
    }
}

impl<R: ReaderAt> ReaderAt for EndReader<R> {
    #[inline]
    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
        if self.opening {
            self.read_while_opening(buf, offset)
        } else {
            self.inner.read_at(buf, offset)
        }
    }
}

impl<R: ReaderAt> EndReader<R> {
    fn new(inner: R, size: u64) -> Self {
        EndReader {
            inner,
            size,
            opening: true,
            tail: Vec::new(),
            tail_start: size,
            extended: false,
            cut_comment_end: None,
            seen: Cell::new(
                [Seen {
                    offset: u64::MAX,
                    head: [0; 4],
                }; 3],
            ),
            next_seen: Cell::new(0),
        }
    }

    fn read_while_opening(&self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
        if self.cut_comment_end == Some(offset) {
            // This byte is past the end of the file. Only this read of rawzip
            // gets it, and only during the call for a cut record.
            let Some(byte) = buf.first_mut() else {
                return Ok(0);
            };
            *byte = 0;
            return Ok(1);
        }
        if offset >= self.size {
            return Ok(0);
        }
        if let Some(bytes) = self.tail_bytes(offset) {
            let count = buf.len().min(bytes.len());
            buf[..count].copy_from_slice(&bytes[..count]);
            return Ok(count);
        }
        let count = self.inner.read_at(buf, offset)?;
        if let Some(head) = buf[..count].first_chunk::<4>() {
            self.remember(offset, *head);
        }
        Ok(count)
    }

    fn remember(&self, offset: u64, head: [u8; 4]) {
        let mut seen = self.seen.get();
        let next = self.next_seen.get();
        seen[next] = Seen { offset, head };
        self.seen.set(seen);
        self.next_seen.set((next + 1) % seen.len());
    }

    /// The bytes of the kept end of the file from `offset`, if it holds them.
    fn tail_bytes(&self, offset: u64) -> Option<&[u8]> {
        let skip = usize::try_from(offset.checked_sub(self.tail_start)?).ok()?;
        self.tail.get(skip..)
    }

    /// Makes sure that the kept end of the file starts at `start` or before
    /// it. Makes one read when it does not.
    fn keep_from(&mut self, start: u64) -> Result<(), Error> {
        if start >= self.tail_start {
            return Ok(());
        }
        // The search window and the first read limit this value.
        let added = usize::try_from(self.tail_start - start)
            .map_err(|err| plain_error(&err.to_string()))?;
        let mut tail = Vec::new();
        tail.try_reserve_exact(added + self.tail.len())
            .map_err(|err| plain_error(&err.to_string()))?;
        tail.resize(added, 0);
        self.inner.read_exact_at(&mut tail, start)?;
        tail.extend_from_slice(&self.tail);
        self.tail = tail;
        self.tail_start = start;
        Ok(())
    }

    /// Makes sure that the kept bytes hold each record that can hold the record
    /// at `offset` in its comment. With `signature_before`, this function makes at
    /// most 2 reads for one open.
    fn keep_cover(&mut self, offset: u64, floor: u64) -> Result<(), Error> {
        let start = offset.saturating_sub(COVER_BYTES);
        if start >= self.tail_start {
            return Ok(());
        }
        if self.extended {
            self.keep_from(floor.saturating_sub(COVER_BYTES))
        } else {
            self.extended = true;
            self.keep_from(start)
        }
    }

    /// The nearest signature before `before`, at or after `floor`. Reads more
    /// of the file, one time, when the kept bytes end after `floor`.
    fn signature_before(&mut self, before: u64, floor: u64) -> Result<Option<u64>, Error> {
        if let Some(found) = self.kept_signature_before(before, floor) {
            return Ok(Some(found));
        }
        if self.tail_start <= floor {
            return Ok(None);
        }
        // Also the bytes before the window, so that a record near its start makes
        // no more reads.
        self.extended = true;
        self.keep_from(floor.saturating_sub(COVER_BYTES))?;
        Ok(self.kept_signature_before(before, floor))
    }

    fn kept_signature_before(&self, before: u64, floor: u64) -> Option<u64> {
        let end = usize::try_from(before.saturating_sub(self.tail_start)).ok()?;
        let start = usize::try_from(floor.saturating_sub(self.tail_start)).ok()?;
        let bytes = self.tail.get(start..end)?;
        let found = bytes.windows(4).rposition(|word| word == END_SIGNATURE)?;
        Some(self.tail_start + (start + found) as u64)
    }

    /// The offset for rawzip that makes it stop at the signature at `offset`:
    /// its search starts before the next signature, or at the end of the file.
    fn search_end(&self, offset: u64) -> u64 {
        let after = offset + END_SIGNATURE.len() as u64;
        self.tail_bytes(after)
            .and_then(|bytes| bytes.windows(4).position(|word| word == END_SIGNATURE))
            .map_or(self.size, |found| after + found as u64 + 3)
    }

    /// The record at a signature, when the file holds its fixed part.
    fn record(&self, offset: u64) -> Option<Record> {
        let bytes = self.tail_bytes(offset)?;
        (bytes.len() >= END_RECORD_BYTES).then(|| Record::parse(offset, bytes))
    }

    /// True when bytes that look like a Zip64 locator are before the record.
    /// rawzip then can read a Zip64 record.
    fn has_locator(&self, record: &Record) -> bool {
        record
            .offset
            .checked_sub(LOCATOR_BYTES as u64)
            .and_then(|start| self.tail_bytes(start))
            .is_some_and(|bytes| bytes.starts_with(&LOCATOR_SIGNATURE))
    }

    /// True when the bytes in memory show that no central directory is at the
    /// declared size before the record, with no read. With a locator, the place
    /// can come from a Zip64 record, so this function does not say.
    fn no_directory_by_size(&self, record: &Record) -> bool {
        if self.has_locator(record) {
            return false;
        }
        let size = u64::from(record.directory_size);
        if size > record.offset {
            return true;
        }
        self.known_head(record.offset - size)
            .is_some_and(|head| head != CENTRAL_SIGNATURE)
    }

    /// True when the bytes in memory show that the record has no central
    /// directory that rawzip can read, with no read. A record of this kind costs
    /// no trial.
    ///
    /// With no locator, rawzip reads the directory at the declared offset, or
    /// else at the declared size before the record.
    fn is_plainly_false(&self, record: &Record) -> bool {
        if self.has_locator(record) || record.is_empty_at_its_place() {
            return false;
        }
        let declared = u64::from(record.directory_offset);
        if declared > record.offset {
            return true;
        }
        let size = u64::from(record.directory_size);
        let no_record_by_size = size < CENTRAL_RECORD_BYTES || self.no_directory_by_size(record);
        let no_record_at_offset = declared + CENTRAL_RECORD_BYTES > record.offset
            || self
                .known_head(declared)
                .is_some_and(|head| head != CENTRAL_SIGNATURE);
        no_record_by_size && no_record_at_offset
    }

    /// The first 4 bytes at `offset`, when they are in memory.
    fn known_head(&self, offset: u64) -> Option<[u8; 4]> {
        if let Some(bytes) = self.tail_bytes(offset) {
            return bytes.first_chunk::<4>().copied();
        }
        self.seen
            .get()
            .iter()
            .find(|seen| seen.offset == offset)
            .map(|seen| seen.head)
    }

    /// The first 4 bytes at `offset`: from memory, or else from a new read.
    fn head_at(&self, offset: u64) -> Result<Option<[u8; 4]>, Error> {
        if let Some(head) = self.known_head(offset) {
            return Ok(Some(head));
        }
        if self.tail_bytes(offset).is_some() {
            return Ok(None);
        }
        let mut head = [0u8; 4];
        self.inner.read_exact_at(&mut head, offset)?;
        self.remember(offset, head);
        Ok(Some(head))
    }

    /// True when a central-directory signature is at `place`, a place before an end
    /// record. Returns `None` when it takes a read and the budget has none.
    fn central_at(&self, place: u64, reads: &mut u32) -> Result<Option<bool>, Error> {
        if self.known_head(place).is_none() {
            let Some(left) = reads.checked_sub(1) else {
                return Ok(None);
            };
            *reads = left;
        }
        Ok(Some(self.head_at(place)? == Some(CENTRAL_SIGNATURE)))
    }

    /// Looks for a Zip64 record at `place`, a place where its fixed part fits before
    /// a locator.
    fn zip64_at(&self, place: u64, reads: &mut u32) -> Result<Zip64Look, Error> {
        let mut read = [0u8; ZIP64_FIXED_BYTES];
        let kept = self
            .tail_bytes(place)
            .filter(|bytes| bytes.len() >= read.len());
        let bytes = if let Some(bytes) = kept {
            bytes
        } else {
            let Some(left) = reads.checked_sub(1) else {
                return Ok(Zip64Look::NoRead);
            };
            *reads = left;
            self.inner.read_exact_at(&mut read, place)?;
            &read
        };
        Ok(if bytes.starts_with(&ZIP64_SIGNATURE) {
            Zip64Look::Found {
                size: le64(bytes, 40),
                offset: le64(bytes, 48),
            }
        } else {
            Zip64Look::Nothing
        })
    }

    /// Looks at each place that a record gives for its directory, and finds out if
    /// a directory other than `chosen` is there.
    ///
    /// The places are the declared offset and the declared size before the record.
    /// With a locator, they are also the offset and the size before a Zip64 record.
    /// The format puts that record at the offset in the locator, and directly before
    /// the locator. With no extensible data, that is the fixed place before the
    /// locator. These two places can differ, so this function looks at both.
    ///
    /// When a Zip64 place is `chosen`, the classic fields only repeat that record,
    /// and they can point into the directory, so they do not count.
    fn other_directory(
        &self,
        record: &Record,
        chosen: u64,
        reads: &mut u32,
    ) -> Result<DirectoryLook, Error> {
        let mut unchecked = false;
        let mut zip64 = [None; 2];
        if self.has_locator(record) {
            let locator = record.offset - LOCATOR_BYTES as u64;
            let fixed = locator.checked_sub(ZIP64_RECORD_BYTES);
            let in_locator = self
                .tail_bytes(locator)
                .map_or(u64::MAX, |bytes| le64(bytes, 8));
            // A record at the offset in the locator must fit before the locator.
            let far = fixed
                .filter(|fixed| in_locator <= *fixed)
                .map(|_| in_locator);
            for (found, place) in zip64.iter_mut().zip([fixed, far]) {
                let Some(place) = place else {
                    continue;
                };
                match self.zip64_at(place, reads)? {
                    Zip64Look::NoRead => unchecked = true,
                    Zip64Look::Nothing => {}
                    Zip64Look::Found { size, offset } => {
                        *found = Some((place.checked_sub(size), offset));
                    }
                }
            }
        }
        let by_size = record.offset.checked_sub(u64::from(record.directory_size));
        let zip64_places = |(by_size, offset): (Option<u64>, u64)| [by_size, Some(offset)];
        let mut places = zip64.into_iter().flatten().flat_map(zip64_places).flatten();
        let classic = if places.any(|place| place == chosen) {
            [None, None]
        } else {
            [by_size, Some(u64::from(record.directory_offset))]
        };
        let places = zip64.into_iter().flatten().flat_map(zip64_places).flatten();
        for place in places.chain(classic.into_iter().flatten()) {
            if place == chosen || place >= record.offset {
                continue;
            }
            match self.central_at(place, reads)? {
                None => unchecked = true,
                Some(false) => {}
                Some(true) => return Ok(DirectoryLook::Other(place)),
            }
        }
        Ok(if unchecked {
            DirectoryLook::Unchecked
        } else {
            DirectoryLook::Nothing
        })
    }

    /// True when the directory of a record ends at the record, with nothing that
    /// can take its place. rawzip makes the choice when the walk gets to the record.
    fn is_strong(&self, record: &Record, reads: &mut u32) -> Result<bool, Error> {
        if self.has_locator(record) {
            let Some(place) =
                (record.offset - LOCATOR_BYTES as u64).checked_sub(ZIP64_RECORD_BYTES)
            else {
                return Ok(false);
            };
            let Zip64Look::Found { size, offset } = self.zip64_at(place, reads)? else {
                return Ok(false);
            };
            return Ok(offset.checked_add(size) == Some(place)
                && self.central_at(offset, reads)? == Some(true));
        }
        let size = u64::from(record.directory_size);
        let Some(place) = record.offset.checked_sub(size) else {
            return Ok(false);
        };
        let declared = u64::from(record.directory_offset);
        Ok(size >= CENTRAL_RECORD_BYTES
            && self.central_at(place, reads)? == Some(true)
            && (declared == place
                || declared >= record.offset
                || self.central_at(declared, reads)? == Some(false)))
    }

    /// Finds out how good the central directory of a record is, at the place
    /// `directory` that rawzip chose.
    ///
    /// - A whole central-directory record with its signature must be at that
    ///   place, before the end record. Else the record is false.
    /// - With no locator, the directory must end at the end record, as its
    ///   declared size says, for the record to be strong. Else it is weak.
    /// - An empty archive has no directory to check. Its directory offset is
    ///   the place of its record, or of its Zip64 record.
    ///
    /// The check reads only the first record. A hostile file can make a first
    /// record that is true and let the parse fail after it. The parse reports
    /// that error, and [`EndNotes::other_records`] tells of the other record.
    fn soundness(&self, record: &Record, directory: u64, entries: u64) -> Result<Sound, Error> {
        let locator = self.has_locator(record);
        let sound = if !locator && record.is_empty_at_its_place() {
            if directory == record.offset {
                Sound::Strong
            } else {
                Sound::False
            }
        } else if entries == 0 && locator && directory < record.offset {
            if self.head_at(directory)? == Some(ZIP64_SIGNATURE) {
                Sound::Strong
            } else {
                Sound::False
            }
        } else if directory.saturating_add(CENTRAL_RECORD_BYTES) > record.offset
            || self.head_at(directory)? != Some(CENTRAL_SIGNATURE)
        {
            Sound::False
        } else if locator || directory + u64::from(record.directory_size) == record.offset {
            Sound::Strong
        } else {
            Sound::Weak
        };
        Ok(sound)
    }

    /// Ends the open. Each read after this goes to the reader of the file.
    fn finish(&mut self) {
        self.opening = false;
        self.cut_comment_end = None;
        self.tail = Vec::new();
    }
}

/// Finds out if a failure of rawzip belongs to the record or to the reader. A
/// record can fail for its own values. A read error ends the open.
fn only_record_failed(err: Error) -> Result<(), Error> {
    match err.kind() {
        ErrorKind::IO(_) => Err(err),
        _ => Ok(()),
    }
}

/// One call of rawzip that stops at the signature of the record. The kept bytes
/// reach far before the signature, so rawzip reads no other bytes for its search.
fn locate<T: ReaderAt>(reader: T, end: u64) -> Result<ZipArchive<T>, (T, Error)> {
    let mut buffer = [0u8; TRIAL_BUFFER_BYTES];
    ZipLocator::new().locate_in_reader(reader, &mut buffer, end)
}

/// The end of a trial. A false record gives the reader back.
enum Trial<R> {
    Sound(ZipArchive<EndReader<R>>, Sound),
    False(EndReader<R>),
}

/// One trial of a record.
fn try_record<R: ReaderAt>(mut source: EndReader<R>, record: &Record) -> Result<Trial<R>, Error> {
    source.cut_comment_end = (record.comment_end() > source.size).then(|| record.comment_end() - 1);
    let end = source.search_end(record.offset);
    match locate(source, end) {
        Ok(mut archive) => {
            archive.get_mut().cut_comment_end = None;
            let sound = archive.get_ref().soundness(
                record,
                archive.directory_offset(),
                archive.entries_hint(),
            )?;
            Ok(if sound == Sound::False {
                Trial::False(archive.into_inner())
            } else {
                Trial::Sound(archive, sound)
            })
        }
        Err((mut source, err)) => {
            source.cut_comment_end = None;
            only_record_failed(err)?;
            Ok(Trial::False(source))
        }
    }
}

/// What the walk keeps from one pass to the next.
struct Walk {
    floor: u64,
    /// The budget of reads.
    reads: u32,
    /// True when the file has a signature in the search window.
    any_signature: bool,
    /// The nearest record whose comment fits, also when it is false.
    nearest_fit: Option<Record>,
}

/// The end of one pass over the signatures.
enum Pass<R> {
    Chosen(ZipArchive<EndReader<R>>, Record),
    NoRecord(EndReader<R>),
}

/// One pass over the signatures, nearest the end first. It tries the records
/// whose comment fits, or the cut records. It stops at the first sound one.
fn pass<R: ReaderAt>(
    mut source: EndReader<R>,
    walk: &mut Walk,
    cut: bool,
) -> Result<Pass<R>, Error> {
    let size = source.size;
    let mut before = size;
    while let Some(offset) = source.signature_before(before, walk.floor)? {
        before = offset;
        walk.any_signature = true;
        source.keep_cover(offset, walk.floor)?;
        let Some(record) = source.record(offset) else {
            continue;
        };
        if (record.comment_end() > size) != cut {
            continue;
        }
        if !source.is_plainly_false(&record) {
            let Some(left) = walk.reads.checked_sub(READS_PER_TRIAL) else {
                return Err(plain_error(TOO_MANY_TEXT));
            };
            walk.reads = left;
            source = match try_record(source, &record)? {
                Trial::False(back) => back,
                Trial::Sound(archive, sound) => {
                    if sound == Sound::Weak
                        && !cut
                        && has_strong_holder(archive.get_ref(), &record, &mut walk.reads)?
                    {
                        archive.into_inner()
                    } else {
                        return Ok(Pass::Chosen(archive, record));
                    }
                }
            };
        }
        if !cut {
            walk.nearest_fit.get_or_insert(record);
        }
    }
    Ok(Pass::NoRecord(source))
}

fn plain_error(text: &str) -> Error {
    Error::from(ErrorKind::IO(io::Error::other(text)))
}

/// True when the comment of `record`, a record before `chosen`, reaches past the
/// start of `chosen`.
fn holds(record: &Record, chosen: &Record) -> bool {
    record.comment_end() > chosen.offset
}

/// True when a strong record holds the weak record in its comment. A cut record
/// can be that record. With no read left, the weak record stays the choice.
fn has_strong_holder<R: ReaderAt>(
    source: &EndReader<R>,
    weak: &Record,
    reads: &mut u32,
) -> Result<bool, Error> {
    let floor = weak.offset.saturating_sub(COVER_BYTES);
    let mut before = weak.offset;
    while let Some(offset) = source.kept_signature_before(before, floor) {
        before = offset;
        if let Some(record) = source.record(offset)
            && holds(&record, weak)
            && source.is_strong(&record, reads)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Finds what the walk saw for the chosen record. It uses the bytes in memory, and
/// reads only for a record that can have another directory.
fn notes_of<R: ReaderAt>(
    source: &EndReader<R>,
    chosen: &Record,
    directory: u64,
    reads: &mut u32,
) -> Result<(EndNotes, Vec<(u64, u64)>), Error> {
    let size = source.size;
    let mut notes = EndNotes::default();
    let mut earlier = Vec::new();
    let comment_start = chosen.offset + END_RECORD_BYTES as u64;
    if chosen.comment_end() > size {
        notes.cut_comment = Some(CutComment {
            declared: chosen.comment_length,
            present: u16::try_from(size - comment_start).unwrap_or(u16::MAX),
        });
    }
    match source.other_directory(chosen, directory, reads)? {
        DirectoryLook::Nothing => {}
        DirectoryLook::Other(_) => notes.second_directory = true,
        DirectoryLook::Unchecked => notes.unchecked += 1,
    }
    let mut before = size;
    while let Some(offset) = source.kept_signature_before(before, chosen.offset + 1) {
        before = offset;
        let look = match source.record(offset) {
            Some(record) => source.other_directory(&record, directory, reads)?,
            None => DirectoryLook::Nothing,
        };
        match look {
            DirectoryLook::Nothing => notes.skipped += 1,
            DirectoryLook::Other(_) => notes.other_records += 1,
            DirectoryLook::Unchecked => notes.unchecked += 1,
        }
    }
    let mut before = chosen.offset;
    let floor = chosen.offset.saturating_sub(COVER_BYTES);
    while let Some(offset) = source.kept_signature_before(before, floor) {
        before = offset;
        // An empty listing covers no bytes, so a record before an empty record
        // counts also when its comment ends before the empty record.
        let Some(record) = source.record(offset) else {
            continue;
        };
        if holds(&record, chosen) || chosen.is_empty_at_its_place() {
            match source.other_directory(&record, directory, reads)? {
                DirectoryLook::Nothing => {}
                DirectoryLook::Other(_) => notes.other_records += 1,
                DirectoryLook::Unchecked => notes.unchecked += 1,
            }
        } else if earlier.len() < MAX_EARLIER
            && !chosen.other_disk()
            && let DirectoryLook::Other(place) =
                source.other_directory(&record, directory, reads)?
        {
            earlier.push((offset, place));
        }
    }
    let declared = u64::from(chosen.directory_offset);
    if declared > directory
        && chosen.directory_offset != u32::MAX
        && !chosen.other_disk()
        && !notes.second_directory
    {
        notes.declared_after_directory = Some(declared);
    }
    Ok((notes, earlier))
}

/// Finds the end record of an archive of `size` bytes, by the rule of this
/// module.
///
/// # Errors
///
/// Returns an error when a read fails, when the file has no end signature in
/// its last 1 MiB, when no record can be used, or when [`MAX_TRIALS`] is used
/// up before a record is chosen.
pub fn open_end<R: ReaderAt>(reader: R, size: u64) -> Result<OpenedEnd<R>, Error> {
    let mut source = EndReader::new(reader, size);
    source.keep_from(size.saturating_sub(FIRST_READ_BYTES))?;
    let mut walk = Walk {
        floor: size.saturating_sub(SEARCH_BYTES),
        reads: READS_PER_TRIAL * MAX_TRIALS,
        any_signature: false,
        nearest_fit: None,
    };
    let source = match pass(source, &mut walk, false)? {
        Pass::Chosen(archive, record) => return finish_open(archive, &record, walk.reads),
        Pass::NoRecord(source) => source,
    };
    let source = match pass(source, &mut walk, true)? {
        Pass::Chosen(archive, record) => return finish_open(archive, &record, walk.reads),
        Pass::NoRecord(source) => source,
    };
    if !walk.any_signature {
        return Err(Error::from(ErrorKind::MissingEndOfCentralDirectory));
    }
    let Some(record) = walk.nearest_fit else {
        return Err(plain_error(NO_RECORD_TEXT));
    };
    // No record has a central directory. rawzip opens the nearest one that fits,
    // and the parse reports the error of its directory. When rawzip refuses it
    // after a locator, the words of rawzip stay: that file can be a true Zip64
    // archive with data before it (R1 in the rawzip notes).
    let locator = source.has_locator(&record);
    let end = source.search_end(record.offset);
    match locate(source, end) {
        Ok(archive) => finish_open(archive, &record, walk.reads),
        Err((_, err)) if locator => Err(err),
        Err((_, err)) => {
            only_record_failed(err)?;
            Err(plain_error(NO_RECORD_TEXT))
        }
    }
}

/// Makes the notes for the chosen record, and ends the open.
fn finish_open<R: ReaderAt>(
    mut archive: ZipArchive<EndReader<R>>,
    record: &Record,
    mut reads: u32,
) -> Result<OpenedEnd<R>, Error> {
    let directory = archive.directory_offset();
    let (notes, earlier) = notes_of(archive.get_ref(), record, directory, &mut reads)?;
    let locator = archive.get_ref().has_locator(record);
    archive.get_mut().finish();
    Ok(OpenedEnd {
        archive,
        notes,
        locator,
        other_disk: record.other_disk(),
        earlier,
    })
}
