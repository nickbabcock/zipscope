//! Byte map tests, with true and hostile archives.

use std::io::Write;

use rawzip::{ReaderAt, ZipArchiveWriter, ZipLocator};
use zipscope_layout::{
    Builder, EntrySpan, Facts, Kind, Label, Layout, MAX_LISTED_GAPS, Zip64, map,
};

/// The rawzip buffer of the core and the read module.
const BUFFER: usize = 256 * 1024;

/// One entry of a hand-made archive.
#[derive(Clone)]
struct Entry {
    name: Vec<u8>,
    data: Vec<u8>,
    flags: u16,
    /// Bytes after the data: a data descriptor, or junk.
    after: Vec<u8>,
    /// The local header offset in the central directory. `None` gives the
    /// true offset.
    offset: Option<u64>,
    /// The compressed size in the central directory. `None` gives the data
    /// length. A value of 2^32 or more goes in a zip64 extra field.
    compressed: Option<u64>,
    crc: u32,
    /// A false signature for the local header.
    bad_signature: bool,
    /// The local extra field.
    local_extra: Vec<u8>,
}

impl Entry {
    fn new(name: &str, data: &[u8]) -> Entry {
        Entry {
            name: name.as_bytes().to_vec(),
            data: data.to_vec(),
            flags: 0,
            after: Vec::new(),
            offset: None,
            compressed: None,
            crc: rawzip::crc32(data),
            bad_signature: false,
            local_extra: Vec::new(),
        }
    }
}

/// A hand-made archive. Each part can be hostile.
#[derive(Clone, Default)]
struct Archive {
    prelude: Vec<u8>,
    /// Add the prelude length to the offsets, as a self-extractor does.
    shift_offsets: bool,
    entries: Vec<Entry>,
    /// Bytes between the last entry and the central directory.
    before_directory: Vec<u8>,
    /// Write the central-directory records in reverse order.
    reverse: bool,
    /// Bytes between the central directory and the end records.
    after_directory: Vec<u8>,
    zip64: Option<Zip64Options>,
    /// Fields of the end record that differ from the true values.
    disk: u16,
    directory_disk: u16,
    disk_entries: Option<u16>,
    total_entries: Option<u16>,
    comment: Vec<u8>,
    /// A comment length that differs from the comment.
    comment_length: Option<u16>,
    epilogue: Vec<u8>,
}

#[derive(Clone, Copy)]
struct Zip64Options {
    /// Write the "see zip64" markers in the end record.
    markers: bool,
    total_disks: u32,
    record_disk: u32,
    /// A false record offset in the locator.
    false_offset: bool,
    total_entries: Option<u64>,
}

impl Default for Zip64Options {
    fn default() -> Self {
        Zip64Options {
            markers: true,
            total_disks: 1,
            record_disk: 0,
            false_offset: false,
            total_entries: None,
        }
    }
}

