/*
ASSUMED API (crate zipscope-write, module `remux`)

pub struct Remux<R>;           // the coordinator: one ordered output stream
impl<R: rawzip::ReaderAt + 'static> Remux<R> {
    /// Reads the central directory of the source archive.
    pub fn open(reader: R, size: u64) -> Result<Remux<R>, String>;
    /// The rows of the source central directory.
    pub fn rows(&self) -> usize;
    /// The work of one row for a pool worker. An error leaves the row out
    /// (the caller gives the error to `add`).
    pub fn job(&mut self, row: usize) -> Result<Job, String>;
    /// Gives the result of one row. Results come in any order (the pool
    /// has uneven entries); the output keeps the source row order. A row
    /// that comes two times, or a row that does not exist, is an error.
    /// An `Err` result leaves the row out and puts it in the report.
    pub fn add(&mut self, row: usize, result: Result<(Encoded, Vec<u8>), String>)
        -> Result<(), String>;
    /// Takes up to `max` bytes of output that are ready, in order.
    pub fn take(&mut self, max: usize) -> Vec<u8>;
    /// Writes the central directory and the end records. An error when a
    /// row did not come; then no end record is written.
    pub fn finish(&mut self) -> Result<Report, String>;
}

#[derive(Clone, Debug)] pub struct Job;      // Send + 'static
#[derive(Clone, Debug)] pub struct Encoded;  // Send + 'static

/// Runs one job in a pool worker. It opens the source again, decodes the
/// data through rawzip's verifying reader, and writes the new compressed
/// data to `out` in steps (not one buffer of the entry). It recompresses
/// with Zstandard (method 93), stores already-compressed formats, or copies
/// the compressed bytes unchanged.
pub fn encode<R: rawzip::ReaderAt>(reader: R, size: u64, job: &Job, out: &mut dyn std::io::Write)
    -> Result<Encoded, String>;

#[derive(Debug)]
pub struct Report { pub left_out: Vec<(usize, String)> }  // row, reason

Dev-dependencies that the tests need in crates/write/Cargo.toml:
flate2, rawzip, zstd (decode only, to read outputs), zipscope-core,
zipscope-read, zipscope-heap.

The implementer can rename to fit. Do not weaken an expectation without a
written reason.

Rules that the tests pin (from the spec):
- The output is a strict zip: entries from offset 0, no gaps, no overlap,
  no bytes before the first entry or after the end record. The existing
  core and read module parse and verify it.
- Names (raw bytes), comments, timestamps, extra fields, CRC-32 and sizes
  stay the same. A DOS-only time does not get a time zone.
- Text becomes method 93. Already-compressed formats (jpg, mp4, zip) and
  data that does not get smaller do not become method 93.
- A source entry that does not verify (CRC-32, size, local header) is
  never written as a good entry. The report lists it.
- No allocation is sized from a claim. A bomb stops at its declared size.
*/

#[path = "support/remux_run.rs"]
mod run;
#[path = "support/remux_zip.rs"]
mod zip;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use run::{
    assert_healthy, ingest, ingest_source, left_out, remux, run_job, shown, try_remux,
    verify_with_read_module,
};
use zip::{
    Built, Descriptor, Entry, Options, Source, aes, build, build_with, decode, field, fields,
    fields_without_zip64, noise, ntfs, parse, text, unicode_path, ut, zstd_frames,
};
use zipscope_write::remux::{Remux, encode};

const ZSTD: u16 = 93;

/// The record of the output with this exact name. Panics when there is
/// not exactly one.
fn only<'a>(parsed: &'a zip::Parsed, name: &[u8]) -> &'a zip::Record {
    let mut found = parsed.records.iter().filter(|record| record.name == name);
    let record = found
        .next()
        .unwrap_or_else(|| panic!("No output entry {}", String::from_utf8_lossy(name)));
    assert!(
        found.next().is_none(),
        "Two output entries {}",
        String::from_utf8_lossy(name)
    );
    record
}

