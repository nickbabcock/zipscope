/*
ASSUMED API
None. These tests use the public API and the values in src/contract.rs.
Encryption code 6 is AES with an unknown strength; two AES tests use it.
*/

#[path = "support/zip.rs"]
mod support;

use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use rawzip::ReaderAt;
use support::*;
use zipscope_core::contract::{CHUNK_BITS, CHUNK_BYTES, Column, PAGE_ROWS, encryption};
use zipscope_core::ingest::{Ingest, Status};

#[test]
fn utf8_flag_and_valid_utf8_have_distinct_sources() {
    let mut flagged = Entry::new("café/猫.txt");
    flagged.flags = 0x0800;
    let ingest = parsed(&[flagged.clone(), Entry::new(&flagged.name), Entry::new(b"")]);
    let store = ingest.store();
    for row in 0..2 {
        assert_eq!(store.name(row), flagged.name);
        assert_eq!(
            cell(store, row, Column::NameLength),
            f64::from(u32::try_from(flagged.name.len()).unwrap())
        );
        assert_eq!(
            cell(store, row, Column::NameSource),
            f64::from(u32::try_from(row).unwrap())
        );
    }
    assert_eq!(store.name(2), b"");
    assert_eq!(cell(store, 2, Column::NameSource), 1.0);
}

#[test]
fn cp437_is_not_latin1_or_windows1252() {
    let ingest = parsed(&[Entry::new(b"caf\x82/\x9c\xdb\xe1\xff.txt")]);
    assert_eq!(ingest.store().name(0), "café/£█ß\u{a0}.txt".as_bytes());
    assert_eq!(cell(ingest.store(), 0, Column::NameSource), 3.0);
}

#[test]
fn unicode_path_with_matching_crc_overrides_both_utf8_paths() {
    assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    let mut entries = Vec::new();
    for flags in [0, 0x0800] {
        let mut entry = Entry::new("raw.txt");
        entry.flags = flags;
        entry.extra = unicode_path(1, crc32(&entry.name), "正しい.txt".as_bytes());
        entries.push(entry);
    }
    let mut cp437 = Entry::new(b"caf\x82.txt");
    cp437.extra = unicode_path(1, crc32(&cp437.name), "正しい.txt".as_bytes());
    entries.push(cp437);
    let ingest = parsed(&entries);
    for row in 0..entries.len() {
        assert_eq!(ingest.store().name(row), "正しい.txt".as_bytes());
        assert_eq!(cell(ingest.store(), row, Column::NameSource), 2.0);
    }
}

#[test]
fn invalid_unicode_path_fields_do_not_replace_the_raw_name() {
    let raw = b"caf\x82.txt";
    let mut truncated = unicode_path(1, crc32(raw), b"truncated");
    truncated[2..4].copy_from_slice(&u16::MAX.to_le_bytes());
    let extras = [
        unicode_path(1, crc32(raw) ^ 1, b"wrong-crc"),
        unicode_path(2, crc32(raw), b"wrong-version"),
        unicode_path(1, crc32(raw), b"bad-utf8-\xff"),
        field(0x7075, &[1, 0, 0, 0]),
        field(0x7075, &[]),
        truncated,
    ];
    let entries: Vec<_> = extras
        .into_iter()
        .map(|extra| {
            let mut entry = Entry::new(raw);
            entry.extra = extra;
            entry
        })
        .collect();
    let ingest = parsed(&entries);
    for row in 0..entries.len() {
        assert_eq!(ingest.store().name(row), "café.txt".as_bytes(), "row {row}");
        assert_eq!(cell(ingest.store(), row, Column::NameSource), 3.0);
    }
}

#[test]
fn extra_field_scan_uses_lengths_and_skips_unknown_ids() {
    let mut entry = Entry::new(b"raw");
    let decoy = unicode_path(1, crc32(&entry.name), b"decoy");
    entry.extra = field(0xbeef, &decoy);
    entry.extra.extend(field(0xcafe, &[]));
    entry
        .extra
        .extend(unicode_path(1, crc32(&entry.name), b"actual"));
    let ingest = parsed(&[entry]);
    assert_eq!(ingest.store().name(0), b"actual");
    assert_eq!(cell(ingest.store(), 0, Column::NameSource), 2.0);
}

