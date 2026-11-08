//! Archives over 4 GiB that were written with no Zip64.
//!
//! The end record and the central-directory records of such an archive keep
//! only the low 32 bits of each offset, so the offsets wrap at 4 GiB. rawzip
//! finds the central directory by its size, and takes the difference to the
//! declared offset as data before the archive. It adds this difference to
//! all rows, so only the rows in the last 4 GiB are at the offset that it
//! gives. A full repair needs each row in rawzip (R2 in the rawzip notes).
//!
//! The difference alone does not tell this shape from data of exactly 4 GiB
//! before an archive. The local headers tell. All values in the archive are
//! untrusted, so a row moves only to a place that holds a local header, or,
//! after the reads, by the order of the rows. The parse decides, and it sets
//! `marks::WRAPPED_OFFSET` on each row that moved. The read worker refuses a
//! row with this mark. Thus a row that reads is at its listed place, and it
//! is in the overlap check.

use rawzip::{ReaderAt, ZipArchive};

/// The offsets of an archive with no Zip64 wrap at this value.
pub const WRAP_BYTES: u64 = 1 << 32;

const LOCAL_SIGNATURE: u32 = 0x0403_4b50;
const LOCATOR_SIGNATURE: u32 = 0x0706_4b50;
const END_SIGNATURE: u32 = 0x0605_4b50;
/// The fixed part of a local header.
const LOCAL_HEADER_BYTES: usize = 30;
/// The fixed part of the end of central directory record.
const END_RECORD_BYTES: usize = 22;
/// The zip64 end of central directory locator.
const LOCATOR_BYTES: usize = 20;
/// The bytes of a name that one read of a local header compares. A longer
/// name also compares its length.
const NAME_BYTES: usize = 256;

fn le16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn le32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Reads as many bytes as the file has at `offset`, up to `buffer.len()`.
/// Returns the count. A read error gives 0 more bytes: the bytes are not
/// known, and the row or the archive then does not get the evidence.
fn read_some<R: ReaderAt>(reader: &R, offset: u64, buffer: &mut [u8]) -> usize {
    let mut filled = 0;
    while filled < buffer.len() {
        let Some(at) = offset.checked_add(filled as u64) else {
            break;
        };
        match reader.read_at(&mut buffer[filled..], at) {
            Ok(0) | Err(_) => break,
            Ok(read) => filled += read,
        }
    }
    filled
}

/// What one read found at a place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Found {
    Nothing,
    /// A local header of another name.
    Signature,
    /// A local header of this name.
    Header,
}

/// An archive of the shape: no Zip64, and the true central directory is a
/// multiple of 4 GiB after its declared offset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Wrap {
    /// What rawzip added to each row.
    difference: u64,
    /// The true offset of the central directory.
    directory: u64,
}

impl Wrap {
    /// Finds the shape at the end of an archive. An archive with its central
    /// directory in the first 4 GiB cannot have the shape, and this function
    /// reads nothing for it. Else it makes one read of 42 bytes.
    #[must_use]
    pub fn detect<R: ReaderAt>(archive: &ZipArchive<R>) -> Option<Wrap> {
        let directory = archive.directory_offset();
        if directory < WRAP_BYTES {
            return None;
        }
        let start = archive.eocd_offset().checked_sub(LOCATOR_BYTES as u64)?;
        let mut tail = [0u8; LOCATOR_BYTES + END_RECORD_BYTES];
        if read_some(archive.get_ref(), start, &mut tail) != tail.len() {
            return None;
        }
        let end = &tail[LOCATOR_BYTES..];
        // A locator means that the writer knew Zip64. The disk fields of a
        // spanned archive give offsets in one part of the archive. The value
        // 0xffffffff is the Zip64 marker, not the low bits of an offset.
        let declared = le32(end, 16);
        if le32(&tail, 0) == LOCATOR_SIGNATURE
            || le32(end, 0) != END_SIGNATURE
            || le16(end, 4) != 0
            || le16(end, 6) != 0
            || declared == u32::MAX
        {
            return None;
        }
        let difference = directory.checked_sub(u64::from(declared))?;
        // The difference is not 0: the true offset is past 32 bits, and the
        // declared offset is not.
        difference.is_multiple_of(WRAP_BYTES).then_some(Wrap {
            difference,
            directory,
        })
    }

