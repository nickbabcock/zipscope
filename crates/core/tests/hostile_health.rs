/*
ASSUMED API
ingest::Ingest<R>::health(&self) -> &health::Health
health::Health fields:
    terminal_error: Option<String>
    count_mismatch: Option<(u64, u64)>
    prelude_bytes: u64
    epilogue_bytes: u64
    encrypted_counts: [u64; 7]
    depth_cap_rows: u64
    folder_cap_rows: u64

count_mismatch gives (EOCD count, parsed count). Set it after a complete
parse. A partial parse does not establish a count mismatch.
encrypted_counts uses the low 7 bits of the contract encryption code.
Do not count AE-2 twice. Count each affected row once for each tree cap.
Prelude and epilogue counts exclude ZIP end records and the EOCD comment.
Report terminal errors with the stored rows. Keep findings after parse ends.
Check overlap in the parsed prefix, also after a terminal error.

These methods expose findings for tests and the health panel. The names
may change. Record a reason for any change to an expected result.
*/

#[path = "support/checks.rs"]
mod checks;
#[path = "support/zip.rs"]
#[allow(dead_code, reason = "These tests use part of the archive helpers.")]
mod zip;

use checks::{check_tree, finish};
use zip::{Entry, archive, open};
use zipscope_core::contract::{Column, encryption};
use zipscope_core::ingest::{Ingest, Status};
use zipscope_core::tree::MAX_DEPTH;

#[test]
fn empty_and_clean_archives_have_no_health_findings() {
    for entries in [vec![], vec![Entry::new("a/b"), Entry::new("a/c")]] {
        let mut ingest = open(archive(&entries, entries.len().try_into().unwrap(), None).bytes);
        finish(&mut ingest, 1, entries.len());
        assert_eq!(ingest.status(), &Status::Complete);
        let health = ingest.health();
        assert_eq!(health.terminal_error, None);
        assert_eq!(health.count_mismatch, None);
        assert_eq!(health.prelude_bytes, 0);
        assert_eq!(health.epilogue_bytes, 0);
        assert_eq!(health.encrypted_counts, [0; 7]);
        assert_eq!(health.depth_cap_rows, 0);
        assert_eq!(health.folder_cap_rows, 0);
    }
}

#[test]
fn terminal_error_keeps_the_prefix_tree_and_health_after_more_parse_calls() {
    let entries = ["kept/one", "kept/two", "broken", "unread"].map(Entry::new);
    let mut fixture = archive(&entries, 4, None);
    fixture.bytes[fixture.records[2]] = b'X';
    let mut ingest = open(fixture.bytes);
    finish(&mut ingest, 1, 4);
    let Status::Failed(message) = ingest.status() else {
        panic!("expected a terminal parse error");
    };
    let message = message.clone();
    assert_ne!(message, "");
    assert_eq!(
        ingest.health().terminal_error.as_deref(),
        Some(message.as_str())
    );
    assert_eq!(ingest.health().count_mismatch, None);
    assert_eq!(ingest.store().rows(), 2);
    assert_eq!(ingest.store().name(0), b"kept/one");
    assert_eq!(ingest.store().name(1), b"kept/two");
    check_tree(&ingest, 2);
    for batch in [0, 1, u32::MAX] {
        assert_eq!(ingest.parse(batch), 0);
        ingest.refresh_views();
        assert_eq!(ingest.store().rows(), 2);
        assert_eq!(
            ingest.health().terminal_error.as_deref(),
            Some(message.as_str())
        );
    }
}

#[test]
fn count_mismatch_uses_the_complete_listing_not_the_batch_prefix() {
    let entries = [Entry::new("one"), Entry::new("two"), Entry::new("three")];
    for hint in [0, 1, 3, 4, 65_534] {
        let mut ingest = open(archive(&entries, hint, None).bytes);
        assert_eq!(ingest.health().count_mismatch, None);
        assert_eq!(ingest.parse(1), 1);
        assert_eq!(ingest.health().count_mismatch, None);
        finish(&mut ingest, 1, 3);
        assert_eq!(ingest.status(), &Status::Complete);
        assert_eq!(ingest.store().rows(), 3);
        let expected = (hint != 3).then_some((u64::from(hint), 3));
        assert_eq!(ingest.health().count_mismatch, expected);
        assert_eq!(ingest.parse(100), 0);
        assert_eq!(ingest.health().count_mismatch, expected);
    }
}

#[test]
fn zip64_count_mismatch_keeps_all_64_bits() {
    let hint = (1 << 63) + 17;
    let mut ingest = open(archive(&[Entry::new("one")], u16::MAX, Some(hint)).bytes);
    finish(&mut ingest, 1, 1);
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(ingest.health().count_mismatch, Some((hint, 1)));
    assert_eq!(ingest.health().epilogue_bytes, 0);
}

