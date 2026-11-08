//! The memory cap of the read module. The
//! large buffers of the read module fail cleanly at the cap, with an error
//! and no abort. This test binary uses the counting allocator, whose
//! native build caps the live heap.

mod support;

use support::zip::{Entry, build};
use zipscope_read::directory::Directory;
use zipscope_read::heap::{self, Counting};
use zipscope_read::local;
use zipscope_read::stream::{Status, Stream};

#[global_allocator]
static ALLOCATOR: Counting = Counting::new();

/// The cap is global, so the tests run one at a time.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Runs `test` with the cap at the live heap and `room` more bytes.
fn with_room<T>(room: usize, test: impl FnOnce() -> T) -> T {
    heap::set_cap(heap::live_bytes() + room);
    let result = test();
    heap::set_cap(usize::MAX);
    result
}

#[test]
fn a_read_past_the_cap_fails_cleanly() {
    let _serial = SERIAL.lock().unwrap();
    let body = vec![b'a'; 4 << 20];
    let data = build(&[Entry::stored("big.txt", body.clone())]);
    let size = data.len() as u64;
    let mut directory = Directory::open(data, size).unwrap();
    let located = directory.locate(0).unwrap();
    let record = local::read_record(directory.archive(), located).unwrap();
    let mut stream = Stream::open(directory.archive(), 0, located, &record).unwrap();
    let mut out = Vec::new();
    let read = with_room(1 << 20, || stream.read(&mut out, 4 << 20));
    assert_eq!(read, 0);
    let Status::Failed(message) = stream.status() else {
        panic!("expected a failure, got {:?}", stream.status());
    };
    assert!(message.contains("memory limit"), "{message}");
    // A new stream with room reads the entry.
    let mut stream = Stream::open(directory.archive(), 0, located, &record).unwrap();
    let mut out = Vec::new();
    assert_eq!(stream.read(&mut out, 4 << 20), 4 << 20);
    assert_eq!(stream.status(), &Status::Verified);
}

#[test]
fn the_table_stops_at_the_cap_and_goes_on_with_room() {
    let _serial = SERIAL.lock().unwrap();
    let entries: Vec<Entry> = (0..20_000)
        .map(|i| Entry::stored(format!("{i}.txt"), Vec::new()))
        .collect();
    let data = build(&entries);
    let size = data.len() as u64;
    let mut directory = Directory::open(data, size).unwrap();
    let (added, located) = with_room(1024, || (directory.scan(16_384), directory.locate(10)));
    assert_eq!(added, 0);
    assert_eq!(located, None);
    assert_eq!(directory.rows(), 0);
    // The pass is not failed: with room, it reads the rows.
    assert_eq!(directory.scan(16_384), 16_384);
    assert!(directory.locate(19_999).is_some());
}
