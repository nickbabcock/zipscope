//! A false zip64 entry count must not make `Ingest::open` allocate for the
//! declared entries. The archive is a
//! central directory of one record, a hole of many GiB, and zip64 end
//! records with a very large count.

use std::io::Write;

use zipscope_core::ingest::{Ingest, Status};
use zipscope_testkit::sparse::SparseBytes;

fn u16le(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn u32le(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn u64le(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn false_count_archive(hole: u64, declared: u64) -> SparseBytes {
    let mut output = SparseBytes::new();
    let name = b"only.txt";
    let mut directory = Vec::new();
    u32le(&mut directory, 0x0201_4b50);
    for value in [45, 45, 0, 0, 0, 0] {
        u16le(&mut directory, value);
    }
    for _ in 0..3 {
        u32le(&mut directory, 0);
    }
    u16le(&mut directory, u16::try_from(name.len()).unwrap());
    for _ in 0..4 {
        u16le(&mut directory, 0);
    }
    u32le(&mut directory, 0);
    u32le(&mut directory, 0);
    directory.extend_from_slice(name);

    // The directory comes first and the hole after it, so the bytes after
    // the directory start do not limit the false count.
    let directory_offset = output.len();
    output.write_all(&directory).unwrap();
    let switch = output.hole_switch();
    switch.set(true);
    let zeros = vec![0u8; 1 << 20];
    for _ in 0..hole / zeros.len() as u64 {
        output.write_all(&zeros).unwrap();
    }
    switch.set(false);
    let end64_offset = output.len();
    let mut end = Vec::new();
    u32le(&mut end, 0x0606_4b50);
    u64le(&mut end, 44);
    u16le(&mut end, 45);
    u16le(&mut end, 45);
    u32le(&mut end, 0);
    u32le(&mut end, 0);
    u64le(&mut end, declared);
    u64le(&mut end, declared);
    u64le(&mut end, directory.len() as u64);
    u64le(&mut end, directory_offset);
    u32le(&mut end, 0x0706_4b50);
    u32le(&mut end, 0);
    u64le(&mut end, end64_offset);
    u32le(&mut end, 1);
    u32le(&mut end, 0x0605_4b50);
    u16le(&mut end, 0);
    u16le(&mut end, 0);
    u16le(&mut end, 0xffff);
    u16le(&mut end, 0xffff);
    u32le(&mut end, u32::MAX);
    u32le(&mut end, u32::MAX);
    u16le(&mut end, 0);
    output.write_all(&end).unwrap();
    output
}

#[test]
fn a_false_zip64_count_does_not_allocate_for_the_declared_entries() {
    for hole in [512 << 20, 12 << 30] {
        let bytes = false_count_archive(hole, 1 << 40);
        let size = bytes.len();
        let mut ingest = Ingest::open(bytes, size).unwrap();
        assert_eq!(ingest.entries_hint(), 1 << 40);
        let opened = ingest.allocated_bytes();
        assert!(opened < 4 << 20, "{opened} bytes after open");
        while ingest.status() == &Status::Parsing {
            ingest.parse(16);
        }
        assert!(ingest.store().rows() <= 1);
        assert!(ingest.allocated_bytes() < 16 << 20);
    }
}
