//! Differential test: the Zipscope ingest, rawzip iteration and `zipinfo`
//! must give the same listing for each corpus file.
//!
//! The browser half of this test is `web/e2e/corpus.spec.ts`. It compares
//! the listing in the app with the rawzip listing in `expected.json`.
//!
//! Set `ZIPSCOPE_REQUIRE_ZIPINFO=1` to fail when `zipinfo` is not installed.
//! CI sets it.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use rawzip::FileReader;
use zipscope_core::contract::Column;
use zipscope_core::ingest::{Ingest, Status};
use zipscope_testkit::archives;
use zipscope_testkit::corpus;
use zipscope_testkit::listing::{self, Outcome};

/// Corpus files where `zipinfo` reports an error but lists the same names
/// as rawzip. Info-ZIP tries to repair bad archives and reports what it
/// repaired with exit status 2 or 3.
const ZIPINFO_STATUS_DIVERGENCES: &[(&str, &str)] = &[
    (
        "eocd-undercount.zip",
        "the EOCD entry count is too low; both list all records, then zipinfo reports an error",
    ),
    (
        "omni-mini.ja",
        "both list one entry; rawzip then stops with an error, zipinfo repairs the directory size",
    ),
    (
        "test-badbase.zip",
        "the directory offset is wrong; see the name table below",
    ),
    (
        "test-baddirsz.zip",
        "the directory size is wrong; both list all entries, zipinfo repairs the size",
    ),
];

/// Corpus files where `zipinfo` lists different names, and why. The test
/// does not compare their names.
const ZIPINFO_NAME_DIVERGENCES: &[(&str, &str)] = &[(
    "test-badbase.zip",
    "the directory offset is wrong; rawzip lists both entries, zipinfo moves the base and lists only the second",
)];

/// Corpus files where `zipinfo` shows other local header offsets. Info-ZIP
/// adds the bytes before the archive to the offsets in the records. rawzip
/// and Zipscope keep the offsets as the records give them.
const ZIPINFO_OFFSET_DIVERGENCES: &[(&str, &str)] =
    &[("test-prefix.zip", "43 bytes come before the archive")];

fn reason<'a>(table: &[(&'a str, &'a str)], name: &str) -> Option<&'a str> {
    table
        .iter()
        .find(|(file, _)| *file == name)
        .map(|(_, reason)| *reason)
}

fn tmp_dir() -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("differential");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The columns that the differential test compares.
#[derive(Debug, Clone, PartialEq)]
struct Columns {
    name: String,
    uncompressed_size: f64,
    compressed_size: f64,
    local_header_offset: f64,
    crc32: f64,
    method: f64,
}

impl From<&listing::Entry> for Columns {
    #[expect(
        clippy::cast_precision_loss,
        reason = "The reference uses the same f64 sizes and offsets as the shared store."
    )]
    fn from(entry: &listing::Entry) -> Self {
        Columns {
            name: entry.name.clone(),
            uncompressed_size: entry.uncompressed_size as f64,
            compressed_size: entry.compressed_size as f64,
            local_header_offset: entry.local_header_offset as f64,
            crc32: f64::from(entry.crc32),
            method: f64::from(entry.method),
        }
    }
}

/// Lists a file with the Zipscope ingest, in small batches.
fn ingest(path: &Path) -> (Vec<Columns>, Outcome) {
    let size = std::fs::metadata(path).unwrap().len();
    let reader = FileReader::from(File::open(path).unwrap());
    let mut ingest = match Ingest::open(reader, size) {
        Ok(ingest) => ingest,
        Err(err) => return (Vec::new(), Outcome::NotZip(err.to_string())),
    };
    while *ingest.status() == Status::Parsing {
        ingest.parse(7);
    }
    let store = ingest.store();
    let rows = (0..store.rows())
        .map(|row| Columns {
            name: String::from_utf8(store.name(row).to_vec()).expect("the arena holds UTF-8"),
            uncompressed_size: store.value(row, Column::UncompressedSize),
            compressed_size: store.value(row, Column::CompressedSize),
            local_header_offset: store.value(row, Column::LocalHeaderOffset),
            crc32: store.value(row, Column::Crc32),
            method: store.value(row, Column::Method),
        })
        .collect();
    let outcome = match ingest.status() {
        Status::Complete => Outcome::Complete,
        Status::Failed(message) => Outcome::Failed(message.clone()),
        Status::Parsing => unreachable!(),
    };
    (rows, outcome)
}

/// Returns the corpus files. The tests run in parallel, so the generated
/// files are written one time, before a test reads them.
fn corpus_files() -> Vec<PathBuf> {
    static FILES: OnceLock<Vec<PathBuf>> = OnceLock::new();
    FILES
        .get_or_init(|| {
            let mut files = corpus::rawzip_files().expect("the rawzip corpus");
            assert!(
                files.len() >= 30,
                "the rawzip corpus has only {} files",
                files.len()
            );
            let dir = tmp_dir();
            let mixed = dir.join("mixed.zip");
            archives::write(&mixed, &archives::mixed(1_500).unwrap()).unwrap();
            files.push(mixed);
            let zip64 = dir.join("zip64-sparse.zip");
            archives::zip64_sparse()
                .unwrap()
                .write_to_file(&zip64)
                .unwrap();
            files.push(zip64);
            files
        })
        .clone()
}

fn file_name(path: &Path) -> &str {
    path.file_name().unwrap().to_str().unwrap()
}