#[test]
fn invalid_flagged_utf8_is_lossy_and_does_not_fall_back_to_cp437() {
    let mut entry = Entry::new(b"x\xf0\x28\x8c\x28\xff.txt");
    entry.flags = 0x0800;
    let ingest = parsed(&[entry]);
    assert_eq!(ingest.store().name(0), "x�(�(�.txt".as_bytes());
    assert_eq!(cell(ingest.store(), 0, Column::NameSource), 4.0);
}

#[test]
fn names_keep_nul_bidi_markup_and_path_bytes_for_inspection() {
    let name = "../C:\\<img src=x>\0/עברית/\u{202e}txt.exe";
    let ingest = parsed(&[Entry::new(name)]);
    assert_eq!(ingest.store().name(0), name.as_bytes());
    assert_eq!(
        cell(ingest.store(), 0, Column::NameLength),
        f64::from(u32::try_from(name.len()).unwrap())
    );
}

#[test]
fn decoded_names_can_expand_past_u16_and_cross_arena_chunks() {
    let entries = vec![Entry::new(vec![0xdb; 65_535]); 23];
    let mut ingest = open(archive(&entries, 23, None).bytes);
    assert_eq!(ingest.parse(1), 1);
    let pointer = ingest.store().names().chunk(0).as_ptr();
    let first_offset = cell(ingest.store(), 0, Column::NameOffset);
    assert_eq!(ingest.parse(u32::MAX), 22);
    assert_eq!(ingest.status(), &Status::Complete);
    let store = ingest.store();
    let expected = "█".repeat(65_535);
    assert_eq!(store.names().chunk_count(), 2);
    assert_eq!(store.names().chunk(0).as_ptr(), pointer);
    assert_eq!(cell(store, 0, Column::NameOffset), first_offset);
    let mut last_chunk = 0;
    for row in 0..entries.len() {
        let offset = cell_u32(store, row, Column::NameOffset);
        let length = usize::try_from(cell_u32(store, row, Column::NameLength)).unwrap();
        let chunk = offset >> CHUNK_BITS;
        assert!(chunk >= last_chunk);
        assert!((offset as usize & (CHUNK_BYTES - 1)) + length <= CHUNK_BYTES);
        assert_eq!(length, 196_605);
        assert!(
            store.name(row) == expected.as_bytes(),
            "name differs at row {row}"
        );
        last_chunk = chunk;
    }
}

#[test]
fn dos_time_keeps_two_second_precision_and_has_no_time_zone() {
    let mut entry = Entry::new(b"dos");
    entry.date = (0x2c << 9) | (0x02 << 5) | 0x1d;
    entry.time = (0x0c << 11) | (0x22 << 5) | 0x1d;
    let ingest = parsed(&[entry, Entry::new(b"no-time")]);
    assert_eq!(
        cell(ingest.store(), 0, Column::Modified),
        1_709_210_098_000.0
    );
    assert_eq!(cell(ingest.store(), 0, Column::TimeKind), 1.0);
    assert!(cell(ingest.store(), 1, Column::Modified).is_nan());
    assert_eq!(cell(ingest.store(), 1, Column::TimeKind), 0.0);
}

#[test]
fn extended_ut_overrides_dos_and_preserves_epoch_zero() {
    let entries: Vec<_> = [0, 1_700_000_001]
        .into_iter()
        .map(|seconds| {
            let mut entry = Entry::new(b"ut");
            entry.date = (40 << 9) | (1 << 5) | 1;
            entry.extra = ut(seconds);
            entry
        })
        .collect();
    let ingest = parsed(&entries);
    for (row, milliseconds) in [0.0, 1_700_000_001_000.0].into_iter().enumerate() {
        assert_eq!(cell(ingest.store(), row, Column::Modified), milliseconds);
        assert_eq!(cell(ingest.store(), row, Column::TimeKind), 2.0);
    }
}

#[test]
fn ntfs_overrides_dos_and_preserves_milliseconds() {
    let mut entry = Entry::new(b"ntfs");
    entry.date = (40 << 9) | (1 << 5) | 1;
    entry.extra = ntfs(1_700_000_001_234);
    let ingest = parsed(&[entry]);
    assert_eq!(
        cell(ingest.store(), 0, Column::Modified),
        1_700_000_001_234.0
    );
    assert_eq!(cell(ingest.store(), 0, Column::TimeKind), 3.0);
}

