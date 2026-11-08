//! The heap of the remux. This test binary uses the counting
//! allocator, whose native build caps the live heap. See the ASSUMED API
//! block in `hostile_remux.rs`.
//!
//! The native build of the C zstd library uses `malloc`, so the counts
//! here are the Rust heap only: the buffers of the decoder, the output and
//! the writer. The C encoder context is a fixed size from the level.

#[path = "support/remux_run.rs"]
mod run;
#[path = "support/remux_zip.rs"]
mod zip;

use zip::{Entry, build, decode, parse};
use zipscope_heap::{self as heap, Counting};
use zipscope_write::remux::{Remux, encode};

#[global_allocator]
static ALLOCATOR: Counting = Counting::new();

/// The cap is global, so the tests run one at a time.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The most Rust heap that the remux of one entry can use.
const ROOM: usize = 24 << 20;

/// A sink that keeps only the count of bytes.
#[derive(Debug, Default)]
struct Counter {
    bytes: u64,
}

impl std::io::Write for Counter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.bytes += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Runs `test` with the cap at the live heap and `room` more bytes, and
/// returns its result and the peak above the start.
fn capped<T>(room: usize, test: impl FnOnce(&mut dyn FnMut()) -> T) -> (T, usize) {
    let start = heap::live_bytes();
    let mut peak = 0;
    heap::set_cap(start + room);
    let result = test(&mut || peak = peak.max(heap::live_bytes().saturating_sub(start)));
    heap::set_cap(usize::MAX);
    (result, peak)
}

#[test]
fn an_honest_bomb_streams_below_the_cap() {
    let _serial = SERIAL.lock().unwrap();
    // 96 MiB of zeros in some kilobytes of deflate: more than the cap, so
    // a remux that holds the entry in memory fails.
    let body_length = 96usize << 20;
    let mut entry = Entry::deflated("zeros.bin", Vec::new());
    entry.data = Some({
        use std::io::Write;
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
        let block = vec![0u8; 1 << 20];
        for _ in 0..96 {
            encoder.write_all(&block).unwrap();
        }
        encoder.finish().unwrap()
    });
    entry.crc = Some(zero_crc(body_length));
    entry.uncompressed = Some(body_length as u64);
    let built = build(&[entry]);
    let source = built.source.clone();
    let size = source.size();

    let (result, peak) = capped(ROOM, |sample| {
        let mut remux = Remux::open(source.clone(), size)?;
        sample();
        let job = remux.job(0)?;
        let mut data = Counter::default();
        let encoded = encode(source.clone(), size, &job, &mut data);
        sample();
        assert!(
            data.bytes < 4 << 20,
            "{} bytes of zstd for zeros",
            data.bytes
        );
        Ok::<_, String>(encoded.map(|_| ()))
    });
    result.unwrap().unwrap();
    assert!(peak < ROOM, "peak {peak}");

    // The whole remux, with the output taken after each step.
    let (output, peak) = capped(ROOM, |sample| {
        let mut remux = Remux::open(source.clone(), size).unwrap();
        let job = remux.job(0).unwrap();
        let mut data = Vec::new();
        let encoded = encode(source.clone(), size, &job, &mut data).unwrap();
        sample();
        remux.add(0, Ok((encoded, data))).unwrap();
        let mut bytes = remux.take(usize::MAX);
        sample();
        remux.finish().unwrap();
        bytes.extend(remux.take(usize::MAX));
        sample();
        bytes
    });
    assert!(peak < ROOM, "peak {peak}");
    let parsed = parse(&output);
    assert_eq!(parsed.records[0].uncompressed, body_length as u64);
    assert_eq!(parsed.records[0].method, 93);
    let data = decode(&parsed.records[0]).unwrap();
    assert_eq!(data.len(), body_length);
    assert!(data.iter().all(|&byte| byte == 0));
}

#[test]
fn a_claimed_size_is_never_allocated() {
    let _serial = SERIAL.lock().unwrap();
    // The central directory claims 1 TiB, and the data is 10 bytes. An
    // allocation from the claim aborts the test binary.
    let mut claim = Entry::deflated("claims-1-tib.bin", b"0123456789".to_vec());
    claim.uncompressed = Some(1 << 40);
    let mut stored = Entry::stored("stored-claims-4-gib.bin", b"abc".to_vec());
    stored.uncompressed = Some(u64::from(u32::MAX) + 1);
    stored.compressed = Some(u64::from(u32::MAX) + 1);
    let built = build(&[claim, stored]);
    let source = built.source.clone();
    let size = source.size();
    for row in 0..2 {
        let (result, peak) = capped(ROOM, |sample| {
            let mut remux = Remux::open(source.clone(), size)?;
            let job = remux.job(row)?;
            let mut data = Counter::default();
            let result = encode(source.clone(), size, &job, &mut data);
            sample();
            result.map(|_| ())
        });
        result.expect_err("A false size must fail");
        assert!(peak < ROOM, "row {row}: peak {peak}");
    }
}

#[test]
fn a_full_heap_fails_cleanly() {
    let _serial = SERIAL.lock().unwrap();
    let body = zip::text(16 << 20, 1);
    let built = build(&[Entry::deflated("text.txt", body)]);
    let source = built.source.clone();
    let size = source.size();
    let mut remux = Remux::open(source.clone(), size).unwrap();
    let job = remux.job(0).unwrap();
    // 1 MiB is less than the entry. The remux streams the entry, or it
    // returns an error. It must not abort. The slack pays for small
    // allocations that cannot fail, as in the wasm build.
    heap::set_slack(256 * 1024);
    let (result, _) = capped(1 << 20, |_| {
        let mut data = Counter::default();
        encode(source.clone(), size, &job, &mut data).map(|_| ())
    });
    heap::set_slack(0);
    if let Err(message) = result {
        assert!(message.to_lowercase().contains("memory"), "{message}");
    }
}

/// The CRC-32 of `length` zero bytes.
fn zero_crc(length: usize) -> u32 {
    rawzip::crc32(&vec![0u8; length])
}