/// Returns true when `zipinfo` prints the name as it is on all platforms:
/// printable ASCII. Info-ZIP converts other bytes in a way that changes with
/// the platform and the build.
fn printable_ascii(name: &[u8]) -> bool {
    name.iter().all(|byte| (0x20..0x7f).contains(byte))
}

#[test]
fn ingest_matches_rawzip() {
    for path in corpus_files() {
        let expected = corpus::reference(&path).unwrap();
        let (actual, outcome) = ingest(&path);
        let name = file_name(&path);
        assert_eq!(
            outcome.kind(),
            expected.outcome.kind(),
            "{name}: outcome {outcome:?}, rawzip {:?}",
            expected.outcome
        );
        let expected: Vec<Columns> = expected.entries.iter().map(Columns::from).collect();
        assert_eq!(actual.len(), expected.len(), "{name}: rows");
        for (row, (ours, theirs)) in actual.iter().zip(&expected).enumerate() {
            assert_eq!(ours, theirs, "{name}: row {row}");
        }
    }
}

#[test]
fn rawzip_matches_zipinfo() {
    let required = std::env::var_os("ZIPSCOPE_REQUIRE_ZIPINFO").is_some();
    let mut compared = 0;
    for path in corpus_files() {
        let name = file_name(&path);
        let Some(zipinfo) = listing::zipinfo(&path) else {
            assert!(!required, "zipinfo is not installed");
            eprintln!("zipinfo is not installed; the zipinfo comparison is skipped");
            return;
        };
        let expected = corpus::reference(&path).unwrap();
        if let Outcome::NotZip(_) = expected.outcome {
            // zipinfo exit status 9: the file is not a zip archive.
            assert_eq!(zipinfo.status, 9, "{name}: zipinfo found an archive");
            continue;
        }
        if let Some(reason) = reason(ZIPINFO_STATUS_DIVERGENCES, name) {
            eprintln!(
                "{name}: zipinfo status {} is not compared: {reason}",
                zipinfo.status
            );
        } else {
            // Status 1 is a warning, for example data before the archive.
            assert!(
                zipinfo.status <= 1,
                "{name}: zipinfo status {}",
                zipinfo.status
            );
            assert_eq!(
                expected.outcome,
                Outcome::Complete,
                "{name}: add it to a table"
            );
        }
        if let Some(reason) = reason(ZIPINFO_NAME_DIVERGENCES, name) {
            eprintln!("{name}: names are not compared: {reason}");
            continue;
        }
        let entries = &expected.entries;
        assert_eq!(zipinfo.names.len(), entries.len(), "{name}: entry count");
        assert_eq!(zipinfo.entries.len(), entries.len(), "{name}: -v entries");
        for (row, ours) in entries.iter().enumerate() {
            if printable_ascii(&ours.raw_name) {
                assert_eq!(
                    String::from_utf8_lossy(&zipinfo.names[row]),
                    ours.name,
                    "{name}: row {row}"
                );
            }
            let theirs = &zipinfo.entries[row];
            let check = |column: &str, value: Option<u64>, ours: u64| {
                if let Some(value) = value {
                    assert_eq!(value, ours, "{name}: row {row}: {column}");
                }
            };
            check(
                "uncompressed size",
                theirs.uncompressed_size,
                ours.uncompressed_size,
            );
            check(
                "compressed size",
                theirs.compressed_size,
                ours.compressed_size,
            );
            check("CRC-32", theirs.crc32.map(u64::from), u64::from(ours.crc32));
            check(
                "method",
                theirs.method.map(u64::from),
                u64::from(ours.method),
            );
            if reason(ZIPINFO_OFFSET_DIVERGENCES, name).is_none() {
                check(
                    "local header offset",
                    theirs.local_header_offset,
                    ours.local_header_offset,
                );
            }
        }
        compared += 1;
    }
    eprintln!("compared {compared} files with zipinfo");
}

#[test]
fn zip64_entries_start_past_4_gib() {
    let archive = archives::zip64_sparse().unwrap();
    assert!(archive.len() > 5 << 30);
    assert!(archive.stored_bytes() < 4096);
    let size = archive.len();
    let mut buffer = vec![0; rawzip::RECOMMENDED_BUFFER_SIZE];
    let zip = rawzip::ZipLocator::new()
        .locate_in_reader(&archive, &mut buffer, size)
        .map_err(|(_, err)| err)
        .unwrap();
    assert!(zip.directory_offset() > u64::from(u32::MAX));
    let mut entries = zip.entries(&mut buffer);
    let mut offsets = Vec::new();
    while let Some(entry) = entries.next_entry().unwrap() {
        offsets.push((
            String::from_utf8(entry.file_path().as_bytes().to_vec()).unwrap(),
            entry.local_header_offset(),
            entry.uncompressed_size_hint(),
        ));
    }
    assert_eq!(offsets.len(), 5);
    assert_eq!(offsets[1].0, "large/zeros.bin");
    assert_eq!(offsets[1].2, archives::LARGE_ENTRY_BYTES);
    for (name, offset, _) in &offsets[2..] {
        assert!(*offset > u64::from(u32::MAX), "{name} starts at {offset}");
    }

    // The ingest lists it from the sparse buffer without the 5 GiB.
    let mut ingest = Ingest::open(archive, size).unwrap();
    while *ingest.status() == Status::Parsing {
        ingest.parse(2);
    }
    assert_eq!(*ingest.status(), Status::Complete);
    assert_eq!(ingest.store().rows(), 5);
    assert_eq!(ingest.store().name(3), b"after/past-4gib.txt");
}
