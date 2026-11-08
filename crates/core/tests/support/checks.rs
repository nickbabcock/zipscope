use zipscope_core::contract::{Column, NONE};
use zipscope_core::ingest::{Ingest, Status};
use zipscope_core::tree::{MAX_DEPTH, ROOT};

pub fn finish(ingest: &mut Ingest<Vec<u8>>, batch: u32, max_rows: usize) {
    assert!(batch > 0);
    for _ in 0..=max_rows + 1 {
        if *ingest.status() != Status::Parsing {
            return;
        }
        assert!(ingest.parse(batch) <= batch);
        ingest.refresh_views();
        assert!(ingest.store().rows() <= max_rows);
        assert!((0.0..=1.0).contains(&ingest.progress()));
    }
    panic!("parsing did not stop");
}

pub fn marked(ingest: &Ingest<Vec<u8>>, row: usize, bit: u8) -> bool {
    let value = ingest.store().value(row, Column::Marks);
    assert!((0.0..=255.0).contains(&value));
    assert_eq!(value.fract(), 0.0);
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "The assertions check that the value is a byte."
    )]
    let bits = value as u8;
    bits & bit != 0
}

pub fn check_tree(ingest: &Ingest<Vec<u8>>, folder_limit: usize) {
    let tree = ingest.tree();
    assert!(tree.folder_count() <= folder_limit);
    let mut depths = vec![0; tree.folder_count()];
    let mut seen = vec![0; ingest.store().rows()];
    for (id, folder) in tree.folders().iter().enumerate() {
        if id != ROOT as usize {
            assert!((folder.parent as usize) < id);
            depths[id] = depths[folder.parent as usize] + 1;
            assert!(depths[id] <= MAX_DEPTH);
        }
        if folder.explicit_row != NONE {
            seen[folder.explicit_row as usize] += 1;
        }
        for row in tree.entries(u32::try_from(id).unwrap()) {
            seen[row as usize] += 1;
        }
    }
    assert!(seen.iter().all(|&count| count == 1), "{seen:?}");
    assert_eq!(
        tree.rollup(ROOT).entry_count,
        f64::from(u32::try_from(seen.len()).unwrap())
    );
}