    /// Returns the true place of a row when it is not the offset that rawzip
    /// gives, or `None` when the row stays at that offset.
    ///
    /// The order of the tests is the rule that separates this shape from a
    /// true prefix of a multiple of 4 GiB. A local header with the name of
    /// the row at the given offset keeps the row there, also when the prefix
    /// holds a header of the same name at the lower place (two archives put
    /// one after the other). Else the first place that holds a header of the
    /// name wins, from the first place at or after `after`, the end of the
    /// row before it. Else a header of another name decides in the same
    /// order: at the given offset, and then at a lower place. Thus records
    /// that point to one header get one place, and the overlap check sees
    /// them.
    ///
    /// `reads` limits the reads. A row stays when they are used up.
    pub fn place<R: ReaderAt>(
        &self,
        reader: &R,
        given: u64,
        name: &[u8],
        after: u64,
        reads: &mut u32,
    ) -> Option<u64> {
        let stored = given.checked_sub(self.difference)?;
        // A value of 32 bits or more comes only from a Zip64 field.
        if stored >= WRAP_BYTES {
            return None;
        }
        let at_given = self.look(reader, given, name, reads);
        if at_given == Found::Header {
            return None;
        }
        let windows = self.difference / WRAP_BYTES;
        let first = after
            .saturating_sub(stored)
            .div_ceil(WRAP_BYTES)
            .min(windows - 1);
        let mut other = None;
        for window in (first..windows).chain((0..first).rev()) {
            let place = stored + window * WRAP_BYTES;
            match self.look(reader, place, name, reads) {
                Found::Header => return Some(place),
                Found::Signature if other.is_none() => other = Some(place),
                _ => {}
            }
            if *reads == 0 {
                break;
            }
        }
        if at_given == Found::Signature {
            return None;
        }
        other
    }

    /// Returns the place of a row with no read, when the reads of `place` are
    /// used up: the first value of the low 32 bits of the row at or after
    /// `after`, the end of the row before. A writer puts rows in order, so
    /// this is the true place of its rows. `None` when that place is the
    /// given offset or past it. Thus a row at the given offset keeps the
    /// rows after it there, and a true prefix stays. Records at one offset
    /// each go one window up, so at most one of them for each window has no
    /// overlap in the checks.
    #[must_use]
    pub fn follow(&self, given: u64, after: u64) -> Option<u64> {
        let stored = given.checked_sub(self.difference)?;
        if stored >= WRAP_BYTES {
            return None;
        }
        let window = after.saturating_sub(stored).div_ceil(WRAP_BYTES);
        (window < self.difference / WRAP_BYTES).then_some(stored + window * WRAP_BYTES)
    }

    fn look<R: ReaderAt>(&self, reader: &R, at: u64, name: &[u8], reads: &mut u32) -> Found {
        if *reads == 0 || at.saturating_add(LOCAL_HEADER_BYTES as u64) > self.directory {
            return Found::Nothing;
        }
        *reads -= 1;
        let mut head = [0u8; LOCAL_HEADER_BYTES + NAME_BYTES];
        let wanted = LOCAL_HEADER_BYTES + name.len().min(NAME_BYTES);
        let read = read_some(reader, at, &mut head[..wanted]);
        if read < LOCAL_HEADER_BYTES || le32(&head, 0) != LOCAL_SIGNATURE {
            return Found::Nothing;
        }
        let same = usize::from(le16(&head, 26)) == name.len()
            && read == wanted
            && head[LOCAL_HEADER_BYTES..wanted] == name[..wanted - LOCAL_HEADER_BYTES];
        if same {
            Found::Header
        } else {
            Found::Signature
        }
    }
}
