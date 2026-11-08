//! Health findings of rawzip's `assets/` archives, used as integration
//! fixtures. Each archive gives exactly the findings in the table below, and
//! no other finding.

use zipscope_core::contract::health;
use zipscope_core::ingest::{Ingest, Status};
use zipscope_testkit::corpus;

/// Findings that are not 0: (file, [(field, value)]).
const EXPECTED: &[(&str, &[(usize, f64)])] = &[
    // The offset and the size of its end record give two directories, and Python
    // and rawzip differ on it (`differential.rs`).
    ("test-badbase.zip", &[(health::END_SECOND_DIRECTORY, 1.0)]),
    ("aes128.zip", &[(health::ENCRYPTED + 1, 1.0)]),
    ("aes192.zip", &[(health::ENCRYPTED + 2, 1.0)]),
    ("aes256-ae1.zip", &[(health::ENCRYPTED + 3, 1.0)]),
    ("aes256.zip", &[(health::ENCRYPTED + 3, 1.0)]),
    // The end record declares 2 entries, the directory has 3.
    ("eocd-undercount.zip", &[(health::COUNT_MISMATCH, 1.0)]),
    // The parse fails, so the count is not compared.
    ("omni-mini.ja", &[(health::PRELUDE_BYTES, 83.0)]),
    // One byte follows the archive comment.
    ("readme.zip", &[(health::EPILOGUE_BYTES, 1.0)]),
    // "prefix that could be an executable jar file" and "some nonsense\n".
    (
        "test-prefix.zip",
        &[
            (health::PRELUDE_BYTES, 43.0),
            (health::EPILOGUE_BYTES, 14.0),
        ],
    ),
    ("test-trailing-junk.zip", &[(health::EPILOGUE_BYTES, 14.0)]),
    (
        "zipcrypto-no-data-descriptor.zip",
        &[(health::ENCRYPTED, 1.0)],
    ),
    ("zipcrypto.zip", &[(health::ENCRYPTED, 1.0)]),
];

#[test]
fn rawzip_assets_give_the_expected_findings() {
    let mut checked = 0;
    for path in corpus::rawzip_files().expect("rawzip assets") {
        let file = path.file_name().unwrap().to_string_lossy().into_owned();
        let data = std::fs::read(&path).unwrap();
        let size = data.len() as u64;
        let Ok(mut ingest) = Ingest::open(data, size) else {
            assert_eq!(file, "readme.notzip");
            continue;
        };
        while ingest.status() == &Status::Parsing {
            ingest.parse(1);
        }
        ingest.finish_checks();
        let fields = ingest.health_vector();
        let expected = EXPECTED
            .iter()
            .find(|(name, _)| *name == file)
            .map_or(&[][..], |(_, values)| values);
        for (index, &value) in fields.iter().enumerate() {
            let want = match index {
                health::DECLARED_ENTRIES => value,
                health::OVERLAPS_CHECKED | health::DUPLICATES_CHECKED => 1.0,
                health::DUPLICATE_EXAMPLE
                | health::BOMB_EXAMPLE
                | health::OVERLAP_EXAMPLE
                | health::INTO_DIRECTORY_EXAMPLE
                | health::OVERLAP_DATA_EXAMPLE
                | health::DEPTH_CAP_EXAMPLE
                | health::FOLDER_CAP_EXAMPLE
                | health::CONTROL_NAME_EXAMPLE
                | health::WRAPPED_EXAMPLE => -1.0,
                _ => expected
                    .iter()
                    .find(|(field, _)| *field == index)
                    .map_or(0.0, |(_, value)| *value),
            };
            assert_eq!(value, want, "{file}: field {index}");
        }
        let marks: u8 = (0..ingest.store().rows())
            .map(|row| ingest.store().marks(row))
            .fold(0, |all, bits| all | bits);
        assert_eq!(marks, 0, "{file}: marks");
        checked += 1;
    }
    assert!(checked >= 30, "only {checked} archives");
}

#[test]
fn the_hostile_corpus_archive_has_each_finding() {
    let data = zipscope_testkit::archives::hostile();
    let size = data.len() as u64;
    let mut ingest = Ingest::open(data, size).unwrap();
    ingest.parse(u32::MAX);
    assert_eq!(ingest.status(), &Status::Complete);
    let fields = ingest.health_vector();
    assert_eq!(fields[health::COUNT_MISMATCH], 1.0);
    assert_eq!(fields[health::DUPLICATE_ROWS], 1.0);
    assert_eq!(fields[health::DEPTH_CAP_ROWS], 1.0);
    assert_eq!(fields[health::BOMB_ROWS], 3.0);
    assert_eq!(fields[health::OVERLAP_ROWS], 3.0);
    assert_eq!(fields[health::ENCRYPTED], 1.0);
    assert_eq!(fields[health::PRELUDE_BYTES], 26.0);
    assert_eq!(fields[health::EPILOGUE_BYTES], 18.0);
}

#[test]
fn the_generated_archives_of_a_writer_have_no_false_range_finding() {
    let mixed = zipscope_testkit::archives::mixed(2000).unwrap();
    let size = mixed.len() as u64;
    let mut ingest = Ingest::open(mixed, size).unwrap();
    ingest.parse(u32::MAX);
    ingest.finish_checks();
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(ingest.health().overlap_rows, 0);
    assert_eq!(ingest.health().into_directory_rows, 0);

    // Zip64 sizes and offsets past 4 GiB, and data descriptors.
    let sparse = zipscope_testkit::archives::zip64_sparse().unwrap();
    let size = sparse.len();
    let mut ingest = Ingest::open(sparse, size).unwrap();
    ingest.parse(u32::MAX);
    ingest.finish_checks();
    assert_eq!(ingest.status(), &Status::Complete);
    assert_eq!(ingest.health().overlap_rows, 0);
    assert_eq!(ingest.health().into_directory_rows, 0);
}