fn le16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn le32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn le64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn small(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

impl Archive {
    #[expect(
        clippy::too_many_lines,
        reason = "One function writes the archive in file order."
    )]
    fn build(&self) -> Vec<u8> {
        let mut out = self.prelude.clone();
        // Without `shift_offsets`, the local header offsets do not count
        // the prelude (the central-directory offset does).
        let unshift = if self.shift_offsets {
            0
        } else {
            self.prelude.len() as u64
        };
        let mut records = Vec::new();
        for entry in &self.entries {
            let offset = out.len() as u64;
            let signature = if entry.bad_signature {
                0x1234_5678
            } else {
                0x0403_4b50
            };
            le32(&mut out, signature);
            le16(&mut out, 20);
            le16(&mut out, entry.flags);
            le16(&mut out, 0);
            le32(&mut out, 0);
            le32(&mut out, entry.crc);
            le32(&mut out, small(entry.data.len() as u64));
            le32(&mut out, small(entry.data.len() as u64));
            le16(&mut out, u16::try_from(entry.name.len()).unwrap());
            le16(&mut out, u16::try_from(entry.local_extra.len()).unwrap());
            out.extend_from_slice(&entry.name);
            out.extend_from_slice(&entry.local_extra);
            out.extend_from_slice(&entry.data);
            out.extend_from_slice(&entry.after);

            let offset = entry.offset.unwrap_or(offset - unshift);
            let compressed = entry.compressed.unwrap_or(entry.data.len() as u64);
            let mut extra = Vec::new();
            let big = compressed >= u64::from(u32::MAX) || offset >= u64::from(u32::MAX);
            if big {
                le16(&mut extra, 1);
                le16(&mut extra, 24);
                le64(&mut extra, entry.data.len() as u64);
                le64(&mut extra, compressed);
                le64(&mut extra, offset);
            }
            let mut record = Vec::new();
            le32(&mut record, 0x0201_4b50);
            le16(&mut record, 0x031e);
            le16(&mut record, 20);
            le16(&mut record, entry.flags);
            le16(&mut record, 0);
            le32(&mut record, 0);
            le32(&mut record, entry.crc);
            le32(&mut record, if big { u32::MAX } else { small(compressed) });
            le32(
                &mut record,
                if big {
                    u32::MAX
                } else {
                    small(entry.data.len() as u64)
                },
            );
            le16(&mut record, u16::try_from(entry.name.len()).unwrap());
            le16(&mut record, u16::try_from(extra.len()).unwrap());
            le16(&mut record, 0);
            le16(&mut record, 0);
            le16(&mut record, 0);
            le32(&mut record, 0);
            le32(&mut record, if big { u32::MAX } else { small(offset) });
            record.extend_from_slice(&entry.name);
            record.extend_from_slice(&extra);
            records.push(record);
        }
        if self.reverse {
            records.reverse();
        }
        out.extend_from_slice(&self.before_directory);
        let directory_start = out.len() as u64;
        for record in &records {
            out.extend_from_slice(record);
        }
        let directory_size = out.len() as u64 - directory_start;
        out.extend_from_slice(&self.after_directory);
        let count = u16::try_from(self.entries.len()).unwrap();
        if let Some(zip64) = self.zip64 {
            let record_offset = out.len() as u64;
            let total = zip64.total_entries.unwrap_or(self.entries.len() as u64);
            le32(&mut out, 0x0606_4b50);
            le64(&mut out, 44);
            le16(&mut out, 45);
            le16(&mut out, 45);
            le32(&mut out, zip64.record_disk);
            le32(&mut out, zip64.record_disk);
            le64(&mut out, total);
            le64(&mut out, total);
            le64(&mut out, directory_size);
            le64(&mut out, directory_start);
            le32(&mut out, 0x0706_4b50);
            le32(&mut out, 0);
            le64(
                &mut out,
                if zip64.false_offset {
                    record_offset + 3
                } else {
                    record_offset
                },
            );
            le32(&mut out, zip64.total_disks);
            let markers = zip64.markers;
            le32(&mut out, 0x0605_4b50);
            le16(&mut out, self.disk);
            le16(&mut out, self.directory_disk);
            le16(&mut out, if markers { u16::MAX } else { count });
            le16(&mut out, if markers { u16::MAX } else { count });
            le32(
                &mut out,
                if markers {
                    u32::MAX
                } else {
                    small(directory_size)
                },
            );
            le32(
                &mut out,
                if markers {
                    u32::MAX
                } else {
                    small(directory_start)
                },
            );
        } else {
            le32(&mut out, 0x0605_4b50);
            le16(&mut out, self.disk);
            le16(&mut out, self.directory_disk);
            le16(&mut out, self.disk_entries.unwrap_or(count));
            le16(&mut out, self.total_entries.unwrap_or(count));
            le32(&mut out, small(directory_size));
            le32(&mut out, small(directory_start));
        }
        le16(
            &mut out,
            self.comment_length
                .unwrap_or_else(|| u16::try_from(self.comment.len()).unwrap()),
        );
        out.extend_from_slice(&self.comment);
        out.extend_from_slice(&self.epilogue);
        out
    }
}