fn metadata_entries() -> Vec<Entry> {
    let mut entries = Vec::new();

    let mut text_entry = Entry::deflated("docs/readme.txt", text(200_000, 1));
    text_entry.comment = b"entry comment".to_vec();
    text_entry.extra = ut(1_600_000_000);
    text_entry.local_extra = ut(1_600_000_000);
    entries.push(text_entry);

    // NTFS time with milliseconds: a remux that writes only UT seconds
    // loses them.
    let mut ntfs_entry = Entry::stored("docs/ntfs.txt", text(5000, 2));
    ntfs_entry.extra = ntfs(1_600_000_000_123);
    entries.push(ntfs_entry);

    // DOS time only: no time zone.
    let mut dos_entry = Entry::stored("dos-only.txt", text(3000, 3));
    dos_entry.extra = Vec::new();
    entries.push(dos_entry);

    // An unknown field in the central directory and a different one in
    // the local header.
    let mut custom = Entry::deflated("custom.bin", text(4000, 4));
    custom.extra = field(0xCAFE, b"central only");
    custom.local_extra = field(0xBEEF, b"local only");
    entries.push(custom);

    // A CP437 name (not UTF-8, no flag) with a Unicode Path field.
    let cp437 = b"caf\x82.txt".to_vec();
    let mut cp437_entry = Entry::stored(cp437.clone(), text(1000, 5));
    cp437_entry.extra = unicode_path(&cp437, "café.txt");
    entries.push(cp437_entry);

    // A CP437 name without a Unicode Path field.
    entries.push(Entry::stored(b"\x81ber.txt", text(1000, 6)));

    // A UTF-8 name with the UTF-8 flag.
    let mut utf8 = Entry::stored("naïve/ünïcode.txt", text(1000, 7));
    utf8.flags = 0x0800;
    entries.push(utf8);

    entries.push(Entry::folder("empty-folder/"));
    entries.push(Entry::stored("empty.txt", Vec::new()));
    let mut zero = Entry::deflated("empty-deflate.txt", Vec::new());
    zero.comment = "comment with ünïcode".as_bytes().to_vec();
    entries.push(zero);
    entries
}

#[test]
fn the_output_round_trips_names_comments_times_extra_fields_sizes_and_crc() {
    let entries = metadata_entries();
    let built = build_with(
        &entries,
        &Options {
            comment: b"archive comment".to_vec(),
            ..Options::default()
        },
    );
    let output = remux(&built);
    assert!(
        output.report.left_out.is_empty(),
        "{:?}",
        output.report.left_out
    );
    let parsed = parse(&output.bytes);
    assert_eq!(parsed.comment, b"archive comment");
    assert_eq!(parsed.records.len(), entries.len());

    for (entry, record) in entries.iter().zip(&parsed.records) {
        let label = String::from_utf8_lossy(&entry.name).into_owned();
        assert_eq!(record.name, entry.name, "{label}: name bytes");
        assert_eq!(record.local_name, entry.name, "{label}: local name");
        assert_eq!(record.comment, entry.comment, "{label}: comment");
        assert_eq!(record.crc, entry.true_crc(), "{label}: CRC-32");
        assert_eq!(
            record.uncompressed,
            entry.body.len() as u64,
            "{label}: size"
        );
        assert_eq!(
            (record.time, record.date),
            (entry.time, entry.date),
            "{label}: DOS time"
        );
        assert_eq!(
            fields_without_zip64(&record.extra),
            fields(&entry.extra),
            "{label}: central extra fields"
        );
        assert_eq!(
            fields_without_zip64(&record.local_extra),
            fields(&entry.local_extra),
            "{label}: local extra fields"
        );
        assert_eq!(
            record.flags & 0x0800,
            entry.flags & 0x0800,
            "{label}: UTF-8 flag"
        );
        assert_eq!(
            decode(record).as_deref(),
            Some(entry.body.as_slice()),
            "{label}: data"
        );
    }
    let folder = only(&parsed, b"empty-folder/");
    assert_eq!(
        (folder.method, folder.compressed, folder.uncompressed),
        (0, 0, 0)
    );

    // The core shows the same name, comment, time, time kind and CRC-32.
    let before = ingest_source(&built);
    let after = ingest(&output.bytes);
    assert_healthy(&after.health());
    assert_eq!(after.store().rows(), before.store().rows());
    for row in 0..entries.len() {
        assert_eq!(shown(&after, row), shown(&before, row), "row {row}");
    }

    // The read module verifies each entry.
    let data = verify_with_read_module(&output.bytes);
    for (entry, data) in entries.iter().zip(data) {
        assert_eq!(data.as_deref(), Some(entry.body.as_slice()));
    }
}

#[test]
fn compressible_entries_become_zstd_with_a_window_the_read_module_accepts() {
    // 36 MB is more than the read module window (32 MiB): an encoder with
    // a larger window or long mode makes frames the read module refuses.
    let large = text(36 << 20, 11);
    let entries = vec![
        Entry::deflated("small.txt", text(64 * 1024, 10)),
        Entry::stored("large.txt", large.clone()),
    ];
    let output = remux(&build(&entries));
    let parsed = parse(&output.bytes);
    for (entry, record) in entries.iter().zip(&parsed.records) {
        assert_eq!(
            record.method,
            ZSTD,
            "{}",
            String::from_utf8_lossy(&entry.name)
        );
        assert!(record.compressed < record.uncompressed / 4);
        let frames = zstd_frames(&record.data);
        assert_ne!(frames.len(), 0);
        let mut end = 0;
        for start in frames {
            let magic = u32::from_le_bytes(record.data[start..start + 4].try_into().unwrap());
            // A skippable frame (for example a seek table) has no window.
            if magic & 0xFFFF_FFF0 != 0x184D_2A50 {
                let window = zipscope_read::zstd::header_window(&record.data[start..])
                    .expect("A frame header");
                assert!(
                    window <= zipscope_read::zstd::MAX_WINDOW_BYTES,
                    "window {window}"
                );
            }
            end =
                start + zstd::zstd_safe::find_frame_compressed_size(&record.data[start..]).unwrap();
        }
        assert_eq!(end, record.data.len(), "Bytes after the last frame");
    }
    let data = verify_with_read_module(&output.bytes);
    assert_eq!(data[1].as_deref(), Some(large.as_slice()));
}

