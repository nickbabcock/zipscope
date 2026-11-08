//! Limits of the copy: the copy is never larger than
//! the archive when deflate beats Zstandard, output past 4 GiB, and extra
//! fields that leave no room for the zip64 field of the copy.

#[path = "support/remux_run.rs"]
mod run;
#[path = "support/remux_zip.rs"]
mod zip;

use run::{left_out, remux, run_job, verify_with_read_module};
use zip::{Entry, Source, build, decode, field, parse};
use zipscope_write::remux::Remux;

/// Text of random words from a small vocabulary. Deflate (with Huffman
/// codes) beats Zstandard level 3 on it by about two times.
fn words(length: usize, seed: u32) -> Vec<u8> {
    const WORDS: [&str; 6] = ["survey", "contour", "legend", "margin", "scale", "sheet"];
    let mut state = seed;
    let mut out = String::new();
    while out.len() < length {
        state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        out.push_str(WORDS[state as usize % WORDS.len()]);
        out.push(' ');
    }
    out.truncate(length);
    out.into_bytes()
}

/// A deflate entry at the best level, as a zip tool writes it.
fn best(name: &str, body: Vec<u8>) -> Entry {
    use std::io::Write;
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(&body).unwrap();
    let mut entry = Entry::deflated(name, body);
    entry.data = Some(encoder.finish().unwrap());
    entry
}

#[test]
fn the_copy_keeps_deflate_when_zstd_is_not_smaller() {
    // One entry that the encoder keeps (at most 4 MiB), and one that it
    // samples.
    let entries = vec![
        best("small.txt", words(2_000_000, 1)),
        best("large.txt", words(6_000_000, 2)),
    ];
    let built = build(&entries);
    let output = remux(&built);
    assert_eq!(output.report.left_out, Vec::new());
    let parsed = parse(&output.bytes);
    let mut source = 0;
    let mut copy = 0;
    for (entry, record) in entries.iter().zip(&parsed.records) {
        let label = String::from_utf8_lossy(&entry.name).into_owned();
        let compressed = entry.compressed_data().len() as u64;
        assert!(
            record.compressed <= compressed,
            "{label}: {} bytes in the copy, {compressed} in the archive",
            record.compressed
        );
        eprintln!(
            "{label}: copy {} method {} source {compressed}",
            record.compressed, record.method
        );
        assert_eq!(record.method, 8, "{label}: deflate is smaller, so it stays");
        assert_eq!(decode(record).as_deref(), Some(entry.body.as_slice()));
        source += compressed;
        copy += record.compressed;
    }
    assert!(copy <= source);
    verify_with_read_module(&output.bytes);
}

