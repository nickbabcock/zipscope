//! Zstandard data of entries: more than one
//! frame, skippable frames, and hostile window sizes, with the C zstd
//! decoder.

mod support;

use support::zip::{Entry, build};
use zipscope_read::directory::Directory;
use zipscope_read::local;
use zipscope_read::stream::{Status, Stream};
use zipscope_read::zstd::MAX_WINDOW_BYTES;

fn open(data: Vec<u8>) -> Directory<Vec<u8>> {
    let size = data.len() as u64;
    Directory::open(data, size).unwrap()
}

/// Starts row 0. A decoder error at the start is a failed status, as the
/// read worker reports it.
fn first_stream(directory: &mut Directory<Vec<u8>>) -> Result<Stream, String> {
    let located = directory.locate(0).unwrap();
    let record = local::read_record(directory.archive(), located).unwrap();
    Stream::open(directory.archive(), 0, located, &record).map_err(|err| err.to_string())
}

/// Reads in calls, as the read worker does: each call can start one frame
/// with a new window.
fn read_up_to(stream: &mut Stream, limit: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut idle = 0;
    while out.len() < limit && stream.status() == &Status::Reading && idle < 2 {
        stream.begin_call();
        if stream.read(&mut out, 64 * 1024) == 0 {
            idle += 1;
        } else {
            idle = 0;
        }
    }
    out
}

fn body(length: usize) -> Vec<u8> {
    (0..length).map(|i| b"abcdefghij\n"[i % 11]).collect()
}

/// An entry of Zstandard data, with the true CRC-32 and size of `body`.
fn zstd_entry(body: Vec<u8>, data: Vec<u8>) -> Entry {
    let mut entry = Entry::zstd("z.txt", body);
    entry.data = Some(data);
    entry
}

/// A skippable frame with `length` bytes of content.
fn skippable(length: u32) -> Vec<u8> {
    let mut frame = 0x184D_2A53u32.to_le_bytes().to_vec();
    frame.extend_from_slice(&length.to_le_bytes());
    frame.extend(std::iter::repeat_n(0xEE, length as usize));
    frame
}

/// A frame of `blocks` RLE blocks of `block` bytes of `a`, with the window
/// descriptor `window`. Each block is 4 bytes of input.
fn rle_frame(window: u8, blocks: usize, block: u32) -> Vec<u8> {
    let mut frame = 0xFD2F_B528u32.to_le_bytes().to_vec();
    // No content size, not a single segment, no checksum, no dictionary.
    frame.push(0);
    frame.push(window);
    for index in 0..blocks {
        let last = u32::from(index + 1 == blocks);
        let header = last | (1 << 1) | (block << 3);
        frame.extend_from_slice(&header.to_le_bytes()[..3]);
        frame.push(b'a');
    }
    frame
}

/// The window descriptor of a window of `2^log` bytes.
fn window_log(log: u8) -> u8 {
    (log - 10) << 3
}

#[test]
fn decodes_all_frames_of_the_data() {
    let first = b"hello".to_vec();
    let second = b" world".to_vec();
    let mut data = zstd::bulk::compress(&first, 3).unwrap();
    data.extend(zstd::bulk::compress(&second, 3).unwrap());
    let mut directory = open(build(&[zstd_entry(b"hello world".to_vec(), data)]));
    let mut stream = first_stream(&mut directory).unwrap();
    assert_eq!(read_up_to(&mut stream, 1 << 20), b"hello world");
    assert_eq!(stream.status(), &Status::Verified);
}

#[test]
fn decodes_many_large_frames_in_steps() {
    let whole = body(300_000);
    let mut data = Vec::new();
    for part in whole.chunks(70_000) {
        data.extend(zstd::bulk::compress(part, 3).unwrap());
    }
    let mut directory = open(build(&[zstd_entry(whole.clone(), data)]));
    let mut stream = first_stream(&mut directory).unwrap();
    let mut out = Vec::new();
    while stream.read(&mut out, 4096) > 0 {}
    assert_eq!(out, whole);
    assert_eq!(stream.status(), &Status::Verified);
}

#[test]
fn skips_skippable_frames() {
    let mut data = skippable(10);
    data.extend(zstd::bulk::compress(b"hello", 3).unwrap());
    data.extend(skippable(0));
    data.extend(zstd::bulk::compress(b" world", 3).unwrap());
    data.extend(skippable(300));
    let mut directory = open(build(&[zstd_entry(b"hello world".to_vec(), data)]));
    let mut stream = first_stream(&mut directory).unwrap();
    assert_eq!(read_up_to(&mut stream, 1 << 20), b"hello world");
    assert_eq!(stream.status(), &Status::Verified);
}