/// Writes the data descriptor of an entry.
type Descriptor = dyn Fn(&Entry) -> Vec<u8>;

/// A file of `size` bytes: the archive at its start, then zeros.
struct Front(Vec<u8>, u64);

impl ReaderAt for Front {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        if offset >= self.1 {
            return Ok(0);
        }
        let count = buf
            .len()
            .min(usize::try_from(self.1 - offset).unwrap_or(usize::MAX));
        for (index, byte) in buf[..count].iter_mut().enumerate() {
            let at = usize::try_from(offset).unwrap() + index;
            *byte = self.0.get(at).copied().unwrap_or(0);
        }
        Ok(count)
    }
}

/// A file of `size` bytes: zeros, then `tail` at its end. It lets a test
/// make a file larger than 4 GiB without the memory.
struct Sparse {
    size: u64,
    tail: Vec<u8>,
}

impl ReaderAt for Sparse {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        if offset >= self.size {
            return Ok(0);
        }
        let count = buf
            .len()
            .min(usize::try_from(self.size - offset).unwrap_or(usize::MAX));
        let tail_start = self.size - self.tail.len() as u64;
        for (index, byte) in buf[..count].iter_mut().enumerate() {
            let at = offset + index as u64;
            *byte = if at >= tail_start {
                self.tail[usize::try_from(at - tail_start).unwrap()]
            } else {
                0
            };
        }
        Ok(count)
    }
}

/// The rows of an archive as the store has them: all records that rawzip
/// reads, up to the first error.
fn spans<R: ReaderAt>(archive: &rawzip::ZipArchive<R>) -> Vec<EntrySpan> {
    let mut buffer = vec![0u8; BUFFER];
    let mut entries = archive.entries(&mut buffer);
    let mut rows = Vec::new();
    while let Ok(Some(record)) = entries.next_entry() {
        rows.push(EntrySpan {
            local_header_offset: record.local_header_offset(),
            compressed_size: record.compressed_size_hint(),
            uncompressed_size: record.uncompressed_size_hint(),
            crc32: record.crc32(),
            flags: record.flags().bits(),
        });
    }
    rows
}

fn layout_of<R: ReaderAt>(reader: R, size: u64) -> (Facts, Layout) {
    let mut buffer = vec![0u8; BUFFER];
    let archive = ZipLocator::new()
        .locate_in_reader(reader, &mut buffer, size)
        .map_err(|(_, err)| err)
        .unwrap();
    let rows = spans(&archive);
    let (facts, layout) = map(&archive, size, archive.get_ref(), rows).unwrap();
    layout.validate(size).unwrap();
    (facts, layout)
}

fn layout(data: &[u8]) -> (Facts, Layout) {
    layout_of(data.to_vec(), data.len() as u64)
}

fn kinds(layout: &Layout) -> Vec<Kind> {
    layout.regions.iter().map(|region| region.kind).collect()
}

fn region(layout: &Layout, kind: Kind) -> zipscope_layout::Region {
    *layout
        .regions
        .iter()
        .find(|region| region.kind == kind)
        .unwrap_or_else(|| panic!("no {kind:?} in {:?}", kinds(layout)))
}

fn simple(count: usize) -> Vec<Entry> {
    (0..count)
        .map(|i| Entry::new(&format!("file-{i}.txt"), format!("body {i}").as_bytes()))
        .collect()
}

#[test]
fn a_true_archive_from_the_rawzip_writer_has_no_gaps() {
    let mut output = Vec::new();
    let mut archive = ZipArchiveWriter::new(&mut output);
    for i in 0..20 {
        let (mut entry, config) = archive.new_file(format!("dir/{i}.txt")).start().unwrap();
        let mut writer = config.wrap(&mut entry);
        writer.write_all(&vec![b'a'; i * 37]).unwrap();
        let (_, descriptor) = writer.finish().unwrap();
        entry.finish(descriptor).unwrap();
    }
    archive.finish().unwrap();
    let (facts, layout) = layout(&output);
    assert_eq!(
        kinds(&layout),
        [Kind::Entries, Kind::Directory, Kind::EndRecord]
    );
    assert_eq!(layout.counts.rows, 20);
    assert_eq!(layout.counts.gaps, 0);
    assert_eq!(layout.counts.missing_descriptors, 0);
    assert_eq!(layout.counts.bad_headers, 0);
    assert_eq!(facts.zip64, Zip64::None);
    assert!(!facts.spans_disks());
    assert_eq!(facts.declared_entries, 20);
}

