/*
ASSUMED API
ingest::Ingest<R>::health(&self) -> &health::Health
health::Health fields:
    terminal_error: Option<String>
    count_mismatch: Option<(u64, u64)>
    prelude_bytes: u64
    epilogue_bytes: u64
    encrypted_counts: [u64; 7]

Use the same meanings as crates/core/tests/hostile_health.rs.
Read rawzip assets from the Cargo cache. Do not copy them into the repo.
*/

use zipscope_core::contract::Column;
use zipscope_core::ingest::{Ingest, Status};
use zipscope_testkit::corpus;
use zipscope_testkit::listing::Outcome;

fn parse(name: &str) -> Ingest<Vec<u8>> {
    let bytes = std::fs::read(corpus::rawzip_assets().unwrap().join(name)).unwrap();
    let size = bytes.len() as u64;
    let mut ingest = Ingest::open(bytes, size).unwrap();
    for _ in 0..=usize::try_from(size).unwrap() / 46 + 1 {
        if *ingest.status() != Status::Parsing {
            return ingest;
        }
        ingest.parse(7);
        ingest.refresh_views();
    }
    panic!("parsing did not stop: {name}");
}

#[test]
fn rawzip_corpus_keeps_the_reference_listing_and_terminal_errors() {
    let files = corpus::rawzip_files().unwrap();
    assert!(files.len() >= 30);
    for path in files {
        let expected = corpus::reference(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let size = bytes.len() as u64;
        let opened = Ingest::open(bytes, size);
        if matches!(expected.outcome, Outcome::NotZip(_)) {
            assert!(opened.is_err(), "{}", path.display());
            continue;
        }
        let mut ingest = opened.unwrap();
        for _ in 0..=expected.entries.len() + 1 {
            if *ingest.status() != Status::Parsing {
                break;
            }
            ingest.parse(7);
            ingest.refresh_views();
        }
        assert_eq!(
            ingest.store().rows(),
            expected.entries.len(),
            "{}",
            path.display()
        );
        match expected.outcome {
            Outcome::Complete => {
                assert_eq!(ingest.status(), &Status::Complete, "{}", path.display());
                assert_eq!(ingest.health().terminal_error, None);
                let count = expected.entries.len() as u64;
                let mismatch =
                    (ingest.entries_hint() != count).then_some((ingest.entries_hint(), count));
                assert_eq!(
                    ingest.health().count_mismatch,
                    mismatch,
                    "{}",
                    path.display()
                );
            }
            Outcome::Failed(_) => {
                assert!(
                    matches!(ingest.status(), Status::Failed(_)),
                    "{}",
                    path.display()
                );
                assert!(
                    ingest
                        .health()
                        .terminal_error
                        .as_ref()
                        .is_some_and(|message| !message.is_empty())
                );
            }
            Outcome::NotZip(_) => unreachable!(),
        }
        for (row, entry) in expected.entries.iter().enumerate() {
            assert_eq!(
                ingest.store().name(row),
                entry.name.as_bytes(),
                "{}: row {row}",
                path.display()
            );
            #[expect(
                clippy::cast_precision_loss,
                reason = "The contract stores ZIP sizes as f64."
            )]
            let size = entry.uncompressed_size as f64;
            assert_eq!(ingest.store().value(row, Column::UncompressedSize), size);
        }
        assert_eq!(ingest.parse(7), 0);
    }
}

#[test]
fn rawzip_count_prefix_and_suffix_fixtures_have_health_findings() {
    let count = parse("eocd-undercount.zip");
    assert_eq!(count.status(), &Status::Complete);
    let rows = count.store().rows() as u64;
    assert!(rows > count.entries_hint());
    assert_eq!(
        count.health().count_mismatch,
        Some((count.entries_hint(), rows))
    );
    assert!(parse("test-prefix.zip").health().prelude_bytes > 0);
    assert!(parse("test-trailing-junk.zip").health().epilogue_bytes > 0);
}

#[test]
fn rawzip_encrypted_fixtures_are_listed_and_counted_by_kind() {
    for (name, kind) in [
        ("aes128.zip", 2),
        ("aes192.zip", 3),
        ("aes256-ae1.zip", 4),
        ("aes256.zip", 4),
        ("zipcrypto.zip", 1),
        ("zipcrypto-no-data-descriptor.zip", 1),
    ] {
        let ingest = parse(name);
        assert_eq!(ingest.status(), &Status::Complete, "{name}");
        assert!(ingest.store().rows() > 0, "{name}");
        assert!(ingest.health().encrypted_counts[kind] > 0, "{name}");
        assert_eq!(ingest.health().terminal_error, None, "{name}");
    }
}