#[test]
fn data_that_does_not_get_smaller_is_not_grown() {
    let entries = vec![
        Entry::stored("random.bin", noise(256 * 1024, 1)),
        Entry::deflated("random-deflated.bin", noise(256 * 1024, 2)),
        Entry::stored("tiny.txt", b"x".to_vec()),
    ];
    let output = remux(&build(&entries));
    let parsed = parse(&output.bytes);
    for (entry, record) in entries.iter().zip(&parsed.records) {
        assert!(
            record.compressed <= record.uncompressed,
            "{}: {} compressed bytes for {} bytes",
            String::from_utf8_lossy(&entry.name),
            record.compressed,
            record.uncompressed
        );
        assert_eq!(decode(record).as_deref(), Some(entry.body.as_slice()));
    }
    verify_with_read_module(&output.bytes);
}

#[test]
fn already_compressed_formats_are_stored_as_is_and_not_recompressed() {
    // The bodies are text, so only the name can make the choice.
    let names: [&[u8]; 6] = [
        b"photos/a.jpg",
        b"photos/B.JPG",
        b"photos/c.jpeg",
        b"video/clip.mp4",
        b"nested/inner.zip",
        b"nested/INNER.ZIP",
    ];
    let mut entries = Vec::new();
    for (index, name) in names.iter().enumerate() {
        let body = text(50_000, index as u64);
        entries.push(if index % 2 == 0 {
            Entry::stored(name, body)
        } else {
            Entry::deflated(name, body)
        });
    }
    let output = remux(&build(&entries));
    assert_eq!(output.report.left_out.len(), 0);
    let parsed = parse(&output.bytes);
    for (entry, record) in entries.iter().zip(&parsed.records) {
        let label = String::from_utf8_lossy(&entry.name).into_owned();
        assert_ne!(record.method, ZSTD, "{label} was recompressed");
        assert!(
            record.method == 0 || record.method == entry.method,
            "{label}: method {}",
            record.method
        );
        if record.method == entry.method {
            assert_eq!(record.data, entry.compressed_data(), "{label}: not as-is");
        }
        assert_eq!(
            decode(record).as_deref(),
            Some(entry.body.as_slice()),
            "{label}"
        );
    }
    verify_with_read_module(&output.bytes);
}

#[test]
fn entries_that_are_already_zstd_are_copied_unchanged() {
    let entries = vec![
        Entry::zstd("z93.txt", text(100_000, 1)),
        Entry::new("z20.txt", 20, text(100_000, 2)),
        // A frame with a high level: a decode and encode again changes it.
        {
            let body = text(100_000, 3);
            let mut entry = Entry::zstd("z93-level19.txt", body.clone());
            entry.data = Some(zstd::bulk::compress(&body, 19).unwrap());
            entry
        },
    ];
    let output = remux(&build(&entries));
    let parsed = parse(&output.bytes);
    for (entry, record) in entries.iter().zip(&parsed.records) {
        let label = String::from_utf8_lossy(&entry.name).into_owned();
        assert!(
            record.method == ZSTD || record.method == entry.method,
            "{label}"
        );
        assert_eq!(
            record.data,
            entry.compressed_data(),
            "{label}: data changed"
        );
        assert_eq!(record.crc, entry.true_crc(), "{label}");
    }
    verify_with_read_module(&output.bytes);
}

/// An encrypted or unknown entry is copied byte for byte with its method,
/// flags, CRC-32 and extra fields, or it is left out and reported. It never
/// gets method 93.
fn assert_copied_or_left_out(entries: &[Entry], rows: &[usize]) {
    let output = remux(&build(entries));
    let parsed = parse(&output.bytes);
    for &row in rows {
        let entry = &entries[row];
        let label = String::from_utf8_lossy(&entry.name).into_owned();
        let found: Vec<_> = parsed
            .records
            .iter()
            .filter(|r| r.name == entry.name)
            .collect();
        if found.is_empty() {
            assert!(
                left_out(&output.report, row),
                "{label}: missing but not reported"
            );
            continue;
        }
        assert!(
            !left_out(&output.report, row),
            "{label}: written and reported"
        );
        let record = found[0];
        assert_eq!(record.method, entry.method, "{label}: method");
        assert_eq!(
            record.flags & 0x0001,
            entry.flags & 0x0001,
            "{label}: encryption flag"
        );
        assert_eq!(record.data, entry.compressed_data(), "{label}: data");
        assert_eq!(
            record.crc,
            entry.crc.unwrap_or_else(|| entry.true_crc()),
            "{label}: CRC-32"
        );
        assert_eq!(
            record.uncompressed,
            entry.body.len() as u64,
            "{label}: size"
        );
        assert_eq!(
            fields_without_zip64(&record.extra),
            fields(&entry.extra),
            "{label}: extra"
        );
    }
    // The other entries are still good.
    for (row, entry) in entries.iter().enumerate() {
        if !rows.contains(&row) {
            assert_eq!(
                decode(only(&parsed, &entry.name)).as_deref(),
                Some(entry.body.as_slice())
            );
        }
    }
    verify_with_read_module(&output.bytes);
}