#[test]
fn each_region_has_its_offset_and_size() {
    let archive = Archive {
        prelude: b"#!/bin/sh\nexec unzip \"$0\"\n".to_vec(),
        shift_offsets: true,
        entries: simple(3),
        comment: b"the comment".to_vec(),
        epilogue: b"trailing".to_vec(),
        ..Archive::default()
    };
    let data = archive.build();
    let (facts, layout) = layout(&data);
    assert_eq!(
        kinds(&layout),
        [
            Kind::Prelude,
            Kind::Entries,
            Kind::Directory,
            Kind::EndRecord,
            Kind::Epilogue
        ]
    );
    let prelude = region(&layout, Kind::Prelude);
    assert_eq!((prelude.start, prelude.end), (0, 26));
    assert_eq!(prelude.label, Label::ShellScript);
    let end = region(&layout, Kind::EndRecord);
    assert_eq!(end.start, facts.end_record_offset);
    assert_eq!(end.end - end.start, 22 + 11);
    let epilogue = region(&layout, Kind::Epilogue);
    assert_eq!(
        (epilogue.start, epilogue.end),
        (data.len() as u64 - 8, data.len() as u64)
    );
    assert_eq!(facts.comment, b"the comment");
    let directory = region(&layout, Kind::Directory);
    assert_eq!(directory.start, facts.directory_offset);
    assert_eq!(directory.end, facts.end_record_offset);
}

#[test]
fn the_sniffer_labels_self_extractor_stubs() {
    for (stub, label) in [
        (&b"MZ\x90\x00\x03\x00\x00\x00"[..], Label::WindowsProgram),
        (&b"\x7fELF\x02\x01\x01"[..], Label::LinuxProgram),
        (&[0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1][..], Label::MacProgram),
    ] {
        let mut prelude = stub.to_vec();
        prelude.resize(4096, 0x90);
        let archive = Archive {
            prelude,
            shift_offsets: true,
            entries: simple(2),
            ..Archive::default()
        };
        let (_, layout) = layout(&archive.build());
        let prelude = region(&layout, Kind::Prelude);
        assert_eq!(
            (prelude.start, prelude.end, prelude.label),
            (0, 4096, label)
        );
    }
}

#[test]
fn a_stub_without_shifted_offsets_gives_bad_headers_and_a_gap() {
    // A prefix that the writer did not count: the offsets point into the
    // stub, so no local header is found.
    let archive = Archive {
        prelude: b"MZ this is a stub".to_vec(),
        entries: simple(2),
        ..Archive::default()
    };
    let (_, layout) = layout(&archive.build());
    assert_eq!(layout.counts.bad_headers, 2);
    // The first offset is 0, so the prelude is empty, as in the health
    // report, and the bytes are a gap.
    assert_eq!(kinds(&layout)[0], Kind::Gap);
    assert_eq!(layout.regions[0].label, Label::WindowsProgram);
}

#[test]
fn an_apk_signing_block_before_the_directory_is_a_labeled_gap() {
    let mut block = Vec::new();
    let pairs = vec![7u8; 200];
    let size = (pairs.len() + 8 + 16) as u64;
    le64(&mut block, size);
    block.extend_from_slice(&pairs);
    le64(&mut block, size);
    block.extend_from_slice(b"APK Sig Block 42");
    let archive = Archive {
        entries: simple(4),
        before_directory: block.clone(),
        ..Archive::default()
    };
    let data = archive.build();
    let (facts, layout) = layout(&data);
    let gap = region(&layout, Kind::Gap);
    assert_eq!(gap.end, facts.directory_offset);
    assert_eq!(gap.end - gap.start, block.len() as u64);
    assert_eq!(gap.label, Label::ApkSigningBlock);
}