#[test]
fn ut_access_time_without_modified_time_does_not_become_modified() {
    let mut entry = Entry::new(b"access-only");
    entry.date = (40 << 9) | (1 << 5) | 1;
    entry.extra = field(0x5455, &[2, 1, 0, 0, 0]);
    let ingest = parsed(&[entry]);
    assert_eq!(
        cell(ingest.store(), 0, Column::Modified),
        1_577_836_800_000.0
    );
    assert_eq!(cell(ingest.store(), 0, Column::TimeKind), 1.0);
}

#[test]
fn short_timestamp_fields_do_not_use_bytes_from_the_next_field() {
    let mut entries = Vec::new();
    for (id, complete) in [
        (0x5455, ut(1_700_000_001)),
        (0x000a, ntfs(1_700_000_001_234)),
    ] {
        for length in 0..complete.len() - 4 {
            let mut entry = Entry::new(b"short-time");
            entry.date = (40 << 9) | (1 << 5) | 1;
            entry.extra = field(id, &complete[4..4 + length]);
            entry.extra.extend(field(0xcafe, &[0xff; 32]));
            entries.push(entry);
        }
    }
    let ingest = parsed(&entries);
    for row in 0..entries.len() {
        assert_eq!(
            cell(ingest.store(), row, Column::Modified),
            1_577_836_800_000.0,
            "row {row}"
        );
        assert_eq!(cell(ingest.store(), row, Column::TimeKind), 1.0);
    }
}

#[test]
fn aes_versions_strengths_and_real_methods_are_per_entry() {
    let mut entries = Vec::new();
    for version in [1, 2] {
        for strength in 1..=3 {
            let mut entry = Entry::new(b"encrypted");
            entry.flags = 1;
            entry.method = 99;
            entry.extra = aes(version, strength, 8);
            entries.push(entry);
        }
    }
    entries.push(Entry::new(b"plain"));
    let mut zipcrypto = Entry::new(b"zipcrypto");
    zipcrypto.flags = 1;
    zipcrypto.method = 8;
    entries.push(zipcrypto);
    let mut strong = Entry::new(b"strong");
    strong.flags = 0x41;
    entries.push(strong);
    let ingest = parsed(&entries);
    for (row, encryption) in [2, 3, 4, 0x82, 0x83, 0x84, 0, 1, 5].into_iter().enumerate() {
        assert_eq!(
            cell(ingest.store(), row, Column::Encryption),
            f64::from(encryption)
        );
        assert_eq!(
            cell(ingest.store(), row, Column::AesMethod),
            if row < 6 { 8.0 } else { 0.0 }
        );
        assert_eq!(
            cell(ingest.store(), row, Column::Method),
            f64::from(entries[row].method)
        );
        assert_eq!(
            cell(ingest.store(), row, Column::Flags),
            f64::from(entries[row].flags)
        );
    }
}

#[test]
fn short_aes_field_cannot_take_bytes_from_the_next_field() {
    let mut entries = Vec::new();
    for length in 0..7 {
        let mut entry = Entry::new(b"short-aes");
        entry.flags = 1;
        entry.method = 99;
        entry.extra = field(0x9901, &aes(2, 3, 8)[4..4 + length]);
        entry.extra.extend(field(0xcafe, &[0xff; 16]));
        entries.push(entry);
    }
    let ingest = parsed(&entries);
    for row in 0..entries.len() {
        assert_eq!(cell(ingest.store(), row, Column::Method), 99.0);
        assert_eq!(cell(ingest.store(), row, Column::AesMethod), 0.0);
        // Code 6 is AES with a missing or bad AES
        // field. It gives no key strength and no AE-2 bit. The blind test
        // accepted 1 or 5, the draft codes without a strength.
        let encryption = cell(ingest.store(), row, Column::Encryption);
        assert_eq!(encryption, f64::from(encryption::AES_UNKNOWN));
    }
}

#[test]
fn invalid_aes_values_do_not_invent_a_key_strength() {
    let mut vendor = aes(2, 3, 8);
    vendor[6..8].copy_from_slice(b"XX");
    let extras = [
        aes(2, 0, 8),
        aes(2, 4, 8),
        aes(2, 255, 8),
        aes(0, 3, 8),
        aes(3, 3, 8),
        vendor,
    ];
    let entries: Vec<_> = extras
        .into_iter()
        .map(|extra| {
            let mut entry = Entry::new(b"invalid-aes");
            entry.flags = 1;
            entry.method = 99;
            entry.extra = extra;
            entry
        })
        .collect();
    let ingest = parsed(&entries);
    for row in 0..entries.len() {
        assert_eq!(cell(ingest.store(), row, Column::Method), 99.0);
        assert_eq!(cell(ingest.store(), row, Column::AesMethod), 0.0);
        // See `short_aes_field_cannot_take_bytes_from_the_next_field`.
        let encryption = cell(ingest.store(), row, Column::Encryption);
        assert_eq!(encryption, f64::from(encryption::AES_UNKNOWN));
    }
}

