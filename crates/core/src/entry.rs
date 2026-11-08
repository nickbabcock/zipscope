//! Decodes the extra fields of a central-directory record: timestamps, the
//! AES field and the Info-ZIP Unicode fields. All values are untrusted.

use rawzip::extra_fields::{ExtraFieldId, ExtraFields};
use rawzip::time::DosDateTime;

use crate::contract::{TimeKind, encryption};

/// The compression method for AES encryption.
pub const METHOD_AES: u16 = 99;

/// General-purpose flag: the entry is encrypted.
const FLAG_ENCRYPTED: u16 = 1 << 0;
/// General-purpose flag: strong encryption.
const FLAG_STRONG_ENCRYPTION: u16 = 1 << 6;

/// Seconds from 1601-01-01 (the NTFS epoch) to 1970-01-01.
const NTFS_EPOCH_SECONDS: i64 = 11_644_473_600;

/// The extra fields that the store uses, from one pass over the field data.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Extras<'a> {
    /// The first Unicode Path field (`0x7075`).
    pub unicode_path: Option<&'a [u8]>,
    /// The first Unicode Comment field (`0x6375`).
    pub unicode_comment: Option<&'a [u8]>,
    /// The first AES field (`0x9901`).
    pub aes: Option<&'a [u8]>,
    /// The last valid UT, NTFS or Unix timestamp, in ms since 1970-01-01.
    pub time: Option<(f64, TimeKind)>,
}

impl<'a> Extras<'a> {
    /// Reads the extra field data of a record. A truncated field at the end
    /// is ignored.
    #[must_use]
    pub fn scan(data: &'a [u8]) -> Self {
        let mut extras = Extras::default();
        for (id, field) in ExtraFields::new(data) {
            match id {
                ExtraFieldId::INFO_ZIP_UNICODE_PATH => {
                    extras.unicode_path = extras.unicode_path.or(Some(field));
                }
                ExtraFieldId::INFO_ZIP_UNICODE_COMMENT => {
                    extras.unicode_comment = extras.unicode_comment.or(Some(field));
                }
                ExtraFieldId::AES => extras.aes = extras.aes.or(Some(field)),
                // The same order as rawzip's `last_modified`: the last valid
                // timestamp field wins.
                ExtraFieldId::NTFS => {
                    if let Some(ms) = ntfs_time(field) {
                        extras.time = Some((ms, TimeKind::Ntfs));
                    }
                }
                ExtraFieldId::EXTENDED_TIMESTAMP => {
                    if let Some(ms) = extended_time(field) {
                        extras.time = Some((ms, TimeKind::Extended));
                    }
                }
                ExtraFieldId::INFO_ZIP_UNIX_ORIGINAL => {
                    if let Some(ms) = unix_time(field) {
                        extras.time = Some((ms, TimeKind::Unix));
                    }
                }
                _ => {}
            }
        }
        extras
    }

    /// Returns the modified time and its kind. A timestamp field wins over
    /// the DOS time.
    #[must_use]
    pub fn modified(&self, dos: DosDateTime) -> (f64, TimeKind) {
        self.time.unwrap_or_else(|| dos_time(dos))
    }

    /// Returns the `encryption` value and the real compression method from
    /// the AES field (0 if there is none).
    /// The method decides AES, also when the encrypted flag is not set.
    pub fn encryption(&self, method: u16, flags: u16) -> (u8, u16) {
        if method == METHOD_AES {
            return self
                .aes
                .and_then(aes)
                .unwrap_or((encryption::AES_UNKNOWN, 0));
        }
        if flags & FLAG_ENCRYPTED == 0 {
            (encryption::NONE, 0)
        } else if flags & FLAG_STRONG_ENCRYPTION != 0 {
            (encryption::OTHER, 0)
        } else {
            (encryption::ZIP_CRYPTO, 0)
        }
    }
}

fn le_u16(data: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([data[at], data[at + 1]])
}

fn le_u32(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
}