#[test]
fn encrypted_entries_are_copied_raw_or_left_out() {
    let mut zipcrypto = Entry::deflated("secret/zipcrypto.txt", text(1000, 1));
    zipcrypto.flags = 0x0001;
    // 12 header bytes and the "encrypted" data.
    zipcrypto.data = Some(noise(12 + 400, 9));
    let mut aes_entry = Entry::new("secret/aes.txt", 99, text(1000, 2));
    aes_entry.flags = 0x0001;
    aes_entry.data = Some(noise(16 + 2 + 500 + 10, 10));
    aes_entry.extra = aes(2, 3, 8);
    aes_entry.local_extra = aes(2, 3, 8);
    aes_entry.crc = Some(0);
    let entries = vec![
        Entry::stored("plain.txt", text(1000, 3)),
        zipcrypto,
        aes_entry,
    ];
    assert_copied_or_left_out(&entries, &[1, 2]);
}

#[test]
fn unknown_methods_are_copied_raw_or_left_out() {
    let mut entries = vec![Entry::stored("plain.txt", text(1000, 1))];
    for (index, method) in [9u16, 12, 14, 95, 98].into_iter().enumerate() {
        let mut entry = Entry::new(
            format!("method-{method}.bin"),
            method,
            text(500, index as u64),
        );
        entry.data = Some(noise(300, index as u64 + 20));
        entries.push(entry);
    }
    assert_copied_or_left_out(&entries, &[1, 2, 3, 4, 5]);
}

#[test]
fn a_false_crc_is_never_written_as_a_good_entry() {
    let mut entries = vec![Entry::stored("good.txt", text(2000, 1))];
    for (method, name) in [
        (0u16, "bad-stored.txt"),
        (8, "bad-deflate.txt"),
        (93, "bad-zstd.txt"),
        (20, "bad-zstd20.txt"),
        (8, "bad-photo.jpg"),
        (0, "bad-empty.txt"),
    ] {
        let body = if name == "bad-empty.txt" {
            Vec::new()
        } else {
            text(70_000, u64::from(method))
        };
        let mut entry = Entry::new(name, method, body);
        entry.crc = Some(entry.true_crc() ^ 0x0100_0001);
        entries.push(entry);
    }
    entries.push(Entry::deflated("good-after.txt", text(2000, 2)));
    let built = build(&entries);
    let output = remux(&built);
    let parsed = parse(&output.bytes);
    for (row, entry) in entries.iter().enumerate().skip(1).take(6) {
        let label = String::from_utf8_lossy(&entry.name).into_owned();
        assert!(left_out(&output.report, row), "{label}: not reported");
        // A copy may stay only as the same bytes with the same false
        // CRC-32, so that each reader still sees the fault.
        if let Some(record) = parsed.records.iter().find(|r| r.name == entry.name) {
            assert_eq!(
                record.crc,
                entry.crc.unwrap(),
                "{label}: a new CRC-32 hides the fault"
            );
            assert_eq!(record.method, entry.method, "{label}");
            assert_eq!(record.data, entry.compressed_data(), "{label}");
        }
    }
    for name in [&b"good.txt"[..], b"good-after.txt"] {
        let record = only(&parsed, name);
        assert_eq!(record.crc, rawzip::crc32(&decode(record).unwrap()));
    }
}

/// A source that counts the bytes read in `from..to`.
#[derive(Debug, Clone)]
struct Counted {
    inner: Source,
    from: u64,
    to: u64,
    read: Arc<AtomicU64>,
}

impl rawzip::ReaderAt for Counted {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        let read = self.inner.read_at(buf, offset)?;
        let start = offset.max(self.from);
        let end = (offset + read as u64).min(self.to);
        if end > start {
            self.read.fetch_add(end - start, Ordering::Relaxed);
        }
        Ok(read)
    }
}

