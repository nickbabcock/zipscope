//! Zip64 fields and data descriptors in the report: the start disk, the
//! descriptor width of an empty entry and the zip64 markers.
#[path = "support/report.rs"]
mod archive;
#[path = "../../read/tests/support/fixture.rs"]
mod zip;

use archive::RegionKind as K;
use zip::{Descriptor, Entry, Options, build, field};

fn report(entries: &[Entry]) -> (zip::Fixture, archive::Report) {
    let fixture = build(entries, &Options::default());
    let report = archive::inspect(&fixture.reader(), fixture.size()).unwrap();
    (fixture, report)
}

/// The start disk 0xffff means "see the zip64 extra field".
#[test]
fn a_zip64_start_disk_is_read_from_the_extra_field() {
    let disk = |value: u32| Entry {
        disk: u16::MAX,
        extra: field(1, &value.to_le_bytes()),
        ..Entry::new("a", "abc")
    };
    let (_, spanned) = report(&[disk(70_000)]);
    assert!(spanned.disks.unsupported);
    let (_, single) = report(&[disk(0)]);
    assert!(!single.disks.unsupported);
    // The marker without the field keeps the disk 0xffff, as rawzip reads
    // it: not disk 0.
    let (_, unknown) = report(&[Entry {
        disk: u16::MAX,
        ..Entry::new("a", "abc")
    }]);
    assert!(unknown.disks.unsupported);
    // With zip64 sizes, the disk comes after the two 8-byte sizes. Here the
    // builder writes its own zip64 field (the sizes only, after `extra`),
    // so the disk value is not there and stays 0xffff.
    let (_, after) = report(&[Entry {
        disk: u16::MAX,
        descriptor: Descriptor::Zip64Plain,
        extra: field(0xcafe, b"other field first"),
        ..Entry::new("a", "abc")
    }]);
    assert!(after.disks.unsupported);
}

/// An empty zip64 entry agrees with both descriptor widths.
#[test]
fn an_empty_zip64_entry_takes_the_8_byte_descriptor() {
    for descriptor in [
        Descriptor::Zip64Plain,
        Descriptor::Zip64Signed,
        Descriptor::Plain,
        Descriptor::Signed,
    ] {
        let (fixture, report) = report(&[
            Entry {
                descriptor,
                ..Entry::new("empty", "")
            },
            Entry::new("next", "z"),
        ]);
        assert!(
            report.regions.iter().all(|region| region.kind != K::Gap),
            "{descriptor:?}: {:?}",
            report.regions
        );
        assert_eq!(fixture.locals[0].1, fixture.locals[1].0);
    }
}

/// Where the zip64 markers and fields are.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Place {
    /// As the builder writes: a zip64 descriptor has the size markers and
    /// the zip64 field in both headers; a 32-bit one has none.
    Default,
    /// Markers and field only in the central-directory record.
    CdOnly,
    /// Markers and field only in the local header (as Python `zipfile`
    /// writes with `force_zip64=True`).
    LocalOnly,
    /// A zip64 field without markers, in the central-directory record.
    CdFieldOnly,
    /// A zip64 field without markers, in the local header.
    LocalFieldOnly,
}

/// A body whose CRC-32 is the descriptor signature 0x08074b50.
const COLLIDES: [u8; 4] = [0xac, 0x0a, 0x7a, 0xd5];

fn wide(descriptor: Descriptor) -> bool {
    matches!(descriptor, Descriptor::Zip64Plain | Descriptor::Zip64Signed)
}

fn case(descriptor: Descriptor, body: &[u8], place: Place, trailer: &[u8]) -> zip::Fixture {
    let entry = Entry {
        descriptor,
        gap: trailer.to_vec(),
        extra: if place == Place::CdFieldOnly {
            field(1, &[0; 16])
        } else {
            Vec::new()
        },
        local_extra: if place == Place::LocalFieldOnly {
            field(1, &[0; 16])
        } else {
            Vec::new()
        },
        ..Entry::new("entry", body)
    };
    let mut fixture = build(&[entry, Entry::new("next", "z")], &Options::default());
    let local = fixture.locals[0].0;
    let record = fixture.records[0];
    let size = u32::try_from(body.len()).unwrap();
    match place {
        Place::CdOnly => {
            // The local header gets 0 sizes (a descriptor holds them) and
            // its zip64 field another id.
            fixture.patch32(local + 18, 0);
            fixture.patch32(local + 22, 0);
            fixture.patch16(local + 30 + 5, 0xbeef);
        }
        Place::LocalOnly => {
            fixture.patch32(record + 20, size);
            fixture.patch32(record + 24, size);
            fixture.patch16(record + 46 + 5, 0xbeef);
        }
        _ => {}
    }
    fixture
}

