//! The parse worker, the read worker and the write path open one file with one
//! rule. `crates/layout/tests/end_record.rs` has the tests of the rule.

use std::io::Read;

use zipscope_core::ingest::Ingest;
use zipscope_layout::end::{TOO_MANY_TEXT, open_end};
use zipscope_read::directory::Directory;
use zipscope_testkit::end_shapes::{costly_tail, shapes};
use zipscope_write::lead::Lead;
use zipscope_write::remux::{Remux, encode};

/// The parse worker, the read worker and the write path open one file with one
/// rule. A test of the source keeps each of them on the helper.
#[test]
fn all_open_sites_choose_the_same_record() {
    fn compare(name: &str, bytes: &[u8]) {
        let size = bytes.len() as u64;
        let helper = open_end(bytes.to_vec(), size)
            .map(|opened| {
                (
                    opened.archive.eocd_offset(),
                    opened.archive.directory_offset(),
                )
            })
            .map_err(|err| err.to_string());
        let core = Ingest::open(bytes.to_vec(), size)
            .map(|ingest| (ingest.eocd_offset(), ingest.directory_offset()))
            .map_err(|err| err.to_string());
        let read = Directory::open(bytes.to_vec(), size)
            .map(|directory| {
                let archive = directory.archive();
                (archive.eocd_offset(), archive.directory_offset())
            })
            .map_err(|err| err.to_string());
        assert_eq!(core, helper, "the parse worker: {name}");
        assert_eq!(read, helper, "the read worker: {name}");
        match (Lead::open(bytes.to_vec(), size), helper) {
            (Ok(lead), Ok(offsets)) => {
                assert_eq!(lead.end_offsets(), offsets, "the write path: {name}");
            }
            (Err(err), Err(text)) => {
                assert_eq!(err, format!("The archive cannot be read: {text}"), "{name}");
            }
            (lead, helper) => panic!("{name}: {:?} and {helper:?}", lead.map(|_| ())),
        }
    }
    let shapes = shapes();
    for shape in &shapes {
        compare(shape.name, &shape.bytes);
    }
    // Small changes of the end of each file. A seed makes one fixed list. Each
    // open keeps a buffer until the process ends, so the list is short.
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for shape in shapes.iter().filter(|shape| shape.bytes.len() < 4096) {
        for _ in 0..4 {
            let mut bytes = shape.bytes.clone();
            if bytes.is_empty() {
                continue;
            }
            let room = bytes.len().min(96);
            for _ in 0..4 {
                let at = bytes.len() - 1 - usize::try_from(next()).unwrap() % room;
                bytes[at] = u8::try_from(next() & 0xff).unwrap();
            }
            compare(shape.name, &bytes);
        }
    }
}

#[test]
fn only_the_helper_calls_the_locator_of_rawzip() {
    for source in [
        include_str!("../../core/src/ingest.rs"),
        include_str!("../../read/src/directory.rs"),
        include_str!("../../write/src/lead.rs"),
    ] {
        assert!(source.contains("open_end("));
        assert!(!source.contains("ZipLocator"));
        assert!(!source.contains("locate_in_reader"));
    }
}

#[test]
fn each_site_gives_the_failure_of_the_limit() {
    let bytes = costly_tail(17, 0);
    let size = bytes.len() as u64;
    let parse = Ingest::open(bytes.clone(), size).err().unwrap();
    assert_eq!(parse.to_string(), TOO_MANY_TEXT);
    let read = Directory::open(bytes.clone(), size).err().unwrap();
    assert_eq!(read.to_string(), TOO_MANY_TEXT);
    let write = Lead::open(bytes, size).err().unwrap();
    assert_eq!(
        write,
        format!("The archive cannot be read: {TOO_MANY_TEXT}")
    );
}

/// The whole copy works on each file that the walk opens: the lead, and the
/// encoder, which has its own virtual archive over the file. The copy keeps the
/// comment bytes that the file has.
#[test]
fn the_copy_of_a_walked_file_has_each_entry_and_the_comment_bytes() {
    for (shape, comment) in [
        ("cut", &b"cut comm"[..]),
        ("stray-at-end", b"note PK\x05\x06"),
    ] {
        let bytes = shapes()
            .into_iter()
            .find(|candidate| candidate.name == shape)
            .unwrap()
            .bytes;
        let size = bytes.len() as u64;
        let mut remux = Remux::open(bytes.clone(), size).unwrap();
        let mut copy = Vec::new();
        for row in 0..remux.rows() {
            let job = remux.job(row).unwrap();
            let mut data = Vec::new();
            let encoded = encode(bytes.clone(), size, &job, &mut data).unwrap();
            remux.add(row, Ok((encoded, data))).unwrap();
            copy.extend(remux.take(usize::MAX));
        }
        let report = remux.finish().unwrap();
        copy.extend(remux.take(usize::MAX));
        assert!(report.left_out.is_empty(), "{shape}: {:?}", report.left_out);

        let copy_size = copy.len() as u64;
        let archive = open_end(copy, copy_size).unwrap().archive;
        assert_eq!(archive.entries_hint(), 2, "{shape}");
        let mut found = Vec::new();
        archive.comment().read_to_end(&mut found).unwrap();
        assert_eq!(found, comment, "{shape}");
    }
}