#[test]
fn a_bomb_stops_at_its_declared_size() {
    // The data decodes to 4 MiB, but the central directory gives 4096
    // bytes. The decoder must stop after 4097 bytes; it must not read all
    // of the compressed data first.
    let body = noise(4 << 20, 77);
    let mut bomb = Entry::deflated("bomb.bin", body.clone());
    bomb.uncompressed = Some(4096);
    let mut bomb_zstd = Entry::zstd("bomb.zst.txt", text(4 << 20, 78));
    bomb_zstd.uncompressed = Some(4096);
    let entries = vec![Entry::stored("first.txt", text(100, 1)), bomb, bomb_zstd];
    let built = build(&entries);

    for row in [1, 2] {
        let read = Arc::new(AtomicU64::new(0));
        let counted = Counted {
            inner: built.source.clone(),
            from: built.offsets[row],
            to: built.offsets[row]
                + 30
                + entries[row].name.len() as u64
                + entries[row].compressed_data().len() as u64,
            read: Arc::clone(&read),
        };
        let size = built.source.size();
        let mut remux = Remux::open(counted.clone(), size).unwrap();
        let result = remux.job(row).and_then(|job| {
            let mut out = Vec::new();
            let encoded = encode(counted.clone(), size, &job, &mut out);
            assert!(
                out.len() < 256 * 1024,
                "row {row}: {} bytes of output",
                out.len()
            );
            encoded
        });
        result.expect_err("A bomb must fail");
        let read = read.load(Ordering::Relaxed);
        assert!(read < 2 << 20, "row {row}: read {read} bytes of a bomb");
    }
    let output = remux(&built);
    assert!(left_out(&output.report, 1) && left_out(&output.report, 2));
    let parsed = parse(&output.bytes);
    assert!(parsed.records.iter().all(|r| r.name == b"first.txt"));
}

#[test]
fn a_declared_size_longer_than_the_data_is_left_out() {
    let mut short = Entry::deflated("short.txt", text(10_000, 1));
    short.uncompressed = Some(10_001);
    let mut stored_short = Entry::stored("stored-short.txt", text(10_000, 2));
    stored_short.uncompressed = Some(20_000);
    let mut zip64_claim = Entry::deflated("claims-1-tib.txt", text(10, 3));
    zip64_claim.uncompressed = Some(1 << 40);
    let entries = vec![
        short,
        stored_short,
        zip64_claim,
        Entry::stored("ok.txt", text(10, 4)),
    ];
    let output = remux(&build(&entries));
    let parsed = parse(&output.bytes);
    for (row, entry) in entries.iter().enumerate().take(3) {
        assert!(left_out(&output.report, row), "row {row}");
        assert!(
            parsed.records.iter().all(|r| r.name != entry.name),
            "row {row}"
        );
    }
    assert_eq!(parsed.records.len(), 1);
}

#[test]
fn a_local_header_that_disagrees_is_left_out() {
    let mut name = Entry::stored("listed.txt", text(1000, 1));
    name.local_name = Some(b"hidden.exe".to_vec());
    let mut method = Entry::stored("method.txt", text(1000, 2));
    method.local_method = Some(8);
    let entries = vec![name, method, Entry::stored("ok.txt", text(10, 3))];
    let output = remux(&build(&entries));
    assert!(left_out(&output.report, 0));
    assert!(left_out(&output.report, 1));
    let parsed = parse(&output.bytes);
    assert_eq!(parsed.records.len(), 1);
    assert_eq!(parsed.records[0].name, b"ok.txt");
    assert!(parsed.records.iter().all(|r| r.local_name != b"hidden.exe"));
}

#[test]
fn data_descriptors_signed_and_unsigned_round_trip() {
    let mut entries = Vec::new();
    for (index, descriptor) in [Descriptor::Signed, Descriptor::Unsigned]
        .into_iter()
        .enumerate()
    {
        for method in [0u16, 8, 93] {
            // A stored entry with a data descriptor is valid only with a
            // known size; the central directory gives it.
            let mut entry = Entry::new(
                format!("dd-{index}-{method}.txt"),
                method,
                text(30_000 + index * 7 + usize::from(method), u64::from(method)),
            );
            entry.descriptor = descriptor;
            entries.push(entry);
        }
    }
    let output = remux(&build(&entries));
    assert!(
        output.report.left_out.is_empty(),
        "{:?}",
        output.report.left_out
    );
    let parsed = parse(&output.bytes);
    assert_eq!(parsed.records.len(), entries.len());
    for (entry, record) in entries.iter().zip(&parsed.records) {
        assert_eq!(record.name, entry.name);
        assert_eq!(decode(record).as_deref(), Some(entry.body.as_slice()));
    }
    verify_with_read_module(&output.bytes);
}

#[test]
fn duplicate_names_keep_each_entry_in_order() {
    let entries = vec![
        Entry::stored("same.txt", text(1000, 1)),
        Entry::deflated("same.txt", text(2000, 2)),
        Entry::stored("other.txt", text(10, 3)),
        Entry::stored("same.txt", text(3000, 4)),
        Entry::stored("SAME.txt", text(4000, 5)),
    ];
    let output = remux(&build(&entries));
    let parsed = parse(&output.bytes);
    assert_eq!(parsed.records.len(), entries.len());
    for (entry, record) in entries.iter().zip(&parsed.records) {
        assert_eq!(record.name, entry.name);
        assert_eq!(decode(record).as_deref(), Some(entry.body.as_slice()));
    }
}

