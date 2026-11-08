//! Hostile archives for the read module: local headers that
//! disagree with the central directory, sizes that lie and data that ends
//! early. Each case must give a clear status, read only what it is asked
//! for, and never panic.

mod support;

use support::zip::{Entry, build};
use zipscope_read::directory::Directory;
use zipscope_read::local::{self, mismatch};
use zipscope_read::stream::{Status, Stream};

/// Opens an archive and starts a stream for a row.
fn open(data: Vec<u8>) -> Directory<Vec<u8>> {
    let size = data.len() as u64;
    Directory::open(data, size).unwrap()
}

fn stream(directory: &mut Directory<Vec<u8>>, row: usize) -> Stream {
    let located = directory.locate(row).unwrap();
    let record = local::read_record(directory.archive(), located).unwrap();
    Stream::open(directory.archive(), row, located, &record).unwrap()
}

/// Reads at most `limit` bytes in steps of 64 KiB.
fn read_up_to(stream: &mut Stream, limit: usize) -> Vec<u8> {
    let mut out = Vec::new();
    while out.len() < limit && stream.read(&mut out, 64 * 1024) > 0 {}
    out
}

fn failure(stream: &Stream) -> &str {
    match stream.status() {
        Status::Failed(message) => message,
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[test]
fn flags_a_local_name_that_hides_another_file() {
    let mut entry = Entry::deflated("invoice.pdf", b"MZ fake program".to_vec());
    entry.local_name = Some(b"setup.exe".to_vec());
    let mut directory = open(build(&[entry, Entry::stored("ok.txt", b"ok".to_vec())]));
    let located = directory.locate(0).unwrap();
    let check = local::check(directory.archive(), located).unwrap();
    assert_eq!(check.mismatches, mismatch::NAME);
    assert_eq!(check.local_name, b"setup.exe");
    // The data still decodes by the central directory.
    let mut stream = stream(&mut directory, 0);
    assert_eq!(read_up_to(&mut stream, 1 << 20), b"MZ fake program");
    assert_eq!(stream.status(), &Status::Verified);
    // The next row is not affected.
    let next = directory.locate(1).unwrap();
    assert_eq!(
        local::check(directory.archive(), next).unwrap().mismatches,
        0
    );
}

#[test]
fn reads_only_the_start_of_a_huge_claimed_size() {
    // A zip64 record claims 2^60 bytes for 10 real bytes.
    let mut entry = Entry::stored("huge.bin", b"0123456789".to_vec());
    entry.uncompressed = Some(1 << 60);
    entry.compressed = Some(1 << 60);
    let mut directory = open(build(&[entry]));
    let mut stream = stream(&mut directory, 0);
    let mut out = Vec::new();
    // A step allocates only the bytes that it asks for.
    stream.read(&mut out, 4);
    assert_eq!(out, b"0123");
    // The data runs into the central directory and then ends at the end of
    // the file, long before the claim.
    let rest = read_up_to(&mut stream, 1 << 20);
    assert!(rest.len() < 4096);
    assert!(failure(&stream).contains("ended"), "{}", failure(&stream));
}

#[test]
fn stops_a_bomb_at_its_declared_size() {
    // 8 MiB of zeros deflate to a few KiB, but the record claims 1,000 bytes.
    let mut entry = Entry::deflated("bomb.txt", vec![0u8; 8 << 20]);
    entry.uncompressed = Some(1000);
    let mut directory = open(build(&[entry]));
    let mut stream = stream(&mut directory, 0);
    let out = read_up_to(&mut stream, 16 << 20);
    assert!(out.len() <= 1000 + 64 * 1024);
    assert!(failure(&stream).contains("CRC-32") || failure(&stream).contains("longer"));
}

#[test]
fn reports_truncated_deflate_data() {
    let body: Vec<u8> = (0..200_000u32).flat_map(u32::to_le_bytes).collect();
    let mut encoder =
        flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut encoder, &body).unwrap();
    let mut bytes = encoder.finish().unwrap();
    // The deflate stream stops in the middle. The sizes of the record agree
    // with the cut data, so the reader stops at the cut.
    bytes.truncate(bytes.len() / 2);
    let mut cut = Entry::deflated("cut.bin", body.clone());
    cut.data = Some(bytes);
    let mut directory = open(build(&[cut]));
    let mut stream = stream(&mut directory, 0);
    let out = read_up_to(&mut stream, 4 << 20);
    assert!(out.len() < body.len());
    assert_eq!(out, body[..out.len()]);
    failure(&stream);
}

#[test]
fn reports_a_crc_that_disagrees() {
    let mut entry = Entry::stored("a.txt", b"hello".to_vec());
    entry.crc = Some(0xdead_beef);
    // The local header gets the same false CRC, so only the data shows it.
    let mut directory = open(build(&[entry]));
    let located = directory.locate(0).unwrap();
    assert_eq!(
        local::check(directory.archive(), located)
            .unwrap()
            .mismatches,
        0
    );
    let mut stream = stream(&mut directory, 0);
    read_up_to(&mut stream, 100);
    assert!(failure(&stream).contains("CRC-32"));
}

#[test]
fn reports_a_declared_size_larger_than_the_data() {
    let mut entry = Entry::deflated("short.txt", b"short".to_vec());
    entry.uncompressed = Some(5_000_000);
    entry.local_uncompressed = Some(5_000_000);
    let mut directory = open(build(&[entry]));
    let mut stream = stream(&mut directory, 0);
    assert_eq!(read_up_to(&mut stream, 1 << 20), b"short");
    assert!(failure(&stream).contains("ended after 5 bytes"));
}

#[test]
fn rejects_a_local_header_past_the_end_of_the_file() {
    let mut entry = Entry::stored("gone.txt", b"x".to_vec());
    entry.offset = Some(u64::from(u32::MAX - 100));
    let mut directory = open(build(&[entry]));
    let located = directory.locate(0).unwrap();
    local::check(directory.archive(), located).unwrap_err();
    let record = local::read_record(directory.archive(), located).unwrap();
    Stream::open(directory.archive(), 0, located, &record).unwrap_err();
}

#[test]
fn reads_the_rawzip_corpus_without_a_panic() {
    for path in zipscope_testkit::corpus::rawzip_files().unwrap() {
        let data = std::fs::read(&path).unwrap();
        let size = data.len() as u64;
        let Ok(mut directory) = Directory::open(data, size) else {
            continue;
        };
        let mut row = 0;
        while let Some(located) = directory.locate(row) {
            let archive = directory.archive();
            let _ = local::check(archive, located);
            if let Ok(record) = local::read_record(archive, located)
                && let Ok(mut stream) = Stream::open(archive, row, located, &record)
            {
                let out = read_up_to(&mut stream, 1 << 20);
                assert!(out.len() <= (1 << 20) + 64 * 1024, "{}", path.display());
            }
            row += 1;
        }
    }
}

#[test]
fn finds_the_mismatch_in_the_rawzip_asset() {
    let path = zipscope_testkit::corpus::rawzip_assets()
        .unwrap()
        .join("filename_mismatch_test.zip");
    let mut directory = open(std::fs::read(path).unwrap());
    let located = directory.locate(0).unwrap();
    let check = local::check(directory.archive(), located).unwrap();
    assert_ne!(check.mismatches & mismatch::NAME, 0);
    assert_eq!(check.local_name, b"safe_file.txt");
}