/// Rules (a) and (b) as a table: signed and unsigned descriptors, 32- and
/// 64-bit sizes, empty and non-empty entries, a CRC-32 that is the
/// signature, and each place of the zip64 markers and fields. A gap of
/// "GAP!" after the descriptor must show as exactly that gap; with no gap,
/// there must be none. The archive has no zip64 end record.
#[test]
fn descriptor_and_zip64_rules_as_a_table() {
    assert_eq!(rawzip::crc32(&COLLIDES), 0x0807_4b50);
    let mut failures = Vec::new();
    for descriptor in [
        Descriptor::Plain,
        Descriptor::Signed,
        Descriptor::Zip64Plain,
        Descriptor::Zip64Signed,
    ] {
        let places: &[Place] = if wide(descriptor) {
            &[Place::Default, Place::CdOnly, Place::LocalOnly]
        } else {
            &[Place::Default, Place::CdFieldOnly, Place::LocalFieldOnly]
        };
        for body in [&b""[..], &b"abc"[..], &COLLIDES[..]] {
            for &place in places {
                for trailer in [&b"GAP!"[..], &b""[..]] {
                    let fixture = case(descriptor, body, place, trailer);
                    let report = archive::inspect(&fixture.reader(), fixture.size()).unwrap();
                    let gaps: Vec<_> = report
                        .regions
                        .iter()
                        .filter(|region| region.kind == K::Gap)
                        .map(|region| (region.offset, region.size))
                        .collect();
                    let expected_gaps = if trailer.is_empty() {
                        vec![]
                    } else {
                        vec![(fixture.locals[0].1, trailer.len() as u64)]
                    };
                    let zip64 = wide(descriptor) || place != Place::Default;
                    if gaps != expected_gaps || report.zip64 != zip64 {
                        failures.push(format!(
                            "{descriptor:?} body {body:?} {place:?} trailer {trailer:?}: gaps {gaps:?}, zip64 {}",
                            report.zip64
                        ));
                    }
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Rule (a) when the bytes after an empty entry are zeros: both widths
/// agree, so the width of the entry chooses.
#[test]
fn zeros_after_an_empty_entry_follow_the_width_of_the_entry() {
    for (descriptor, descriptor_bytes) in [
        (Descriptor::Plain, 12),
        (Descriptor::Signed, 16),
        (Descriptor::Zip64Plain, 20),
        (Descriptor::Zip64Signed, 24),
    ] {
        let fixture = case(descriptor, b"", Place::Default, &[0; 8]);
        let report = archive::inspect(&fixture.reader(), fixture.size()).unwrap();
        let gap = report.regions.iter().find(|region| region.kind == K::Gap);
        let local = fixture.locals[0];
        assert_eq!(
            local.1 - local.0 - 30 - 5,
            descriptor_bytes + if wide(descriptor) { 20 } else { 0 }
        );
        assert_eq!(
            gap.map(|region| (region.offset, region.size)),
            Some((local.1, 8)),
            "{descriptor:?}"
        );
    }
}

/// Rule (b) with a fixture in the form of Python `zipfile` with
/// `force_zip64=True`: version 45, local size markers and a local zip64
/// field with the two sizes, a 32-bit central directory and no zip64 end
/// record. (From the bytes that Python 3 writes, made here.)
#[test]
fn a_force_zip64_archive_is_zip64() {
    let mut out = Vec::new();
    let mut records = Vec::new();
    for (name, body) in [(&b"a.txt"[..], &b"abc"[..]), (&b"e.txt"[..], &b""[..])] {
        let offset = u32::try_from(out.len()).unwrap();
        let crc = rawzip::crc32(body);
        let size = u32::try_from(body.len()).unwrap();
        let mut local = Vec::new();
        local.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        local.extend_from_slice(&45u16.to_le_bytes());
        local.extend_from_slice(&[0; 8]);
        local.extend_from_slice(&crc.to_le_bytes());
        local.extend_from_slice(&u32::MAX.to_le_bytes());
        local.extend_from_slice(&u32::MAX.to_le_bytes());
        local.extend_from_slice(&5u16.to_le_bytes());
        local.extend_from_slice(&20u16.to_le_bytes());
        local.extend_from_slice(name);
        let mut sizes = Vec::new();
        sizes.extend_from_slice(&u64::from(size).to_le_bytes());
        sizes.extend_from_slice(&u64::from(size).to_le_bytes());
        local.extend_from_slice(&field(1, &sizes));
        local.extend_from_slice(body);
        out.extend_from_slice(&local);
        let mut record = Vec::new();
        record.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        record.extend_from_slice(&0x032du16.to_le_bytes());
        record.extend_from_slice(&45u16.to_le_bytes());
        record.extend_from_slice(&[0; 8]);
        record.extend_from_slice(&crc.to_le_bytes());
        record.extend_from_slice(&size.to_le_bytes());
        record.extend_from_slice(&size.to_le_bytes());
        record.extend_from_slice(&5u16.to_le_bytes());
        record.extend_from_slice(&[0; 8]);
        record.extend_from_slice(&0x0180_0000u32.to_le_bytes());
        record.extend_from_slice(&offset.to_le_bytes());
        record.extend_from_slice(name);
        records.push(record);
    }
    let start = u32::try_from(out.len()).unwrap();
    let directory: Vec<u8> = records.concat();
    out.extend_from_slice(&directory);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&u32::try_from(directory.len()).unwrap().to_le_bytes());
    out.extend_from_slice(&start.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    let size = out.len() as u64;
    let report = archive::inspect(&out, size).unwrap();
    assert!(report.zip64);
    assert!(report.regions.iter().all(|region| region.kind != K::Gap));
    assert_eq!(report.found_entries, 2);
}