#[test]
fn records_that_share_one_local_header_do_not_overlap_in_the_output() {
    let mut entries = vec![Entry::deflated("bomb/zeros.bin", vec![0; 1 << 20])];
    for index in 0..3 {
        let mut alias = Entry::deflated(format!("bomb/alias-{index}.bin"), vec![0; 1 << 20]);
        alias.share = Some(0);
        entries.push(alias);
    }
    let output = remux(&build(&entries));
    // `parse` fails on an overlap or a gap.
    let parsed = parse(&output.bytes);
    for (row, entry) in entries.iter().enumerate() {
        match parsed.records.iter().find(|r| r.name == entry.name) {
            Some(record) => assert_eq!(decode(record).as_deref(), Some(entry.body.as_slice())),
            None => assert!(left_out(&output.report, row), "row {row}"),
        }
    }
    assert_healthy(&ingest(&output.bytes).health());
}

#[test]
fn names_are_copied_byte_for_byte_and_not_sanitized() {
    // A remux is a copy, not an extraction: it keeps each name.
    let names: [&[u8]; 7] = [
        b"../evil.txt",
        b"/absolute.txt",
        b"dir\\backslash.txt",
        b"./dot/./name.txt",
        b"a//double.txt",
        b"CON",
        b"trailing-space.txt ",
    ];
    let entries: Vec<Entry> = names
        .iter()
        .enumerate()
        .map(|(index, name)| Entry::stored(name, text(100, index as u64)))
        .collect();
    let output = remux(&build(&entries));
    let parsed = parse(&output.bytes);
    let found: Vec<&[u8]> = parsed.records.iter().map(|r| r.name.as_slice()).collect();
    assert_eq!(found, names);
    for record in &parsed.records {
        assert_eq!(record.local_name, record.name);
    }
}

#[test]
fn unix_modes_and_symlinks_stay() {
    let mut link = Entry::stored("link", b"target/file.txt".to_vec());
    link.attributes = 0o120_777 << 16;
    let mut script = Entry::stored("run.sh", b"#!/bin/sh\necho hi\n".to_vec());
    script.attributes = 0o100_755 << 16;
    let mut dos = Entry::stored("READONLY.TXT", text(100, 1));
    dos.made_by = 0x0014;
    dos.attributes = 0x01 | 0x20;
    let entries = vec![link, script, dos];
    let output = remux(&build(&entries));
    let parsed = parse(&output.bytes);
    for (entry, record) in entries.iter().zip(&parsed.records) {
        let label = String::from_utf8_lossy(&entry.name).into_owned();
        assert_eq!(record.attributes, entry.attributes, "{label}: attributes");
        assert_eq!(
            record.made_by >> 8,
            entry.made_by >> 8,
            "{label}: host system"
        );
        assert_eq!(
            decode(record).as_deref(),
            Some(entry.body.as_slice()),
            "{label}"
        );
    }
}

#[test]
fn a_prelude_and_trailing_bytes_are_not_copied() {
    let entries = vec![
        Entry::stored("a.txt", text(100, 1)),
        Entry::deflated("b.txt", text(100, 2)),
    ];
    let built = build_with(
        &entries,
        &Options {
            prelude: b"#!/bin/sh\nexec unzip \"$0\"\n".repeat(20),
            ..Options::default()
        },
    );
    let output = remux(&built);
    let parsed = parse(&output.bytes);
    assert_eq!(parsed.records.len(), 2);
    assert_eq!(parsed.records[0].offset, 0);
    assert_healthy(&ingest(&output.bytes).health());
}

#[test]
fn an_empty_archive_gives_an_empty_zip() {
    let output = remux(&build(&[]));
    let parsed = parse(&output.bytes);
    assert_eq!(parsed.records.len(), 0);
    assert_healthy(&ingest(&output.bytes).health());
}

#[test]
fn more_than_65535_entries_get_zip64_end_records() {
    const COUNT: usize = 65_600;
    let entries: Vec<Entry> = (0..COUNT)
        .map(|index| {
            let mut entry = Entry::stored(format!("e/{index:05}"), Vec::new());
            entry.attributes = 0;
            entry
        })
        .collect();
    let built = build(&entries);
    let output = remux(&built);
    let parsed = parse(&output.bytes);
    assert!(parsed.zip64, "No zip64 end records");
    assert_eq!(parsed.records.len(), COUNT);
    for (index, record) in parsed.records.iter().enumerate() {
        assert_eq!(record.name, format!("e/{index:05}").as_bytes());
    }
    let after = ingest(&output.bytes);
    assert_eq!(after.store().rows(), COUNT);
    assert_healthy(&after.health());
}