#[test]
fn a_hidden_entry_between_entries_is_a_gap_with_a_local_header() {
    let mut entries = simple(3);
    // Bytes after entry 0 that start like a local header of an entry
    // that the central directory does not list.
    entries[0].after = b"PK\x03\x04hidden entry data".to_vec();
    let (_, layout) = layout(
        &Archive {
            entries,
            ..Archive::default()
        }
        .build(),
    );
    assert_eq!(
        kinds(&layout),
        [
            Kind::Entries,
            Kind::Gap,
            Kind::Entries,
            Kind::Directory,
            Kind::EndRecord
        ]
    );
    let gap = region(&layout, Kind::Gap);
    assert_eq!(gap.end - gap.start, 21);
    assert_eq!(gap.label, Label::LocalHeader);
    assert_eq!(layout.counts.gaps, 1);
    assert_eq!(layout.counts.gap_bytes, 21);
}

#[test]
fn data_descriptors_in_each_form_are_entry_data() {
    let mut entries = simple(4);
    let forms: [&Descriptor; 4] = [
        &|e| {
            let mut d = Vec::new();
            le32(&mut d, 0x0807_4b50);
            le32(&mut d, e.crc);
            le32(&mut d, small(e.data.len() as u64));
            le32(&mut d, small(e.data.len() as u64));
            d
        },
        &|e| {
            let mut d = Vec::new();
            le32(&mut d, e.crc);
            le32(&mut d, small(e.data.len() as u64));
            le32(&mut d, small(e.data.len() as u64));
            d
        },
        &|e| {
            let mut d = Vec::new();
            le32(&mut d, 0x0807_4b50);
            le32(&mut d, e.crc);
            le64(&mut d, e.data.len() as u64);
            le64(&mut d, e.data.len() as u64);
            d
        },
        &|e| {
            let mut d = Vec::new();
            le32(&mut d, e.crc);
            le64(&mut d, e.data.len() as u64);
            le64(&mut d, e.data.len() as u64);
            d
        },
    ];
    for (entry, form) in entries.iter_mut().zip(forms) {
        entry.flags = 8;
        entry.after = form(entry);
    }
    let (_, layout) = layout(
        &Archive {
            entries,
            ..Archive::default()
        }
        .build(),
    );
    assert_eq!(layout.counts.gaps, 0, "{:?}", layout.regions);
    assert_eq!(layout.counts.missing_descriptors, 0);
}

#[test]
fn a_missing_descriptor_is_counted_and_its_bytes_are_a_gap() {
    let mut entries = simple(2);
    entries[0].flags = 8;
    entries[0].after = b"junk junk junk".to_vec();
    let (_, layout) = layout(
        &Archive {
            entries,
            ..Archive::default()
        }
        .build(),
    );
    assert_eq!(layout.counts.missing_descriptors, 1);
    assert_eq!(layout.counts.gap_bytes, 14);
}

#[test]
fn local_extra_fields_count_as_entry_data() {
    let mut entries = simple(2);
    entries[1].local_extra = vec![0xaa; 300];
    let (_, layout) = layout(
        &Archive {
            entries,
            ..Archive::default()
        }
        .build(),
    );
    assert_eq!(layout.counts.gaps, 0);
}

#[test]
fn overlapping_entries_do_not_make_overlapping_regions() {
    let mut entries = simple(3);
    // Two records point at the local header of entry 0 (the
    // overlapping-file zip bomb).
    entries[2].offset = Some(0);
    entries[2].data = entries[0].data.clone();
    entries[2].name = entries[0].name.clone();
    entries[2].crc = entries[0].crc;
    let (_, layout) = layout(
        &Archive {
            entries,
            ..Archive::default()
        }
        .build(),
    );
    assert_eq!(layout.counts.overlapping, 1);
    // The bytes of entry 2 that no record uses are a gap.
    assert_eq!(layout.counts.gaps, 1);
}

