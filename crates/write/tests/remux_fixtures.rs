//! Checks of the test archives of the remux. These tests use no new API:
//! they make sure that the builder writes the hostile fields that the
//! remux tests expect, and that the strict parser reads a good archive.

#[path = "support/remux_zip.rs"]
mod zip;

use zip::{Descriptor, Entry, Options, build, build_with, decode, fields, noise, parse, text, ut};
use zipscope_core::ingest::{Ingest, Status};

#[test]
fn the_builder_and_the_strict_parser_agree() {
    let mut a = Entry::deflated("a.txt", text(10_000, 1));
    a.comment = b"comment".to_vec();
    a.extra = ut(1_600_000_000);
    let mut b = Entry::zstd("b.txt", text(10_000, 2));
    b.descriptor = Descriptor::Signed;
    let mut c = Entry::stored("c.bin", noise(1000, 3));
    c.descriptor = Descriptor::Unsigned;
    c.force_zip64 = true;
    let entries = vec![a, b, c];
    let built = build_with(
        &entries,
        &Options {
            comment: b"archive".to_vec(),
            zip64: true,
            ..Options::default()
        },
    );
    let parsed = parse(built.source.tail());
    assert!(parsed.zip64);
    assert_eq!(parsed.comment, b"archive");
    for (entry, record) in entries.iter().zip(&parsed.records) {
        assert_eq!(record.name, entry.name);
        assert_eq!(record.comment, entry.comment);
        assert_eq!(record.crc, entry.true_crc());
        assert_eq!(decode(record).unwrap(), entry.body);
    }
    assert_eq!(fields(&parsed.records[0].extra), fields(&ut(1_600_000_000)));
}

#[test]
fn the_strict_parser_rejects_a_prelude() {
    let built = build_with(
        &[Entry::stored("a.txt", text(10, 1))],
        &Options {
            prelude: b"stub".to_vec(),
            ..Options::default()
        },
    );
    let result = std::panic::catch_unwind(|| parse(built.source.tail()));
    let Err(_) = result else {
        panic!("The strict parser read a prelude");
    };
}

#[test]
fn the_core_reads_the_hostile_sources() {
    let mut bad = Entry::deflated("bad.txt", text(100, 1));
    bad.crc = Some(1);
    let mut alias = Entry::deflated("alias.txt", text(100, 1));
    alias.share = Some(0);
    let mut far = Entry::stored("far.txt", text(10, 2));
    far.force_zip64 = true;
    let entries = vec![bad, alias, far];
    for base in [0, 5 << 30] {
        let built = build_with(
            &entries,
            &Options {
                base,
                ..Options::default()
            },
        );
        let mut ingest = Ingest::open(built.source.clone(), built.source.size()).unwrap();
        assert_eq!(ingest.parse(u32::MAX), 3);
        assert_eq!(ingest.status(), &Status::Complete);
        ingest.finish_checks();
        assert_eq!(ingest.health().overlap_rows, 2);
    }
}

#[test]
fn rawzip_reads_sources_past_4_gib() {
    let built = build_with(
        &[Entry::deflated("far.txt", text(1000, 1))],
        &Options {
            base: 5 << 30,
            ..Options::default()
        },
    );
    assert!(built.offsets[0] > u64::from(u32::MAX));
    let mut buffer = vec![0u8; 64 * 1024];
    let archive = rawzip::ZipLocator::new()
        .locate_in_reader(built.source.clone(), &mut buffer, built.source.size())
        .map_err(|(_, err)| err)
        .unwrap();
    let mut entries = archive.entries(&mut buffer);
    let record = entries.next_entry().unwrap().unwrap();
    assert_eq!(record.local_header_offset(), built.offsets[0]);
}

#[test]
fn an_empty_source_parses() {
    assert_eq!(parse(build(&[]).source.tail()).records.len(), 0);
}