#[test]
fn a_source_past_4_gib_is_read_through_zip64_offsets() {
    // The archive starts at 5 GiB of a sparse source. Each local header
    // offset is past 4 GiB, in a zip64 field.
    let entries = vec![
        Entry::deflated("far/a.txt", text(50_000, 1)),
        Entry::stored("far/b.txt", text(10, 2)),
        {
            let mut entry = Entry::stored("far/zip64-sizes.txt", text(100, 3));
            entry.force_zip64 = true;
            entry
        },
    ];
    let built = build_with(
        &entries,
        &Options {
            base: 5 << 30,
            ..Options::default()
        },
    );
    assert!(
        built
            .offsets
            .iter()
            .all(|&offset| offset > u64::from(u32::MAX))
    );
    let output = remux(&built);
    assert!(
        output.report.left_out.is_empty(),
        "{:?}",
        output.report.left_out
    );
    let parsed = parse(&output.bytes);
    for (entry, record) in entries.iter().zip(&parsed.records) {
        assert_eq!(record.name, entry.name);
        assert_eq!(decode(record).as_deref(), Some(entry.body.as_slice()));
    }
    verify_with_read_module(&output.bytes);
}

fn pool_entries() -> Vec<Entry> {
    // Uneven sizes: the first entry is the slowest.
    let mut entries = vec![Entry::deflated("0-large.txt", text(6 << 20, 0))];
    for index in 1..16 {
        let length = if index % 5 == 0 { 1 << 20 } else { 100 * index };
        entries.push(Entry::deflated(
            format!("{index}-entry.txt"),
            text(length, index as u64),
        ));
    }
    entries.push(Entry::stored("16-photo.jpg", noise(1000, 3)));
    entries.push(Entry::folder("17-folder/"));
    entries
}

fn assert_in_source_order(entries: &[Entry], bytes: &[u8]) {
    let parsed = parse(bytes);
    assert_eq!(parsed.records.len(), entries.len());
    let mut last = None;
    for (entry, record) in entries.iter().zip(&parsed.records) {
        assert_eq!(record.name, entry.name);
        assert_eq!(decode(record).as_deref(), Some(entry.body.as_slice()));
        // The data is in row order too, not only the directory.
        assert!(last.is_none_or(|offset| record.offset > offset));
        last = Some(record.offset);
    }
    verify_with_read_module(bytes);
}

#[test]
fn a_worker_pool_with_uneven_entries_writes_in_source_order() {
    let entries = pool_entries();
    let built = build(&entries);
    let source = built.source.clone();
    let mut remux = Remux::open(source.clone(), source.size()).unwrap();
    let jobs: Vec<_> = (0..remux.rows()).map(|row| (row, remux.job(row))).collect();
    let (sender, receiver) = std::sync::mpsc::channel();
    let jobs = std::sync::Mutex::new(jobs.into_iter());
    std::thread::scope(|scope| {
        for _ in 0..4 {
            let sender = sender.clone();
            let source = source.clone();
            let jobs = &jobs;
            scope.spawn(move || {
                loop {
                    let Some((row, job)) = jobs.lock().unwrap().next() else {
                        break;
                    };
                    let result = job.and_then(|job| {
                        let mut data = Vec::new();
                        encode(source.clone(), source.size(), &job, &mut data).map(|e| (e, data))
                    });
                    sender.send((row, result)).unwrap();
                }
            });
        }
    });
    drop(sender);
    let mut done: Vec<_> = receiver.into_iter().collect();
    // The slow first row comes last, as from a real pool.
    done.sort_by_key(|(row, _)| std::cmp::Reverse(*row));
    let mut bytes = Vec::new();
    for (row, result) in done {
        remux.add(row, result).unwrap();
        bytes.extend(remux.take(usize::MAX));
    }
    let report = remux.finish().unwrap();
    bytes.extend(remux.take(usize::MAX));
    assert!(report.left_out.is_empty(), "{:?}", report.left_out);
    assert_in_source_order(&entries, &bytes);

    // The pool result is the same bytes as a remux one row at a time.
    assert_eq!(bytes, remux_bytes(&built));
}

fn remux_bytes(built: &Built) -> Vec<u8> {
    remux(built).bytes
}

#[test]
fn a_later_row_waits_for_the_rows_before_it() {
    let entries = pool_entries();
    let built = build(&entries);
    let source = built.source.clone();
    let mut remux = Remux::open(source.clone(), source.size()).unwrap();
    let first = run_job(&mut remux, &source, 0);
    let last = entries.len() - 1;
    for row in (1..=last).rev() {
        let result = run_job(&mut remux, &source, row);
        remux.add(row, result).unwrap();
        assert!(
            remux.take(usize::MAX).is_empty(),
            "Row {row} came out before row 0"
        );
    }
    remux.add(0, first).unwrap();
    let mut bytes = remux.take(usize::MAX);
    assert_ne!(bytes.len(), 0);
    remux.finish().unwrap();
    bytes.extend(remux.take(usize::MAX));
    assert_in_source_order(&entries, &bytes);
}