#[test]
fn reports_a_frame_after_the_declared_size() {
    // The central directory gives the size of the first frame only.
    let mut data = zstd::bulk::compress(b"hello", 3).unwrap();
    data.extend(zstd::bulk::compress(b" world", 3).unwrap());
    let mut entry = zstd_entry(b"hello".to_vec(), data);
    entry.uncompressed = Some(5);
    let mut directory = open(build(&[entry]));
    let mut stream = first_stream(&mut directory).unwrap();
    assert_eq!(read_up_to(&mut stream, 1 << 20), b"hello");
    let Status::Failed(message) = stream.status() else {
        panic!("expected a failure, got {:?}", stream.status());
    };
    assert!(message.contains("longer"), "{message}");
}

#[test]
fn reports_a_frame_that_ends_early() {
    let mut data = zstd::bulk::compress(&body(50_000), 3).unwrap();
    data.truncate(data.len() / 2);
    let mut directory = open(build(&[zstd_entry(body(50_000), data)]));
    let mut stream = first_stream(&mut directory).unwrap();
    let out = read_up_to(&mut stream, 1 << 20);
    assert!(out.len() < 50_000);
    assert!(matches!(stream.status(), Status::Failed(_)));
    // A skippable frame that ends early is also an error.
    let mut cut = zstd::bulk::compress(b"hello", 3).unwrap();
    let mut frame = skippable(100);
    frame.truncate(50);
    cut.extend(frame);
    let mut directory = open(build(&[zstd_entry(b"hello".to_vec(), cut)]));
    let mut stream = first_stream(&mut directory).unwrap();
    assert_eq!(read_up_to(&mut stream, 1 << 20), b"hello");
    assert!(matches!(stream.status(), Status::Failed(_)));
}

#[test]
fn decodes_a_window_larger_than_the_entry() {
    // A streaming encoder does not know the size, so its window is the
    // window of the level.
    let whole = body(5000);
    let mut encoder = zstd::stream::Encoder::new(Vec::new(), 19).unwrap();
    std::io::Write::write_all(&mut encoder, &whole).unwrap();
    let data = encoder.finish().unwrap();
    let mut directory = open(build(&[zstd_entry(whole.clone(), data)]));
    let mut stream = first_stream(&mut directory).unwrap();
    assert_eq!(read_up_to(&mut stream, 1 << 20), whole);
    assert_eq!(stream.status(), &Status::Verified);
}

#[test]
fn refuses_a_window_above_the_limit() {
    // A 1 GiB window for an entry that claims 2 GiB.
    for log in [26, 30] {
        let data = rle_frame(window_log(log), 4, 1000);
        let mut entry = zstd_entry(vec![b'a'; 4000], data);
        entry.uncompressed = Some(1 << 31);
        let mut directory = open(build(&[entry]));
        match first_stream(&mut directory) {
            Err(message) => assert!(message.contains("window"), "{message}"),
            Ok(mut stream) => {
                assert_eq!(read_up_to(&mut stream, 1 << 20), b"");
                assert!(matches!(stream.status(), Status::Failed(_)));
            }
        }
    }
    assert_eq!(MAX_WINDOW_BYTES, 1 << 25);
}

#[test]
fn stops_a_small_entry_with_a_large_window_early() {
    // A hostile case: about 4 KiB of RLE blocks make 128 MiB, and
    // the central directory gives one byte.
    let data = rle_frame(window_log(25), 1025, 128 * 1024);
    assert!(data.len() < 4200);
    let mut entry = zstd_entry(b"a".to_vec(), data);
    entry.uncompressed = Some(1);
    let mut directory = open(build(&[entry]));
    let mut stream = first_stream(&mut directory).unwrap();
    let mut out = Vec::new();
    stream.read(&mut out, 1);
    assert_eq!(out, b"a");
    let Status::Failed(message) = stream.status() else {
        panic!("expected a failure, got {:?}", stream.status());
    };
    assert!(message.contains("longer"), "{message}");
}

#[test]
fn refuses_a_single_segment_frame_larger_than_the_entry() {
    // The content size of a single-segment frame is its window. The
    // decoder refuses it at the window limit.
    let mut data = 0xFD2F_B528u32.to_le_bytes().to_vec();
    // A 4-byte content size and a single segment.
    data.push(0x80 | 0x20);
    data.extend_from_slice(&(1u32 << 30).to_le_bytes());
    data.extend_from_slice(&[0x0B, 0, 0, b'a']);
    let mut entry = zstd_entry(b"a".to_vec(), data);
    entry.uncompressed = Some(1);
    let mut directory = open(build(&[entry]));
    match first_stream(&mut directory) {
        Err(message) => panic!("the start must not fail: {message}"),
        Ok(mut stream) => {
            assert!(read_up_to(&mut stream, 1 << 20).len() <= 1);
            assert!(matches!(stream.status(), Status::Failed(_)));
        }
    }
}