/// The NTFS field (`0x000a`): 4 reserved bytes, then attributes. The same
/// checks as rawzip: attribute 1 comes first and has 24 bytes or more.
#[expect(
    clippy::cast_precision_loss,
    reason = "All u64 tick values become milliseconds below 2^51 and fit in f64."
)]
fn ntfs_time(data: &[u8]) -> Option<f64> {
    if data.len() < 32 || le_u16(data, 4) != 1 {
        return None;
    }
    let size = usize::from(le_u16(data, 6));
    if size < 24 || data.len() < 8 + size {
        return None;
    }
    let ticks = u64::from_le_bytes(data[8..16].try_into().ok()?);
    // 10,000 ticks of 100 ns are 1 ms. The result fits in f64 exactly.
    Some((i64::try_from(ticks / 10_000).ok()? - NTFS_EPOCH_SECONDS * 1000) as f64)
}

/// The extended timestamp field (`0x5455`): flags, then the modified time
/// when bit 0 is set. Like rawzip, the seconds are unsigned.
fn extended_time(data: &[u8]) -> Option<f64> {
    if data.len() < 5 || data[0] & 1 == 0 {
        return None;
    }
    Some(f64::from(le_u32(data, 1)) * 1000.0)
}

/// The old Info-ZIP Unix field (`0x5855`): access time, then modified time.
fn unix_time(data: &[u8]) -> Option<f64> {
    if data.len() < 8 {
        return None;
    }
    Some(f64::from(le_u32(data, 4)) * 1000.0)
}

/// Days from 1970-01-01 to a date of the proleptic Gregorian calendar.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The DOS time, as if it is UTC. A zero date means that the archive has no
/// time. rawzip clamps fields that are out of range (month 0, hour 31).
#[expect(
    clippy::cast_precision_loss,
    reason = "DOS dates span 1980 to 2107; their milliseconds fit in f64 exactly."
)]
fn dos_time(dos: DosDateTime) -> (f64, TimeKind) {
    if dos.packed_date() == 0 {
        return (f64::NAN, TimeKind::None);
    }
    let days = days_from_civil(
        i64::from(dos.year()),
        i64::from(dos.month()),
        i64::from(dos.day()),
    );
    let seconds = days * 86_400
        + i64::from(dos.hour()) * 3600
        + i64::from(dos.minute()) * 60
        + i64::from(dos.second());
    ((seconds * 1000) as f64, TimeKind::Dos)
}