#[test]
fn a_row_that_comes_two_times_or_does_not_exist_is_an_error() {
    let entries = vec![
        Entry::stored("a.txt", text(10, 1)),
        Entry::stored("b.txt", text(10, 2)),
    ];
    let built = build(&entries);
    let source = built.source.clone();
    let mut remux = Remux::open(source.clone(), source.size()).unwrap();
    let a = run_job(&mut remux, &source, 0);
    let again = run_job(&mut remux, &source, 0);
    remux.add(0, a).unwrap();
    remux.add(0, again).expect_err("Row 0 two times");
    let b = run_job(&mut remux, &source, 1);
    remux.add(2, b.clone()).expect_err("Row 2 does not exist");
    remux.add(1, b).unwrap();
    remux.finish().unwrap();
}

fn has_end_records(bytes: &[u8]) -> bool {
    [zip::END, zip::END64, zip::LOCATOR64]
        .iter()
        .any(|signature| {
            bytes
                .windows(4)
                .any(|window| window == signature.to_le_bytes())
        })
}

#[test]
fn a_cancelled_remux_leaves_no_output_that_looks_complete() {
    let entries = pool_entries();
    let built = build(&entries);
    let source = built.source.clone();
    let mut remux = Remux::open(source.clone(), source.size()).unwrap();
    let mut bytes = Vec::new();
    for row in 0..entries.len() / 2 {
        let result = run_job(&mut remux, &source, row);
        remux.add(row, result).unwrap();
        bytes.extend(remux.take(usize::MAX));
    }
    // A finish with rows missing fails and adds no end record.
    remux.finish().expect_err("Rows are missing");
    bytes.extend(remux.take(usize::MAX));
    drop(remux);
    assert_ne!(bytes.len(), 0);
    assert!(
        !has_end_records(&bytes),
        "The partial output has end records"
    );
    let Err(_) = rawzip::ZipArchive::from_slice(&bytes) else {
        panic!("rawzip reads the partial output");
    };
    let Err(_) =
        zipscope_core::ingest::Ingest::open(Source::new(0, bytes.clone()), bytes.len() as u64)
    else {
        panic!("The core reads the partial output");
    };
}

#[test]
fn a_failed_row_is_reported_and_the_rest_is_a_good_zip() {
    let mut bad = Entry::deflated("bad.txt", text(5000, 1));
    bad.crc = Some(1);
    let entries = vec![
        Entry::stored("a.txt", text(10, 2)),
        bad,
        Entry::stored("c.txt", text(10, 3)),
    ];
    let built = build(&entries);
    match try_remux(&built) {
        Ok(output) => {
            assert!(left_out(&output.report, 1));
            assert!(
                output
                    .report
                    .left_out
                    .iter()
                    .all(|(_, reason)| !reason.is_empty())
            );
            let parsed = parse(&output.bytes);
            assert!(
                parsed
                    .records
                    .iter()
                    .all(|r| r.name != b"bad.txt" || r.crc == 1)
            );
            verify_with_read_module(&output.bytes)
                .iter()
                .zip(&parsed.records)
                .filter(|(_, record)| record.name != b"bad.txt")
                .for_each(|(data, _)| assert!(data.is_some()));
        }
        // A remux that stops at the first fault is also safe, when it
        // writes no end record (see the cancel test).
        Err(message) => assert_ne!(message.len(), 0),
    }
}

#[test]
fn every_byte_of_a_good_source_entry_matters() {
    // Change one byte of the compressed data of each entry: the remux
    // must find it (CRC-32 or decode error) and not write it as good.
    let entries = vec![
        Entry::stored("s.txt", text(3000, 1)),
        Entry::deflated("d.txt", text(3000, 2)),
        Entry::zstd("z.txt", text(3000, 3)),
    ];
    let built = build(&entries);
    for (row, entry) in entries.iter().enumerate() {
        let data_at = usize::try_from(built.offsets[row]).unwrap() + 30 + entry.name.len();
        let at = data_at + entry.compressed_data().len() / 2;
        let changed = Built {
            source: built.source.with_byte(at, built.source.tail()[at] ^ 0x5a),
            offsets: built.offsets.clone(),
        };
        let Ok(output) = try_remux(&changed) else {
            continue;
        };
        let parsed = parse(&output.bytes);
        assert!(left_out(&output.report, row), "row {row}: not reported");
        if let Some(record) = parsed.records.iter().find(|r| r.name == entry.name) {
            // Only an unchanged raw copy with the old CRC-32 can stay, so
            // that each verifying reader still finds the fault.
            assert_eq!(record.crc, entry.true_crc(), "row {row}");
            assert_eq!(record.method, entry.method, "row {row}");
            assert_eq!(
                record.data,
                changed.source.tail()[data_at..data_at + record.data.len()],
                "row {row}"
            );
        }
    }
}
