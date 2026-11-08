//! Check verification at the declared end of an entry.
//! Use the public reader API. No new API is assumed.

#[path = "support/zip.rs"]
mod zip;

use zip::{Entry, build};
use zipscope_read::directory::Directory;
use zipscope_read::local;
use zipscope_read::stream::{Status, Stream};

fn stream(mut entry: Entry) -> Stream {
    if entry.method == 20 && entry.data.is_none() {
        entry.data = Some(zstd::bulk::compress(&entry.body, 3).unwrap());
    }
    let bytes = build(&[entry]);
    let mut directory = Directory::open(bytes.clone(), bytes.len() as u64).unwrap();
    let located = directory.locate(0).unwrap();
    assert_eq!(
        local::check(directory.archive(), located)
            .unwrap()
            .mismatches,
        0
    );
    let record = local::read_record(directory.archive(), located).unwrap();
    Stream::open(directory.archive(), 0, located, &record).unwrap()
}

fn drain(stream: &mut Stream, maximum: usize) -> Vec<u8> {
    let mut output = Vec::new();
    for _ in 0..1024 {
        stream.begin_call();
        let before = output.len();
        let count = stream.read(&mut output, maximum);
        assert_eq!(output.len() - before, count);
        assert!(count <= maximum);
        if stream.status() != &Status::Reading {
            return output;
        }
    }
    panic!("The reader did not stop");
}

fn failed(stream: &Stream) -> &str {
    match stream.status() {
        Status::Failed(message) => message,
        state => panic!("Expected a failure, got {state:?}"),
    }
}

#[test]
fn excess_output_never_reaches_the_sink_for_any_supported_method() {
    for method in [0, 8, 20, 93] {
        for declared in [0, 1, 7, 4096] {
            let mut entry = Entry::new("bomb", method, vec![b'a'; 128 * 1024]);
            entry.uncompressed = Some(declared);
            let mut source = stream(entry);
            let output = drain(&mut source, 16 * 1024);
            assert!(
                output.len() as u64 <= declared,
                "method {method}, declared {declared}"
            );
            failed(&source);
            let mut after = Vec::new();
            assert_eq!(source.read(&mut after, 16 * 1024), 0);
            assert_eq!(after, [] as [u8; 0]);
        }
    }
}

#[test]
fn exact_size_is_not_success_when_the_crc_is_false() {
    for method in [0, 8, 20, 93] {
        for length in [0, 1, 4096, 4097] {
            let mut entry = Entry::new("bad-crc", method, vec![b'z'; length]);
            entry.crc = Some(rawzip::crc32(&entry.body) ^ 1);
            let mut source = stream(entry);
            let output = drain(&mut source, 4096);
            assert!(output.len() <= length);
            assert!(
                failed(&source).contains("CRC-32"),
                "method {method}, length {length}"
            );
        }
    }
}

#[test]
fn an_exact_chunk_boundary_checks_the_end_without_another_output_chunk() {
    for method in [0, 8, 20, 93] {
        let body = vec![b'x'; 4096];
        let mut source = stream(Entry::new("ok", method, body.clone()));
        let output = drain(&mut source, body.len());
        assert_eq!(output, body);
        assert_eq!(source.status(), &Status::Verified);
        let mut after = Vec::new();
        assert_eq!(source.read(&mut after, 1), 0);
        assert_eq!(source.status(), &Status::Verified);
    }
}

#[test]
fn a_short_decode_is_a_failure_even_when_its_crc_matches_the_real_data() {
    for method in [0, 8, 20, 93] {
        let mut entry = Entry::new("short", method, b"short".to_vec());
        entry.uncompressed = Some(6);
        let mut source = stream(entry);
        let output = drain(&mut source, 2);
        assert!(output.len() <= 5);
        failed(&source);
    }
}

#[test]
fn zero_bytes_are_verified_instead_of_assumed_to_be_valid() {
    for method in [0, 8, 20, 93] {
        let mut source = stream(Entry::new("empty", method, Vec::new()));
        assert_eq!(drain(&mut source, 4096), [] as [u8; 0]);
        assert_eq!(source.status(), &Status::Verified);
    }
}