#[test]
fn central_directory_values_are_copied_without_signed_narrowing() {
    let mut entry = Entry::new(b"claims-only");
    entry.size = 0xfedc_ba98;
    entry.compressed = 0x8000_0001;
    entry.offset = Some(0x8765_4321);
    entry.crc = 0xf123_4567;
    entry.attributes = 0xa1ff_0001;
    entry.made_by = 0x031e;
    entry.flags = 0x0808;
    entry.method = 93;
    let ingest = parsed(&[entry]);
    let store = ingest.store();
    for (column, expected) in [
        (Column::UncompressedSize, f64::from(0xfedc_ba98u32)),
        (Column::CompressedSize, f64::from(0x8000_0001u32)),
        (Column::LocalHeaderOffset, f64::from(0x8765_4321u32)),
        (Column::Crc32, f64::from(0xf123_4567u32)),
        (Column::ExternalAttributes, f64::from(0xa1ff_0001u32)),
        (Column::VersionMadeBy, f64::from(0x031e)),
        (Column::Flags, f64::from(0x0808)),
        (Column::Method, 93.0),
    ] {
        assert_eq!(cell(store, 0, column), expected, "{column:?}");
    }
    assert_eq!(store.page_count(), 1);
    assert_eq!(store.names().chunk_count(), 1);
}

#[test]
fn zip64_sentinels_consume_only_the_fields_that_need_extension() {
    let mut entries = Vec::new();
    for mask in 1..8 {
        let mut entry = Entry::new(b"zip64");
        entry.size = if mask & 1 != 0 { u32::MAX } else { 17 };
        entry.compressed = if mask & 2 != 0 { u32::MAX } else { 9 };
        entry.offset = Some(if mask & 4 != 0 { u32::MAX } else { 0 });
        let mut body = Vec::new();
        for (bit, value) in [
            (1, (1u64 << 40) + 7),
            (2, (1u64 << 33) + 3),
            (4, (1u64 << 32) + 11),
        ] {
            if mask & bit != 0 {
                u64le(&mut body, value);
            }
        }
        entry.extra = field(1, &body);
        entries.push(entry);
    }
    let ingest = parsed(&entries);
    for (row, mask) in (1..8).enumerate() {
        for (column, bit, wide, small) in [
            (Column::UncompressedSize, 1, 2f64.powi(40) + 7.0, 17),
            (Column::CompressedSize, 2, 2f64.powi(33) + 3.0, 9),
            (Column::LocalHeaderOffset, 4, 2f64.powi(32) + 11.0, 0),
        ] {
            assert_eq!(
                cell(ingest.store(), row, column),
                if mask & bit != 0 {
                    wide
                } else {
                    f64::from(small)
                }
            );
        }
    }
}

#[test]
fn false_eocd_counts_do_not_allocate_rows_or_stop_iteration() {
    let entries = [Entry::new(b"one"), Entry::new(b"two"), Entry::new(b"three")];
    for hint in [0, 1, 50_000] {
        let mut ingest = open(archive(&entries, hint, None).bytes);
        assert_eq!(ingest.store().rows(), 0);
        assert_eq!(ingest.store().page_count(), 0);
        assert_eq!(ingest.store().names().chunk_count(), 0);
        assert_eq!(ingest.parse(0), 0);
        assert_eq!(ingest.store().page_count(), 0);
        assert_eq!(ingest.parse(1), 1);
        assert_eq!(ingest.store().page_count(), 1);
        assert_eq!(ingest.parse(u32::MAX), 2);
        assert_eq!(ingest.status(), &Status::Complete);
        assert_eq!(ingest.store().rows(), 3);
        assert_eq!(ingest.store().page_count(), 1);
        for (row, entry) in entries.iter().enumerate() {
            assert_eq!(ingest.store().name(row), entry.name);
        }
    }
}