#[test]
fn rows_out_of_order_give_the_same_map() {
    let base = Archive {
        entries: simple(50),
        ..Archive::default()
    };
    let reversed = Archive {
        reverse: true,
        ..base.clone()
    };
    let (_, a) = layout(&base.build());
    let (_, b) = layout(&reversed.build());
    assert_eq!(a.regions, b.regions);
    assert_eq!(a.counts.overlapping, 0);
    assert_eq!(b.counts.overlapping, 0);
}

#[test]
fn offsets_out_of_range_use_no_bytes() {
    let mut entries = simple(4);
    // Into the central directory, past the end of the file, and a
    // compressed size that runs past the end of all files.
    entries[1].offset = Some(u64::from(u32::MAX) + 10);
    entries[2].compressed = Some(u64::MAX);
    entries[3].offset = Some(1 << 40);
    let data = Archive {
        entries,
        ..Archive::default()
    }
    .build();
    let (facts, layout) = layout(&data);
    assert_eq!(layout.counts.past_directory, 2);
    assert_eq!(layout.counts.into_directory, 1);
    // Entry 2 covers all bytes to the directory, so the bytes of entry 3
    // are not a gap.
    let last = layout
        .regions
        .iter()
        .rfind(|region| region.kind == Kind::Entries)
        .unwrap();
    assert_eq!(last.end, facts.directory_offset);
    assert_eq!(layout.counts.gaps, 1, "the bytes of entry 1 are a gap");
}

#[test]
fn a_bad_local_header_is_counted_and_its_bytes_are_a_gap() {
    let mut entries = simple(3);
    entries[1].bad_signature = true;
    let (_, layout) = layout(
        &Archive {
            entries,
            ..Archive::default()
        }
        .build(),
    );
    assert_eq!(layout.counts.bad_headers, 1);
    assert_eq!(layout.counts.gaps, 1);
}

#[test]
fn more_gaps_than_the_list_holds_fold_into_the_entry_data() {
    let mut entries = simple(1000);
    for (index, entry) in entries.iter_mut().enumerate() {
        entry.after = vec![0; 1 + index % 3];
    }
    // One large gap must be listed.
    entries[700].after = vec![0xee; 5000];
    let (_, layout) = layout(
        &Archive {
            entries,
            ..Archive::default()
        }
        .build(),
    );
    // The last entry is followed by the directory, so its bytes are the
    // last gap, which is always listed.
    assert_eq!(layout.counts.gaps, 1000);
    let listed: Vec<_> = layout
        .regions
        .iter()
        .filter(|region| region.kind == Kind::Gap)
        .collect();
    assert_eq!(listed.len(), MAX_LISTED_GAPS + 1);
    assert!(listed.iter().any(|gap| gap.end - gap.start == 5000));
    let folded: u64 = layout.regions.iter().map(|region| region.folded_gaps).sum();
    assert_eq!(folded, 1000 - listed.len() as u64);
}

#[test]
fn declared_and_found_counts_can_differ() {
    let archive = Archive {
        entries: simple(2),
        total_entries: Some(9),
        disk_entries: Some(9),
        ..Archive::default()
    };
    let (facts, layout) = layout(&archive.build());
    assert_eq!(facts.declared_entries, 9);
    assert_eq!(layout.counts.rows, 2);
    assert!(!facts.spans_disks());
}

#[test]
fn multi_disk_fields_flag_a_spanned_archive() {
    let archive = Archive {
        entries: simple(2),
        disk: 2,
        directory_disk: 2,
        ..Archive::default()
    };
    let (facts, _) = layout(&archive.build());
    assert!(facts.spans_disks());
    assert_eq!(facts.end_record.disk, 2);

    let archive = Archive {
        entries: simple(2),
        disk_entries: Some(1),
        ..Archive::default()
    };
    assert!(layout(&archive.build()).0.spans_disks());

    let archive = Archive {
        entries: simple(2),
        zip64: Some(Zip64Options {
            total_disks: 3,
            ..Zip64Options::default()
        }),
        ..Archive::default()
    };
    let (facts, _) = layout(&archive.build());
    assert_eq!(facts.zip64, Zip64::Used);
    assert!(facts.spans_disks());
}