/// The AES field (`0x9901`): vendor version (1 = AE-1, 2 = AE-2), vendor
/// "AE", key strength (1, 2, 3 = 128, 192, 256 bits) and the real method.
fn aes(data: &[u8]) -> Option<(u8, u16)> {
    if data.len() != 7 || &data[2..4] != b"AE" {
        return None;
    }
    let version = match le_u16(data, 0) {
        1 => 0,
        2 => encryption::AE2,
        _ => return None,
    };
    let strength = match data[4] {
        1 => encryption::AES_128,
        2 => encryption::AES_192,
        3 => encryption::AES_256,
        _ => return None,
    };
    Some((strength | version, le_u16(data, 5)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(list: &[(u16, &[u8])]) -> Vec<u8> {
        let mut data = Vec::new();
        for (id, field) in list {
            data.extend_from_slice(&id.to_le_bytes());
            data.extend_from_slice(&(u16::try_from(field.len()).unwrap()).to_le_bytes());
            data.extend_from_slice(field);
        }
        data
    }

    fn ut(seconds: u32) -> Vec<u8> {
        let mut field = vec![1];
        field.extend_from_slice(&seconds.to_le_bytes());
        field
    }

    fn ntfs(ticks: u64) -> Vec<u8> {
        let mut field = vec![0, 0, 0, 0, 1, 0, 24, 0];
        field.extend_from_slice(&ticks.to_le_bytes());
        field.extend_from_slice(&[0; 16]);
        field
    }

    #[test]
    fn days_from_civil_matches_known_dates() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1980, 1, 1), 3652);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(days_from_civil(2026, 10, 28), 20_754);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
    }

    #[test]
    fn last_valid_timestamp_wins() {
        let data = fields(&[(0x5455, &ut(1_000)), (0x000a, &ntfs(0)), (0x5455, &[0; 5])]);
        // The second UT field has no modified time, so NTFS wins.
        let extras = Extras::scan(&data);
        assert_eq!(extras.time, Some((-11_644_473_600_000.0, TimeKind::Ntfs)));
        let data = fields(&[(0x000a, &ntfs(0)), (0x5455, &ut(1_000))]);
        assert_eq!(
            Extras::scan(&data).time,
            Some((1_000_000.0, TimeKind::Extended))
        );
        let unix = [0, 0, 0, 0, 2, 0, 0, 0];
        let data = fields(&[(0x5855, &unix)]);
        assert_eq!(Extras::scan(&data).time, Some((2_000.0, TimeKind::Unix)));
    }

    #[test]
    fn ntfs_time_keeps_milliseconds() {
        let ticks =
            (u64::try_from(NTFS_EPOCH_SECONDS).unwrap() + 1_700_000_000) * 10_000_000 + 1_234_567;
        assert_eq!(ntfs_time(&ntfs(ticks)), Some(1_700_000_000_123.0));
        let mut bad = ntfs(ticks);
        bad[4] = 2;
        assert_eq!(ntfs_time(&bad), None);
        assert_eq!(ntfs_time(&ntfs(ticks)[..31]), None);
    }

    #[test]
    fn ut_seconds_are_unsigned() {
        assert_eq!(
            extended_time(&ut(u32::MAX)),
            Some(f64::from(u32::MAX) * 1000.0)
        );
        assert_eq!(extended_time(&[1, 0, 0]), None);
    }

    #[test]
    fn encryption_kinds() {
        let none = Extras::default();
        assert_eq!(none.encryption(8, 0), (encryption::NONE, 0));
        assert_eq!(none.encryption(8, 1), (encryption::ZIP_CRYPTO, 0));
        assert_eq!(none.encryption(8, 0x41), (encryption::OTHER, 0));
        assert_eq!(none.encryption(99, 1), (encryption::AES_UNKNOWN, 0));

        let ae2_256 = [2, 0, b'A', b'E', 3, 8, 0];
        let data = fields(&[(0x9901, &ae2_256)]);
        assert_eq!(
            Extras::scan(&data).encryption(99, 1),
            (encryption::AES_256 | encryption::AE2, 8)
        );
        let ae1_128 = [1, 0, b'A', b'E', 1, 0, 0];
        let data = fields(&[(0x9901, &ae1_128)]);
        assert_eq!(
            Extras::scan(&data).encryption(99, 1),
            (encryption::AES_128, 0)
        );
        // The AES field applies only to method 99.
        assert_eq!(Extras::scan(&data).encryption(8, 0), (encryption::NONE, 0));

        for bad in [
            &[3, 0, b'A', b'E', 3, 8, 0][..],
            &[2, 0, b'X', b'E', 3, 8, 0],
            &[2, 0, b'A', b'E', 4, 8, 0],
            &[2, 0, b'A', b'E', 3, 8],
            &[2, 0, b'A', b'E', 3, 8, 0, 0],
        ] {
            let data = fields(&[(0x9901, bad)]);
            assert_eq!(
                Extras::scan(&data).encryption(99, 1),
                (encryption::AES_UNKNOWN, 0),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn takes_the_first_unicode_and_aes_fields() {
        let data = fields(&[
            (0x7075, b"first"),
            (0x7075, b"second"),
            (0x6375, b"comment"),
            (0x9901, b"aes"),
            (0x9901, b"other"),
        ]);
        let extras = Extras::scan(&data);
        assert_eq!(extras.unicode_path, Some(&b"first"[..]));
        assert_eq!(extras.unicode_comment, Some(&b"comment"[..]));
        assert_eq!(extras.aes, Some(&b"aes"[..]));
    }
}
