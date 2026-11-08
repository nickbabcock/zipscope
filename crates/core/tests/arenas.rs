/*
ASSUMED API
Store::comments(&self) -> &zipscope_core::arena::Arena
Store::raw_name(&self, row: usize) -> Option<&[u8]>

raw_name returns the archive bytes only when the name source is lossy.
These methods give read access to the two arenas.
*/

#[path = "support/zip.rs"]
#[expect(dead_code, reason = "This test binary uses only the arena helpers.")]
mod support;

use support::*;
use zipscope_core::contract::{CHUNK_BITS, CHUNK_BYTES, Column};
use zipscope_core::ingest::Status;
use zipscope_core::store::Store;

fn comment(store: &Store, row: usize) -> &[u8] {
    store.comments().get(
        cell_u32(store, row, Column::CommentOffset),
        cell_u32(store, row, Column::CommentLength),
    )
}

#[test]
fn only_lossy_names_keep_raw_bytes() {
    let mut lossy = Entry::new(b"bad-\xff-\xc0\xaf");
    lossy.flags = 0x0800;
    let mut flagged = Entry::new("valid-é");
    flagged.flags = 0x0800;
    let cp437 = Entry::new(b"caf\x82");
    let mut unicode = lossy.clone();
    unicode.extra = unicode_path(1, crc32(&unicode.name), b"recovered");
    let entries = [lossy.clone(), flagged, cp437, Entry::new(b"ascii"), unicode];
    let ingest = parsed(&entries);
    assert_eq!(ingest.store().raw_name(0), Some(lossy.name.as_slice()));
    for row in 1..entries.len() {
        assert_eq!(ingest.store().raw_name(row), None, "row {row}");
    }
    assert_eq!(ingest.store().name(4), b"recovered");
}

#[test]
fn retained_raw_names_stay_exact_across_batches() {
    let mut entries = Vec::new();
    for raw in [b"a\xff".as_slice(), b"b\xed\xa0\x80", b"c\xe2\x82"] {
        let mut entry = Entry::new(raw);
        entry.flags = 0x0800;
        entries.push(entry);
    }
    let mut ingest = open(archive(&entries, 3, None).bytes);
    for expected_rows in 1..=entries.len() {
        assert_eq!(ingest.parse(1), 1);
        for (row, entry) in entries[..expected_rows].iter().enumerate() {
            assert_eq!(ingest.store().raw_name(row), Some(entry.name.as_slice()));
            assert_eq!(cell(ingest.store(), row, Column::NameSource), 4.0);
            std::str::from_utf8(ingest.store().name(row)).unwrap();
        }
    }
}

#[test]
fn comments_use_a_separate_utf8_arena_and_lengths_are_bytes() {
    let mut first = Entry::new(b"a");
    first.flags = 0x0800;
    first.comment = "説明\0<svg>".as_bytes().to_vec();
    let mut second = Entry::new(b"bc");
    second.comment = b"other".to_vec();
    let ingest = parsed(&[first.clone(), second.clone(), Entry::new(b"empty")]);
    let store = ingest.store();
    assert_eq!(cell(store, 0, Column::NameOffset), 0.0);
    assert_eq!(cell(store, 1, Column::NameOffset), 1.0);
    assert_eq!(cell(store, 0, Column::CommentOffset), 0.0);
    assert_eq!(
        cell(store, 1, Column::CommentOffset),
        f64::from(u32::try_from(first.comment.len()).unwrap())
    );
    assert_eq!(
        cell(store, 0, Column::CommentLength),
        f64::from(u32::try_from(first.comment.len()).unwrap())
    );
    assert_eq!(comment(store, 0), first.comment);
    assert_eq!(comment(store, 1), second.comment);
    assert_eq!(comment(store, 2), b"");
    assert_eq!(store.names().chunk(0), b"abcempty");
    assert_ne!(
        store.names().chunk(0).as_ptr(),
        store.comments().chunk(0).as_ptr()
    );
}

#[test]
fn empty_comment_at_a_full_chunk_stays_in_that_chunk() {
    let mut long = Entry::new(b"n");
    long.comment = vec![b'c'; 65_535];
    let mut entries = vec![long; 64];
    let mut fill = Entry::new(b"n");
    fill.comment = vec![b'f'; 64];
    entries.push(fill);
    entries.push(Entry::new(b"empty"));
    let mut last = Entry::new(b"last");
    last.comment = b"x".to_vec();
    entries.push(last);
    let mut ingest = open(archive(&entries, 67, None).bytes);
    assert_eq!(ingest.store().comments().chunk_count(), 0);
    assert_eq!(ingest.parse(65), 65);
    assert_eq!(ingest.store().comments().chunk_count(), 1);
    assert_eq!(ingest.store().comments().chunk(0).len(), CHUNK_BYTES);
    let pointer = ingest.store().comments().chunk(0).as_ptr();
    assert_eq!(ingest.parse(1), 1);
    assert_eq!(ingest.store().comments().chunk_count(), 1);
    assert_eq!(
        cell(ingest.store(), 65, Column::CommentOffset),
        f64::from(u32::try_from(CHUNK_BYTES - 1).unwrap())
    );
    assert_eq!(comment(ingest.store(), 65), b"");
    assert_eq!(ingest.parse(2), 1);
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(ingest.store().comments().chunk_count(), 2);
    assert_eq!(ingest.store().comments().chunk(0).as_ptr(), pointer);
    assert_eq!(
        cell(ingest.store(), 66, Column::CommentOffset),
        f64::from(1u32 << CHUNK_BITS)
    );
    for (row, entry) in entries.iter().enumerate() {
        assert!(
            comment(ingest.store(), row) == entry.comment,
            "comment differs at row {row}"
        );
    }
    assert_eq!(ingest.store().names().chunk_count(), 1);
}