#[test]
fn a_zip64_end_record_and_locator_are_regions() {
    let archive = Archive {
        entries: simple(3),
        zip64: Some(Zip64Options {
            total_entries: Some(3),
            ..Zip64Options::default()
        }),
        ..Archive::default()
    };
    let data = archive.build();
    let (facts, layout) = layout(&data);
    assert_eq!(facts.zip64, Zip64::Used);
    assert_eq!(
        kinds(&layout),
        [
            Kind::Entries,
            Kind::Directory,
            Kind::Zip64Record,
            Kind::Zip64Locator,
            Kind::EndRecord
        ]
    );
    assert_eq!(
        region(&layout, Kind::Zip64Record).end - region(&layout, Kind::Zip64Record).start,
        56
    );
    assert_eq!(
        region(&layout, Kind::Zip64Locator).end - region(&layout, Kind::Zip64Locator).start,
        20
    );
    assert_eq!(facts.record.unwrap().total_entries, 3);
    assert_eq!(facts.declared_entries, 3);
}

#[test]
fn a_zip64_record_without_the_markers_is_used_when_it_agrees() {
    // The end record holds real values, not 0xffff markers, and the zip64
    // record gives the same values. rawzip uses the zip64 record.
    let archive = Archive {
        entries: simple(2),
        zip64: Some(Zip64Options {
            markers: false,
            ..Zip64Options::default()
        }),
        ..Archive::default()
    };
    let (facts, _) = layout(&archive.build());
    assert_eq!(facts.zip64, Zip64::Used);
    assert_ne!(facts.end_record.total_entries, u16::MAX);
}

#[test]
fn a_zip64_locator_that_does_not_agree_is_ignored() {
    // The locator points 3 bytes past the record, so rawzip reads the
    // classic end record, whose markers then fail to open... unless the
    // values are real. Use real values.
    let archive = Archive {
        entries: simple(2),
        zip64: Some(Zip64Options {
            markers: false,
            false_offset: true,
            ..Zip64Options::default()
        }),
        ..Archive::default()
    };
    let data = archive.build();
    let (facts, layout) = layout(&data);
    assert_eq!(facts.zip64, Zip64::Ignored);
    assert!(facts.locator.is_some());
    // The bytes of the zip64 records are in the central directory, as
    // rawzip reads it.
    assert_eq!(
        kinds(&layout),
        [Kind::Entries, Kind::Directory, Kind::EndRecord]
    );
}

#[test]
fn a_comment_length_past_the_end_of_the_file_does_not_open() {
    let archive = Archive {
        entries: simple(2),
        comment: b"short".to_vec(),
        comment_length: Some(500),
        ..Archive::default()
    };
    let data = archive.build();
    let mut buffer = vec![0u8; BUFFER];
    let found = ZipLocator::new().locate_in_reader(data.clone(), &mut buffer, data.len() as u64);
    // rawzip refuses the end record. If a later rawzip opens it, the map
    // must still hold.
    if let Ok(archive) = found {
        let rows = spans(&archive);
        let (_, layout) = map(&archive, data.len() as u64, &data, rows).unwrap();
        layout.validate(data.len() as u64).unwrap();
    }
}

#[test]
fn bytes_between_the_directory_and_the_end_record_are_in_the_directory() {
    let archive = Archive {
        entries: simple(2),
        after_directory: b"PK\x05\x05sig".to_vec(),
        ..Archive::default()
    };
    let data = archive.build();
    let (facts, layout) = layout(&data);
    let directory = region(&layout, Kind::Directory);
    assert_eq!(directory.end, facts.end_record_offset);
}

