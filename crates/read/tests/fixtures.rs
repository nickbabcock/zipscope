#[path = "support/fixture.rs"]
mod zip;

use zip::{Descriptor, Entry, Options, build};
use zipscope_read::directory::{Directory, Scan};

#[test]
fn generated_headers_have_the_expected_rows_and_offsets() {
    for descriptor in [
        Descriptor::None,
        Descriptor::Plain,
        Descriptor::Signed,
        Descriptor::Zip64Plain,
        Descriptor::Zip64Signed,
    ] {
        let entries = [Entry {
            descriptor,
            ..Entry::new("a", "abc")
        }];
        for (zip64, base, relative_offsets) in [
            (false, 0, false),
            (false, 0, true),
            (true, 0, false),
            (true, (1 << 40) + 7, false),
        ] {
            let fixture = build(
                &entries,
                &Options {
                    prelude: b"#!/bin/sh\nexit 0\n".to_vec(),
                    comment: b"comment".to_vec(),
                    epilogue: b"tail".to_vec(),
                    zip64,
                    base,
                    relative_offsets,
                    ..Options::default()
                },
            );
            let mut directory = Directory::open(fixture.reader(), fixture.size()).unwrap();
            let located = directory.locate(0).unwrap();
            assert_eq!(located.record_offset, fixture.records[0]);
            let local = zipscope_read::local::check(directory.archive(), located).unwrap();
            assert_eq!(local.local_name, b"a");
            assert_eq!(located.wayfinder.compressed_size_hint(), 3);
            assert_eq!(located.wayfinder.uncompressed_size_hint(), 3);
            directory.scan(2);
            assert_eq!(directory.status(), &Scan::Complete);
            assert_eq!(directory.rows(), 1);
            assert_eq!(directory.archive().end_offset(), fixture.end);
            assert_eq!(directory.archive().directory_offset(), fixture.directory);
        }
    }
}

#[test]
fn false_counts_do_not_change_the_generated_directory() {
    for declared in [0, 1, 7, 1 << 63] {
        let fixture = build(
            &[
                Entry {
                    extra: zip::field(0xcafe, &vec![0; 65_531]),
                    comment: vec![0x82; usize::from(u16::MAX)],
                    local_extra: zip::field(0xbeef, &vec![0; 65_531]),
                    ..Entry::new(vec![b'a'; usize::from(u16::MAX)], "1")
                },
                Entry::new("two", "22"),
            ],
            &Options {
                zip64: true,
                declared: Some(declared),
                ..Options::default()
            },
        );
        let mut directory = Directory::open(fixture.reader(), fixture.size()).unwrap();
        for _ in 0..3 {
            directory.scan(1);
        }
        assert_eq!(directory.status(), &Scan::Complete);
        assert_eq!(directory.rows(), 2);
    }
}

#[test]
fn split_disk_fields_are_available_to_the_inspector() {
    for zip64 in [false, true] {
        let fixture = build(
            &[Entry {
                disk: 1,
                ..Entry::new("a", "abc")
            }],
            &Options {
                zip64,
                disk: 1,
                directory_disk: 1,
                total_disks: 2,
                disk_entries: Some(0),
                ..Options::default()
            },
        );
        let mut directory = Directory::open(fixture.reader(), fixture.size()).unwrap();
        directory.scan(2);
        assert_eq!(directory.rows(), 1);
    }
}

#[test]
fn empty_and_extended_zip64_ends_keep_their_physical_boundaries() {
    for zip64 in [false, true] {
        let fixture = build(
            &[],
            &Options {
                zip64,
                prelude: b"prefix".to_vec(),
                zip64_extension: zip::field(0xbeef, b"extension"),
                comment: b"empty".to_vec(),
                epilogue: b"tail".to_vec(),
                ..Options::default()
            },
        );
        let mut directory = Directory::open(fixture.reader(), fixture.size()).unwrap();
        directory.scan(1);
        assert_eq!(directory.status(), &Scan::Complete);
        assert_eq!(directory.rows(), 0);
        assert_eq!(directory.archive().end_offset(), fixture.end);
        assert_eq!(directory.archive().eocd_offset(), fixture.eocd);
        assert_eq!(directory.archive().directory_offset(), fixture.directory);
    }
}