#[test]
fn output_past_4_gib_has_zip64_records_and_offsets() {
    let base: u64 = 5 << 30;
    let mut text = Entry::deflated("a.txt", zip::text(100_000, 1));
    text.extra = zip::ut(1_600_000_000);
    let entries = vec![
        text,
        Entry::folder("dir/"),
        Entry::stored("dir/b.bin", zip::noise(5000, 2)),
        // More than 4 MiB: the encoder decodes it two times.
        Entry::deflated("dir/large.txt", zip::text(6 << 20, 3)),
    ];
    let built = build(&entries);
    let source = built.source.clone();
    let mut remux = Remux::open_at(source.clone(), source.size(), base).unwrap();
    let mut bytes = Vec::new();
    for row in 0..remux.rows() {
        let result = run_job(&mut remux, &source, row);
        remux.add(row, result).unwrap();
        bytes.extend(remux.take(usize::MAX));
    }
    let report = remux.finish().unwrap();
    bytes.extend(remux.take(usize::MAX));
    assert!(report.left_out.is_empty(), "{:?}", report.left_out);

    // The copy as a file that starts at 5 GiB (the bytes before read as
    // zero).
    let file = Source::new(base, bytes.clone());
    let mut buffer = vec![0u8; rawzip::RECOMMENDED_BUFFER_SIZE];
    let archive = rawzip::ZipLocator::new()
        .locate_in_reader(file.clone(), &mut buffer, file.size())
        .map_err(|(_, err)| err)
        .unwrap();
    assert!(archive.directory_offset() > u64::from(u32::MAX));
    assert_eq!(archive.entries_hint(), 4);
    // The zip64 end record and its locator come before the end record.
    // The values come from the bytes, not from rawzip, which reads the
    // same fields.
    let get16 = |at: usize| u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap());
    let get32 = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    let get64 = |at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
    let end = bytes.len() - 22;
    assert_eq!(get32(end), 0x0605_4b50);
    let locator = end - 20;
    assert_eq!(get32(locator), 0x0706_4b50);
    let record64 = usize::try_from(get64(locator + 8) - base).unwrap();
    assert_eq!(get32(record64), 0x0606_4b50);
    assert_eq!(get64(record64 + 32), 4, "The zip64 end record count");
    assert_eq!(get64(record64 + 48), archive.directory_offset());
    let mut records = archive.entries(&mut buffer);
    let mut names = Vec::new();
    let mut row = 0;
    while let Some(record) = records.next_entry().unwrap() {
        assert!(record.local_header_offset() >= base);
        let at = usize::try_from(record.central_directory_offset() - base).unwrap();
        let local = usize::try_from(record.local_header_offset() - base).unwrap();
        // A local header is at the offset, and its data decodes to the
        // data of the source.
        assert_eq!(get32(local), 0x0403_4b50, "row {row}");
        let data_at = local + 30 + usize::from(get16(local + 26)) + usize::from(get16(local + 28));
        let size = usize::try_from(record.compressed_size_hint()).unwrap();
        let data = &bytes[data_at..data_at + size];
        assert_eq!(
            decoded(record.compression_method().as_u16(), data),
            entries[row].body,
            "row {row}"
        );
        row += 1;
        // The patched DOS time and date agree in both headers.
        assert_eq!(bytes[at + 12..at + 16], bytes[local + 10..local + 14]);
        // The zip64 field of the record has the offset.
        let extra_at = at + 46 + usize::from(u16::from_le_bytes([bytes[at + 28], bytes[at + 29]]));
        let extra =
            &bytes[extra_at..][..usize::from(u16::from_le_bytes([bytes[at + 30], bytes[at + 31]]))];
        let zip64 = zip::fields(extra)
            .into_iter()
            .find(|(id, _)| *id == 1)
            .expect("A zip64 field");
        assert_eq!(
            u64::from_le_bytes(zip64.1[zip64.1.len() - 8..].try_into().unwrap()),
            record.local_header_offset()
        );
        names.push(record.file_path().as_ref().to_vec());
    }
    assert_eq!(
        names,
        vec![
            b"a.txt".to_vec(),
            b"dir/".to_vec(),
            b"dir/b.bin".to_vec(),
            b"dir/large.txt".to_vec()
        ]
    );
}

/// The data of a row of the copy, decoded.
fn decoded(method: u16, data: &[u8]) -> Vec<u8> {
    use std::io::Read;
    let mut out = Vec::new();
    match method {
        0 => out.extend_from_slice(data),
        8 => {
            flate2::read::DeflateDecoder::new(data)
                .read_to_end(&mut out)
                .unwrap();
        }
        93 => {
            zstd::stream::read::Decoder::new(data)
                .unwrap()
                .read_to_end(&mut out)
                .unwrap();
        }
        _ => panic!("method {method}"),
    }
    out
}

#[test]
fn extra_fields_with_no_room_for_zip64_are_left_out_before_their_data() {
    // 65,530 bytes of extra fields: room for no zip64 field (12 bytes for
    // an offset).
    let mut full = Entry::stored("full.txt", zip::text(1000, 1));
    full.extra = field(0xcafe, &vec![7; 65_526]);
    let entries = vec![full.clone(), Entry::stored("next.txt", zip::text(1000, 2))];
    // At offset 0, the copy needs no zip64 field, so the entry stays.
    let output = remux(&build(&entries));
    assert_eq!(output.report.left_out, Vec::new());
    // At 5 GiB, the entry needs a zip64 offset: it is left out at once,
    // and the copy goes on.
    let built = build(&entries);
    let source = built.source.clone();
    let mut remux = Remux::open_at(source.clone(), source.size(), 5 << 30).unwrap();
    for row in 0..2 {
        let result = run_job(&mut remux, &source, row);
        remux.add(row, result).unwrap();
    }
    let report = remux.finish().unwrap();
    assert!(left_out(&report, 0));
    assert!(
        report.left_out[0].1.contains("zip64"),
        "{:?}",
        report.left_out
    );
    assert!(!left_out(&report, 1));
}
