//! The test corpus: the `assets/` archives of rawzip and the generated
//! archives.
//!
//! rawzip is MIT licensed, like Zipscope. Its assets come from the crate
//! source that Cargo downloads. They are copied into `target/`, never into
//! the repository.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::json;

use crate::archives;
use crate::listing::{self, Listing};

/// Files in rawzip's `assets/` that are part of the corpus. `readme.notzip`
/// is not an archive.
fn is_corpus_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    name == "readme.notzip"
        || matches!(
            path.extension().and_then(|ext| ext.to_str()),
            Some("zip" | "jar" | "ja")
        )
}

/// Returns the `assets/` directory of the rawzip crate. Set `RAWZIP_ASSETS`
/// to use a different directory. If not, `cargo metadata` finds the crate
/// source.
///
/// # Errors
///
/// Returns an error if Cargo fails or the crate assets cannot be found.
pub fn rawzip_assets() -> io::Result<PathBuf> {
    if let Some(dir) = std::env::var_os("RAWZIP_ASSETS") {
        return Ok(PathBuf::from(dir));
    }
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let output = Command::new(cargo)
        .args(["metadata", "--format-version", "1", "--locked"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "cargo metadata failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(io::Error::other)?;
    let manifest = metadata["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|package| package["name"] == "rawzip")
        .and_then(|package| package["manifest_path"].as_str())
        .ok_or_else(|| io::Error::other("cargo metadata has no rawzip package"))?;
    let assets = Path::new(manifest).with_file_name("assets");
    if !assets.is_dir() {
        return Err(io::Error::other(format!(
            "{} is not a directory",
            assets.display()
        )));
    }
    Ok(assets)
}

/// Returns the corpus files of rawzip, sorted by name.
///
/// # Errors
///
/// Returns an error if the assets directory cannot be found or read.
pub fn rawzip_files() -> io::Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(rawzip_assets()?)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<io::Result<_>>()?;
    files.retain(|path| is_corpus_file(path));
    files.sort();
    Ok(files)
}

/// Lists a corpus file with rawzip. Large files use the reader API.
///
/// # Errors
///
/// Returns an error if the file cannot be read.
pub fn reference(path: &Path) -> io::Result<Listing> {
    let size = std::fs::metadata(path)?.len();
    if size > 64 << 20 {
        let file = File::open(path)?;
        return Ok(listing::rawzip_reader(rawzip::FileReader::from(file), size));
    }
    Ok(listing::rawzip_slice(&std::fs::read(path)?))
}

/// Writes the corpus into `dir`: copies of the rawzip files in `rawzip/`,
/// the generated archives in `generated/`, and `expected.json` with the
/// reference listing of each file. Returns the corpus paths.
///
/// # Errors
///
/// Returns an error if a corpus file cannot be read or written.
/// Also returns archive, path, and JSON errors.
///
/// # Panics
///
/// Panics if a corpus path has no file name.
pub fn write(dir: &Path) -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    let mut files = Vec::new();
    std::fs::create_dir_all(dir.join("rawzip"))?;
    for source in rawzip_files()? {
        let target = dir.join("rawzip").join(source.file_name().expect("a file"));
        std::fs::copy(&source, &target)?;
        files.push(target);
    }
    let mixed = dir.join("generated/mixed.zip");
    archives::write(&mixed, &archives::mixed(600)?)?;
    files.push(mixed);
    let hostile = dir.join("generated/hostile.zip");
    archives::write(&hostile, &archives::hostile())?;
    files.push(hostile);
    let zip64 = dir.join("generated/zip64-sparse.zip");
    archives::zip64_sparse()?.write_to_file(&zip64)?;
    files.push(zip64);

    let mut cases = Vec::new();
    for path in &files {
        let listing = reference(path)?;
        let message = match &listing.outcome {
            listing::Outcome::Complete => None,
            listing::Outcome::Failed(message) | listing::Outcome::NotZip(message) => {
                Some(message.clone())
            }
        };
        cases.push(json!({
            "file": path.strip_prefix(dir)?.to_string_lossy().replace('\\', "/"),
            "outcome": listing.outcome.kind(),
            "message": message,
            "names": listing.entries.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(),
        }));
    }
    std::fs::write(
        dir.join("expected.json"),
        serde_json::to_string_pretty(&json!({ "files": cases }))?,
    )?;
    Ok(files)
}