#[test]
fn enormous_zip64_count_is_only_a_hint_even_for_an_empty_archive() {
    for entries in [vec![], vec![Entry::new(b"one")]] {
        let mut ingest = open(archive(&entries, u16::MAX, Some(1u64 << 63)).bytes);
        assert_eq!(ingest.store().page_count(), 0);
        assert_eq!(ingest.store().names().allocated_bytes(), 0);
        assert_eq!(
            ingest.parse(u32::MAX),
            u32::try_from(entries.len()).unwrap()
        );
        // rawzip can reject a false count. The parsed rows must stay.
        assert!(matches!(
            ingest.status(),
            Status::Complete | Status::Failed(_)
        ));
        assert_eq!(ingest.store().rows(), entries.len());
        assert_eq!(ingest.store().page_count(), entries.len());
        assert_eq!(ingest.store().names().chunk_count(), entries.len());
    }
}

#[test]
fn largest_variable_record_keeps_the_next_record_aligned() {
    let mut entry = Entry::new(vec![b'n'; 65_535]);
    entry.extra = field(0xcafe, &vec![0; 65_531]);
    entry.comment = vec![b'c'; 65_535];
    let ingest = parsed(&[entry.clone(), Entry::new(b"after")]);
    assert_eq!(ingest.store().name(0), entry.name);
    assert_eq!(ingest.store().name(1), b"after");
    assert_eq!(cell(ingest.store(), 0, Column::CommentLength), 65_535.0);
    assert_eq!(cell(ingest.store(), 1, Column::CommentLength), 0.0);
}

#[test]
fn all_columns_cross_a_page_boundary_without_moving_the_first_page() {
    let mut entries = vec![Entry::new(b"x"); PAGE_ROWS + 1];
    for (row, entry) in entries.iter_mut().enumerate() {
        entry.size = u32::try_from(row).unwrap() + 1;
        entry.compressed = u32::try_from(row).unwrap();
        entry.crc = !(u32::try_from(row).unwrap());
        entry.method = if row % 2 == 0 { 0 } else { 8 };
    }
    entries[PAGE_ROWS].name = "last-é".as_bytes().to_vec();
    let mut ingest = open(archive(&entries, 1, None).bytes);
    assert_eq!(ingest.parse(1), 1);
    let pointers: Vec<_> = Column::ALL[..17]
        .iter()
        .map(|column| {
            let pointer = ingest.store().column_ptr(0, *column);
            assert!(!pointer.is_null(), "{column:?}");
            pointer
        })
        .collect();
    assert_eq!(
        ingest.parse(u32::try_from(PAGE_ROWS).unwrap() - 1),
        u32::try_from(PAGE_ROWS).unwrap() - 1
    );
    assert_eq!(ingest.store().page_count(), 1);
    assert_eq!(ingest.parse(1), 1);
    assert_eq!(ingest.store().page_count(), 2);
    assert_eq!(ingest.parse(1), 0);
    assert_eq!(ingest.status(), &Status::Complete);
    for (column, pointer) in Column::ALL[..17].iter().zip(pointers) {
        assert_eq!(ingest.store().column_ptr(0, *column), pointer);
        assert!(!ingest.store().column_ptr(1, *column).is_null());
        assert!(ingest.store().column_ptr(2, *column).is_null());
    }
    for row in [0, 1, PAGE_ROWS - 1, PAGE_ROWS] {
        assert_eq!(
            cell(ingest.store(), row, Column::UncompressedSize),
            f64::from(u32::try_from(row + 1).unwrap())
        );
        assert_eq!(
            cell(ingest.store(), row, Column::CompressedSize),
            f64::from(u32::try_from(row).unwrap())
        );
        assert_eq!(
            cell(ingest.store(), row, Column::Crc32),
            f64::from(!(u32::try_from(row).unwrap()))
        );
        assert_eq!(
            cell(ingest.store(), row, Column::Method),
            if row % 2 == 0 { 0.0 } else { 8.0 }
        );
        assert_eq!(ingest.store().name(row), entries[row].name);
    }
}