#[test]
fn prelude_and_epilogue_exclude_eocd_comments_and_keep_correct_offsets() {
    let prefix = b"MZ stub data!";
    let suffix = b"tail data";
    let comment = b"ordinary ZIP comment";
    let entries = [Entry::new("one"), Entry::new("two")];
    for with_junk in [false, true] {
        let mut fixture = archive(&entries, 2, None);
        fixture.bytes[fixture.eocd + 20..fixture.eocd + 22]
            .copy_from_slice(&u16::try_from(comment.len()).unwrap().to_le_bytes());
        fixture.bytes.extend_from_slice(comment);
        let shift = if with_junk { prefix.len() } else { 0 };
        if with_junk {
            for &record in &fixture.records {
                let old =
                    u32::from_le_bytes(fixture.bytes[record + 42..record + 46].try_into().unwrap());
                fixture.bytes[record + 42..record + 46]
                    .copy_from_slice(&(old + u32::try_from(shift).unwrap()).to_le_bytes());
            }
            fixture.bytes[fixture.eocd + 16..fixture.eocd + 20].copy_from_slice(
                &u32::try_from(fixture.directory + shift)
                    .unwrap()
                    .to_le_bytes(),
            );
            fixture.bytes.splice(..0, prefix.iter().copied());
            fixture.bytes.extend_from_slice(suffix);
        }
        let mut ingest = open(fixture.bytes);
        finish(&mut ingest, 1, 2);
        assert_eq!(ingest.status(), &Status::Complete);
        assert_eq!(
            ingest.store().value(0, Column::LocalHeaderOffset),
            f64::from(u32::try_from(shift).unwrap())
        );
        assert_eq!(ingest.health().prelude_bytes, shift as u64);
        assert_eq!(
            ingest.health().epilogue_bytes,
            if with_junk { suffix.len() as u64 } else { 0 }
        );
        assert_eq!(ingest.health().count_mismatch, None);
    }
}

#[test]
fn encryption_health_counts_methods_and_ae2_without_decryption() {
    let entries = [
        Entry::new("plain"),
        Entry {
            flags: 1,
            ..Entry::new("zipcrypto")
        },
        Entry {
            method: 99,
            extra: zip::aes(1, 1, 8),
            ..Entry::new("aes128")
        },
        Entry {
            method: 99,
            flags: 1,
            extra: zip::aes(2, 2, 8),
            ..Entry::new("aes192")
        },
        Entry {
            method: 99,
            extra: zip::aes(2, 3, 93),
            ..Entry::new("aes256")
        },
        Entry {
            flags: 1 | (1 << 6),
            ..Entry::new("strong")
        },
        Entry {
            method: 99,
            ..Entry::new("unknown")
        },
        Entry {
            method: 99,
            extra: zip::aes(2, 0, 8),
            ..Entry::new("bad-strength")
        },
    ];
    let mut ingest = open(archive(&entries, 8, None).bytes);
    finish(&mut ingest, 1, entries.len());
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(ingest.store().rows(), entries.len());
    assert_eq!(ingest.health().encrypted_counts, [0, 1, 1, 1, 1, 1, 2]);
    assert_eq!(
        ingest.health().encrypted_counts[usize::from(encryption::AES_256)],
        1
    );
    assert_eq!(ingest.health().terminal_error, None);
}

#[test]
fn depth_cap_health_counts_rows_once_and_does_not_flag_the_next_shallow_row() {
    let entries = [
        Entry::new(format!("{}one", "d/".repeat(MAX_DEPTH + 10))),
        Entry::new(format!("{}two", "d/".repeat(MAX_DEPTH + 10))),
        Entry::new("shallow/file"),
    ];
    let mut ingest = open(archive(&entries, 3, None).bytes);
    finish(&mut ingest, 1, 3);
    assert_eq!(ingest.health().depth_cap_rows, 2);
    assert_eq!(ingest.health().folder_cap_rows, 0);
    assert_eq!(ingest.parse(100), 0);
    assert_eq!(ingest.health().depth_cap_rows, 2);
    check_tree(&ingest, MAX_DEPTH + 2);
}

#[test]
fn folder_cap_has_its_own_health_finding_and_keeps_rows() {
    let entries = ["a/one", "b/two", "a/three", "b/", "root"].map(Entry::new);
    let bytes = archive(&entries, 5, None).bytes;
    let mut ingest = Ingest::with_folder_limit(bytes.clone(), bytes.len() as u64, 2).unwrap();
    finish(&mut ingest, 1, 5);
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(ingest.health().folder_cap_rows, 2);
    assert_eq!(ingest.health().depth_cap_rows, 0);
    check_tree(&ingest, 2);
}

#[test]
fn truncated_variable_fields_are_terminal_and_keep_previous_findings() {
    for length_offset in [28, 30, 32] {
        let kept = Entry {
            size: 16 << 20,
            compressed: 1,
            offset: Some(0),
            ..Entry::new("same")
        };
        let entries = [kept.clone(), kept, Entry::new("broken")];
        let mut fixture = archive(&entries, 3, None);
        let at = fixture.records[2] + length_offset;
        fixture.bytes[at..at + 2].copy_from_slice(&u16::MAX.to_le_bytes());
        let mut ingest = open(fixture.bytes);
        finish(&mut ingest, 2, 3);
        assert!(matches!(ingest.status(), Status::Failed(_)));
        assert_eq!(ingest.store().rows(), 2);
        assert!(
            ingest
                .health()
                .terminal_error
                .as_ref()
                .is_some_and(|message| !message.is_empty())
        );
        assert!(checks::marked(
            &ingest,
            1,
            zipscope_core::contract::marks::DUPLICATE_NAME
        ));
        for row in 0..2 {
            for bit in [
                zipscope_core::contract::marks::BOMB_RATIO,
                zipscope_core::contract::marks::OVERLAP,
            ] {
                assert!(checks::marked(&ingest, row, bit), "row {row}: bit {bit}");
            }
        }
        check_tree(&ingest, 1);
    }
}
