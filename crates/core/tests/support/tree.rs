/*
ASSUMED API
ingest::Ingest<R>::tree(&self) -> &tree::Tree
tree::Tree::folders(&self) -> &[tree::Folder]
tree::Tree::rollup(&self, folder: u32) -> tree::Rollup
tree::Tree::children(&self, folder: u32) -> Vec<u32>
tree::Folder: name_offset: u32, name_length: u32, parent: u32, explicit_row: u32
tree::Rollup: uncompressed_size: f64, compressed_size: f64, entry_count: f64

See hostile_tree.rs for the rules for these values.
*/

use super::zip::{Entry, archive, cell, cell_u32, field, open, u64le};
use std::collections::BTreeSet;
use zipscope_core::contract::{CHUNK_BITS, CHUNK_BYTES, Column};
use zipscope_core::ingest::{Ingest, Status};

pub const ROOT: u32 = 0;
pub const NONE: u32 = u32::MAX;
pub const FOLDER: u32 = 1 << 31;

pub fn file(name: impl AsRef<[u8]>, size: u32, compressed: u32) -> Entry {
    Entry {
        size,
        compressed,
        ..Entry::new(name)
    }
}

pub fn zip64_file(name: &str, size: u64, compressed: u64) -> Entry {
    let mut body = Vec::new();
    u64le(&mut body, size);
    u64le(&mut body, compressed);
    Entry {
        size: u32::MAX,
        compressed: u32::MAX,
        extra: field(0x0001, &body),
        ..Entry::new(name)
    }
}

pub fn start(entries: &[Entry]) -> Ingest<Vec<u8>> {
    open(archive(entries, entries.len().try_into().unwrap(), None).bytes)
}

pub fn finish(ingest: &mut Ingest<Vec<u8>>, batch: u32) {
    assert!(batch > 0);
    let bound = 1 + ingest.entries_hint().min(10_000) as usize;
    for _ in 0..bound {
        if ingest.status() != &Status::Parsing {
            break;
        }
        ingest.parse(batch);
    }
    assert_eq!(ingest.status(), &Status::Complete);
}

pub fn parsed(entries: &[Entry]) -> Ingest<Vec<u8>> {
    let mut ingest = start(entries);
    finish(&mut ingest, 3);
    ingest
}

pub fn label(ingest: &Ingest<Vec<u8>>, id: u32) -> String {
    let node = &ingest.tree().folders()[id as usize];
    let offset = node.name_offset;
    let length = node.name_length as usize;
    let chunk = ingest
        .store()
        .names()
        .chunk((offset >> CHUNK_BITS) as usize);
    let position = offset as usize & (CHUNK_BYTES - 1);
    String::from_utf8(chunk[position..position + length].to_vec()).unwrap()
}

pub fn path(ingest: &Ingest<Vec<u8>>, mut id: u32) -> String {
    let mut names = Vec::new();
    let mut visited = BTreeSet::new();
    while id != ROOT {
        assert!(visited.insert(id), "folder parent cycle");
        assert!((id as usize) < ingest.tree().folders().len());
        names.push(label(ingest, id));
        id = ingest.tree().folders()[id as usize].parent;
    }
    names.reverse();
    names.join("/")
}

pub fn folder(ingest: &Ingest<Vec<u8>>, name: &str) -> u32 {
    let ids: Vec<_> = (0..u32::try_from(ingest.tree().folders().len()).unwrap())
        .filter(|&id| path(ingest, id) == name)
        .collect();
    assert_eq!(ids.len(), 1, "folder {name:?} is missing or repeated");
    ids[0]
}

pub fn totals(ingest: &Ingest<Vec<u8>>, id: u32) -> [f64; 3] {
    let value = ingest.tree().rollup(id);
    [
        value.uncompressed_size,
        value.compressed_size,
        value.entry_count,
    ]
}

pub fn children(ingest: &Ingest<Vec<u8>>, id: u32) -> BTreeSet<u32> {
    let values = ingest.tree().children(id);
    let set: BTreeSet<_> = values.iter().copied().collect();
    assert_eq!(values.len(), set.len(), "a child occurs more than once");
    set
}

pub fn depth(ingest: &Ingest<Vec<u8>>, mut id: u32) -> usize {
    let mut visited = BTreeSet::new();
    while id != ROOT {
        assert!(visited.insert(id), "folder parent cycle");
        id = ingest.tree().folders()[id as usize].parent;
    }
    visited.len()
}

pub fn check(ingest: &Ingest<Vec<u8>>) {
    let tree = ingest.tree();
    let folders = tree.folders();
    assert_ne!(folders.len(), 0);
    assert_eq!(folders[ROOT as usize].parent, NONE);
    assert_eq!(folders[ROOT as usize].explicit_row, NONE);
    assert!(folders.len() < FOLDER as usize);
    let mut rows_seen = vec![0; ingest.store().rows()];
    let mut folders_seen = vec![0; folders.len()];
    for (index, node) in folders.iter().enumerate() {
        let id = u32::try_from(index).unwrap();
        assert!(depth(ingest, id) <= 256);
        if id != ROOT {
            let offset = node.name_offset;
            let length = node.name_length;
            assert!(length > 0);
            assert_ne!(label(ingest, id), "");
            // Each folder name must be a slice of a stored entry name.
            assert!((0..ingest.store().rows()).any(|row| {
                let start = cell_u32(ingest.store(), row, Column::NameOffset);
                let len = cell_u32(ingest.store(), row, Column::NameLength);
                offset >= start
                    && u64::from(offset) + u64::from(length) <= u64::from(start) + u64::from(len)
            }));
        }
        let mut expected = [0.0; 3];
        if node.explicit_row != NONE {
            let row = node.explicit_row as usize;
            assert!(row < rows_seen.len());
            rows_seen[row] += 1;
            expected = [
                cell(ingest.store(), row, Column::UncompressedSize),
                cell(ingest.store(), row, Column::CompressedSize),
                1.0,
            ];
        }
        for item in children(ingest, id) {
            let values = if item & FOLDER != 0 {
                let child = (item & !FOLDER) as usize;
                assert!(child < folders.len());
                assert_ne!(child, ROOT as usize);
                assert_eq!(folders[child].parent, id);
                folders_seen[child] += 1;
                totals(ingest, u32::try_from(child).unwrap())
            } else {
                let row = item as usize;
                assert!(row < rows_seen.len());
                rows_seen[row] += 1;
                [
                    cell(ingest.store(), row, Column::UncompressedSize),
                    cell(ingest.store(), row, Column::CompressedSize),
                    1.0,
                ]
            };
            for i in 0..3 {
                expected[i] += values[i];
            }
        }
        assert_eq!(totals(ingest, id), expected, "folder {id}");
    }
    assert!(
        rows_seen.iter().all(|&count| count == 1),
        "lost or repeated entry"
    );
    assert_eq!(folders_seen[ROOT as usize], 0);
    assert!(folders_seen[1..].iter().all(|&count| count == 1));
}