mod c {
    use super::*;
    use std::io::Read;
    use zipscope_read::zstd::c::Decoder;

    #[test]
    fn keeps_the_window_memory_below_the_limit() {
        let data = rle_frame(window_log(25), 1025, 128 * 1024);
        let mut decoder = Decoder::new(std::io::Cursor::new(data), 1).unwrap();
        let mut byte = [0u8; 1];
        assert_eq!(decoder.read(&mut byte).unwrap(), 1);
        let limit = usize::try_from(MAX_WINDOW_BYTES).unwrap() + (1 << 20);
        assert!(decoder.memory() < limit, "{}", decoder.memory());

        let refused = rle_frame(window_log(27), 4, 1000);
        let mut decoder = Decoder::new(std::io::Cursor::new(refused), 1).unwrap();
        decoder.read(&mut byte).unwrap_err();
        assert!(decoder.memory() < 1 << 20, "{}", decoder.memory());
    }
}

/// Starts row 0 with a Zstandard window limit.
fn stream_with_window(directory: &mut Directory<Vec<u8>>, window: u64) -> Result<Stream, String> {
    let located = directory.locate(0).unwrap();
    let record = local::read_record(directory.archive(), located).unwrap();
    Stream::open_with_window(directory.archive(), 0, located, &record, window)
        .map_err(|err| err.to_string())
}

#[test]
fn keeps_the_window_below_the_limit_of_the_caller() {
    // The read worker gives a smaller limit when the memory budget leaves
    // less room. The frame asks for a 2 MiB window.
    let data = rle_frame(window_log(21), 4, 1000);
    let mut directory = open(build(&[zstd_entry(vec![b'a'; 4000], data)]));
    let message = stream_with_window(&mut directory, 512).unwrap_err();
    assert!(message.contains("memory"), "{message}");
    let mut stream = stream_with_window(&mut directory, 1 << 20).unwrap();
    let out = read_up_to(&mut stream, 1 << 20);
    // The decoder checks the window of the frame.
    assert_eq!(out, b"");
    assert!(matches!(stream.status(), Status::Failed(_)));
    let mut stream = stream_with_window(&mut directory, 4 << 20).unwrap();
    assert_eq!(read_up_to(&mut stream, 1 << 20), vec![b'a'; 4000]);
    assert_eq!(stream.status(), &Status::Verified);
}

#[test]
fn applies_a_new_window_limit_to_a_later_frame() {
    // The first frame has a 1 MiB window and the second a
    // 16 MiB window. The memory limit becomes smaller between the reads.
    let block = 128 * 1024;
    let mut data = rle_frame(window_log(20), 8, block);
    data.extend(rle_frame(window_log(24), 8, block));
    let body = vec![b'a'; 2 << 20];
    let mut directory = open(build(&[zstd_entry(body.clone(), data)]));

    let mut stream = stream_with_window(&mut directory, 32 << 20).unwrap();
    assert_eq!(read_up_to(&mut stream, 4 << 20), body);
    assert_eq!(stream.status(), &Status::Verified);

    let mut stream = stream_with_window(&mut directory, 32 << 20).unwrap();
    let mut out = Vec::new();
    assert_eq!(stream.read(&mut out, 1 << 20), 1 << 20);
    assert_eq!(stream.status(), &Status::Reading);
    stream.set_window_limit(512 * 1024);
    let rest = read_up_to(&mut stream, 4 << 20);
    assert_eq!(rest, b"");
    let Status::Failed(message) = stream.status() else {
        panic!("expected a failure, got {:?}", stream.status());
    };
    assert!(
        message.contains("window") || message.contains("memory"),
        "{message}"
    );
}

#[test]
fn ends_a_call_before_a_second_new_window() {
    // One call allocates at most one new window. The
    // second frame needs a larger window, so the call ends at the frame
    // boundary with the bytes of the first frame, and the next call goes on.
    let block = 128 * 1024;
    let mut data = rle_frame(window_log(20), 1, block);
    data.extend(rle_frame(window_log(23), 1, block));
    // A third frame with a smaller window needs no new window.
    data.extend(rle_frame(window_log(20), 1, block));
    let body = vec![b'a'; 3 * block as usize];
    let mut directory = open(build(&[zstd_entry(body.clone(), data)]));
    let mut stream = stream_with_window(&mut directory, 32 << 20).unwrap();
    let mut out = Vec::new();
    stream.begin_call();
    assert_eq!(stream.read(&mut out, 1 << 20), block as usize);
    assert_eq!(stream.status(), &Status::Reading);
    stream.begin_call();
    assert_eq!(stream.read(&mut out, 1 << 20), 2 * block as usize);
    assert_eq!(stream.status(), &Status::Verified);
    assert_eq!(out, body);
}