#[test]
fn terminal_error_keeps_complete_metadata_and_does_not_append_a_partial_row() {
    let mut entry = Entry::new(b"kept");
    entry.flags = 1;
    entry.method = 99;
    entry.size = 1234;
    entry.extra = aes(2, 3, 8);
    let mut data = archive(
        &[entry, Entry::new(b"broken"), Entry::new(b"unread")],
        3,
        None,
    );
    data.bytes[data.records[1]] = b'X';
    let mut ingest = open(data.bytes);
    assert_eq!(ingest.parse(u32::MAX), 1);
    assert!(matches!(ingest.status(), Status::Failed(_)));
    let status = ingest.status().clone();
    assert_eq!(ingest.store().rows(), 1);
    assert_eq!(ingest.store().name(0), b"kept");
    assert_eq!(cell(ingest.store(), 0, Column::UncompressedSize), 1234.0);
    assert_eq!(cell(ingest.store(), 0, Column::Encryption), f64::from(0x84));
    assert_eq!(ingest.parse(u32::MAX), 0);
    assert_eq!(ingest.status(), &status);
    assert_eq!(ingest.store().rows(), 1);
}

struct SparseReader {
    base: u64,
    tail: Vec<u8>,
    calls: Arc<AtomicUsize>,
}

impl ReaderAt for SparseReader {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
        assert!(buf.len() <= zipscope_core::contract::ENTRIES_BUFFER_BYTES);
        assert!(self.calls.fetch_add(1, Ordering::Relaxed) < 128);
        let length = self.base + self.tail.len() as u64;
        if offset >= length {
            return Ok(0);
        }
        let count = usize::try_from((length - offset).min(buf.len() as u64)).unwrap();
        buf[..count].fill(0);
        let start = offset.max(self.base);
        let end = (offset + count as u64).min(length);
        if start < end {
            let target = usize::try_from(start - offset).unwrap();
            let source = usize::try_from(start - self.base).unwrap();
            let length = usize::try_from(end - start).unwrap();
            buf[target..target + length].copy_from_slice(&self.tail[source..source + length]);
        }
        Ok(count)
    }
}

#[test]
fn a_four_gib_directory_claim_cannot_allocate_or_read_that_many_bytes() {
    let mut data = archive(&[Entry::new(b"one")], 1, None);
    data.bytes[data.eocd + 12..data.eocd + 16].copy_from_slice(&(u32::MAX - 1).to_le_bytes());
    let size = data.bytes.len() as u64;
    let calls = Arc::new(AtomicUsize::new(0));
    let reader = SparseReader {
        base: 0,
        tail: data.bytes,
        calls: Arc::clone(&calls),
    };
    if let Ok(mut ingest) = Ingest::open(reader, size) {
        assert_eq!(ingest.store().page_count(), 0);
        assert_eq!(ingest.store().names().allocated_bytes(), 0);
        assert!(ingest.parse(2) <= 1);
        assert!(matches!(
            ingest.status(),
            Status::Complete | Status::Failed(_)
        ));
        assert!(ingest.store().page_count() <= 1);
        assert!(ingest.store().names().chunk_count() <= 1);
        if ingest.store().rows() == 1 {
            assert_eq!(ingest.store().name(0), b"one");
        }
    }
    assert!(calls.load(Ordering::Relaxed) < 128);
}

#[test]
fn sparse_zip64_directory_and_entry_offsets_stay_exact_past_four_gib() {
    let base = (1u64 << 32) + 4096;
    let local_offset = base - 1024;
    let mut entry = Entry::new(b"large-offset");
    entry.offset = Some(u32::MAX);
    let mut body = Vec::new();
    u64le(&mut body, local_offset);
    entry.extra = field(1, &body);
    let data = archive(&[entry], u16::MAX, Some(1));
    let directory_size = data.eocd - 76 - data.directory;
    let mut tail = data.bytes[data.directory..].to_vec();
    let zip64 = directory_size;
    tail[zip64 + 48..zip64 + 56].copy_from_slice(&base.to_le_bytes());
    tail[zip64 + 64..zip64 + 72].copy_from_slice(&(base + directory_size as u64).to_le_bytes());
    let eocd = tail.len() - 22;
    tail[eocd + 16..eocd + 20].copy_from_slice(&u32::MAX.to_le_bytes());
    let size = base + tail.len() as u64;
    let calls = Arc::new(AtomicUsize::new(0));
    let reader = SparseReader {
        base,
        tail,
        calls: Arc::clone(&calls),
    };
    let mut ingest = Ingest::open(reader, size).unwrap();
    assert_eq!(ingest.directory_offset(), base);
    assert_eq!(ingest.parse(10), 1);
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(
        cell(ingest.store(), 0, Column::LocalHeaderOffset),
        2f64.powi(32) + 3072.0
    );
    assert_eq!(ingest.store().name(0), b"large-offset");
    assert!(calls.load(Ordering::Relaxed) < 128);
}
