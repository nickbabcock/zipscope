//! The heap of the zip of an extraction. This test binary uses
//! the counting allocator, whose native build caps the live heap.

use std::io::Cursor;

use zipscope_read::heap::{self, Counting};
use zipscope_read::zipout::{Data, Step, ZipOut};

#[global_allocator]
static ALLOCATOR: Counting = Counting::new();

/// The cap is global, so the tests run one at a time.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn raw(bytes: &[u8]) -> Data {
    Data::Raw {
        reader: Box::new(Cursor::new(bytes.to_vec())),
        method: 0,
        compressed: bytes.len() as u64,
    }
}

const ENTRIES: u64 = 4000;

#[test]
fn an_estimate_holds() {
    let _serial = SERIAL.lock().unwrap();
    let before = heap::live_bytes();
    // Past 4 GiB, each record gets a zip64 extra field in `finish`.
    let mut out = ZipOut::with_offset(ENTRIES, 5 << 30).unwrap();
    let mut names = 0;
    let mut peak = 0;
    for index in 0..ENTRIES {
        let path = format!("folder/entry-{index:06}.txt");
        names += path.len() as u64;
        out.add_file(&path, raw(b"x"), rawzip::crc32(b"x"), 1, None)
            .unwrap();
        assert_eq!(out.step(1 << 16, 0).unwrap(), Step::Done);
        drop(out.take(usize::MAX));
        peak = peak.max(heap::live_bytes() - before);
    }
    out.finish().unwrap();
    peak = peak.max(heap::live_bytes() - before);
    let estimate = ZipOut::estimate(ENTRIES, names);
    assert!(
        peak <= usize::try_from(estimate).unwrap(),
        "{peak} bytes, estimate {estimate}"
    );
}

#[test]
fn a_full_heap_fails_cleanly() {
    let _serial = SERIAL.lock().unwrap();
    let mut out = ZipOut::new(10).unwrap();
    heap::set_cap(heap::live_bytes() + 1024);
    let result = out.add_file("a.txt", raw(b"abc"), 0, 3, None);
    heap::set_cap(usize::MAX);
    let err = result.unwrap_err();
    assert!(err.contains("memory limit"), "{err}");
    heap::set_cap(heap::live_bytes() + 1024);
    let started = ZipOut::new(1 << 20);
    heap::set_cap(usize::MAX);
    started.unwrap_err();
}