#[test]
fn an_archive_without_entries_is_prelude_directory_and_end() {
    let archive = Archive {
        prelude: vec![0; 100],
        ..Archive::default()
    };
    let (_, layout) = layout(&archive.build());
    assert_eq!(kinds(&layout), [Kind::Prelude, Kind::EndRecord]);
    assert_eq!(layout.regions[0].label, Label::Zeros);
}

#[test]
fn a_prelude_larger_than_4_gib_uses_64_bit_offsets() {
    let prelude = 5u64 << 30;
    // The archive at the end of a sparse file, with zip64 offsets.
    let mut entries = simple(2);
    let mut at = prelude;
    for entry in &mut entries {
        entry.offset = Some(at);
        at += 30 + entry.name.len() as u64 + entry.data.len() as u64;
    }
    let tail = Archive {
        entries,
        zip64: Some(Zip64Options::default()),
        epilogue: vec![1; 10],
        ..Archive::default()
    }
    .build();
    // `build` wrote the directory offset from the start of the tail. Make
    // the zip64 record give the true offset.
    let mut tail = tail;
    let size = prelude + tail.len() as u64;
    let directory_in_tail = tail
        .windows(4)
        .position(|window| window == [0x50, 0x4b, 0x01, 0x02])
        .unwrap() as u64;
    let record = tail
        .windows(4)
        .position(|window| window == [0x50, 0x4b, 0x06, 0x06])
        .unwrap();
    tail[record + 48..record + 56].copy_from_slice(&(prelude + directory_in_tail).to_le_bytes());
    let locator = tail
        .windows(4)
        .position(|window| window == [0x50, 0x4b, 0x06, 0x07])
        .unwrap();
    tail[locator + 8..locator + 16].copy_from_slice(&(prelude + record as u64).to_le_bytes());
    let (facts, layout) = layout_of(Sparse { size, tail }, size);
    assert_eq!(facts.zip64, Zip64::Used);
    assert_eq!(facts.directory_offset, prelude + directory_in_tail);
    let first = region(&layout, Kind::Prelude);
    assert_eq!(
        (first.start, first.end, first.label),
        (0, prelude, Label::Zeros)
    );
    assert_eq!(layout.counts.gaps, 0);
    assert_eq!(layout.counts.bad_headers, 0);
    let epilogue = region(&layout, Kind::Epilogue);
    assert_eq!((epilogue.start, epilogue.end), (size - 10, size));
}

#[test]
fn a_huge_epilogue_is_one_region() {
    let archive = Archive {
        entries: simple(2),
        ..Archive::default()
    }
    .build();
    let size = 6u64 << 30;
    // rawzip looks for the end record only near the end of the file, so a
    // 6 GiB epilogue is not a zip. Check the map with the end that the
    // archive gives.
    let mut buffer = vec![0u8; BUFFER];
    let opened =
        ZipLocator::new().locate_in_reader(Front(archive.clone(), size), &mut buffer, size);
    assert!(opened.is_err());
    let small = archive.len() as u64 + 10_000;
    let (_, layout) = layout_of(Front(archive, small), small);
    let epilogue = region(&layout, Kind::Epilogue);
    assert_eq!(epilogue.end - epilogue.start, 10_000);
    assert_eq!(epilogue.label, Label::Zeros);
}

#[test]
fn the_builder_counts_its_memory() {
    let data = Archive {
        entries: simple(10),
        ..Archive::default()
    }
    .build();
    let mut buffer = vec![0u8; BUFFER];
    let archive = ZipLocator::new()
        .locate_in_reader(data.clone(), &mut buffer, data.len() as u64)
        .map_err(|(_, err)| err)
        .unwrap();
    let facts = Facts::read(&archive, data.len() as u64).unwrap();
    let mut builder = Builder::new(&facts);
    builder.reserve(10).unwrap();
    let reserved = builder.allocated_bytes();
    assert_eq!(reserved, 160);
    for span in spans(&archive) {
        builder.add(&data, &data, span).unwrap();
    }
    assert_eq!(builder.allocated_bytes(), reserved);
    let layout = builder.finish(&data, &facts).unwrap();
    layout.validate(data.len() as u64).unwrap();
}
