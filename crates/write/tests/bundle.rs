//! The write module is a separate bundle. It encodes with the
//! C zstd library only, and the parse-only core does not get it.
//!
//! The test reads `Cargo.lock` of the workspace, so it needs no new API.

use std::collections::{BTreeMap, BTreeSet};

/// The dependencies of each package in `Cargo.lock`, by name only.
fn lock_graph() -> BTreeMap<String, Vec<String>> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.lock");
    let lock = std::fs::read_to_string(path).expect("Cargo.lock");
    let mut graph: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut name = None;
    let mut in_dependencies = false;
    for line in lock.lines() {
        let line = line.trim();
        if line == "[[package]]" {
            name = None;
            in_dependencies = false;
        } else if let Some(value) = line.strip_prefix("name = ") {
            let value = value.trim_matches('"').to_string();
            graph.entry(value.clone()).or_default();
            name = Some(value);
        } else if line.starts_with("dependencies = [") {
            in_dependencies = true;
        } else if in_dependencies && line == "]" {
            in_dependencies = false;
        } else if in_dependencies {
            // "name", or "name version" when two versions are in the lock.
            let dependency = line.trim_matches(|c| c == '"' || c == ',');
            let dependency = dependency.split(' ').next().unwrap().to_string();
            if let Some(name) = &name {
                graph.get_mut(name).unwrap().push(dependency);
            }
        }
    }
    graph
}

fn closure(graph: &BTreeMap<String, Vec<String>>, root: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let mut stack = vec![root.to_string()];
    while let Some(name) = stack.pop() {
        if found.insert(name.clone()) {
            stack.extend(graph.get(&name).cloned().unwrap_or_default());
        }
    }
    found
}

#[test]
fn the_write_module_uses_the_c_zstd_library_and_rawzip() {
    let graph = lock_graph();
    let write = closure(&graph, "zipscope-write");
    assert!(write.contains("zstd-sys"), "No C zstd library: {write:?}");
    assert!(write.contains("rawzip"), "No rawzip writer: {write:?}");
    assert!(
        !write.contains("ruzstd"),
        "A second zstd library: {write:?}"
    );
}

#[test]
fn the_parse_only_core_does_not_get_the_encoder() {
    let graph = lock_graph();
    let core = closure(&graph, "zipscope-core");
    for name in ["zipscope-write", "zstd-sys", "zstd-safe", "zstd", "ruzstd"] {
        assert!(!core.contains(name), "The core depends on {name}");
    }
    // The read module decodes only; it does not get the write module.
    let read = closure(&graph, "zipscope-read");
    assert!(!read.contains("zipscope-write"));
}
