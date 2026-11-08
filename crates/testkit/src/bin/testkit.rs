//! Writes test archives and the test corpus.
//!
//! Usage:
//!
//! - `testkit mixed <out.zip> [entries]`: an archive of many entry kinds.
//! - `testkit zip64 <out.zip>`: a sparse archive of 5 GiB with entries past
//!   4 GiB. It uses only some kilobytes of disk.
//! - `testkit corpus <dir>`: the rawzip corpus, the generated archives and
//!   `expected.json` with their reference listings.

use std::path::Path;

use zipscope_testkit::{archives, corpus};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let usage = "usage: testkit mixed <out.zip> [entries] | zip64 <out.zip> | corpus <dir>";
    match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["mixed", out] => archives::write(Path::new(out), &archives::mixed(600)?)?,
        ["mixed", out, entries] => {
            archives::write(Path::new(out), &archives::mixed(entries.parse()?)?)?;
        }
        ["zip64", out] => {
            let path = Path::new(out);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let archive = archives::zip64_sparse()?;
            archive.write_to_file(path)?;
            println!(
                "wrote {out}: {} bytes, {} bytes stored",
                archive.len(),
                archive.stored_bytes()
            );
        }
        ["corpus", dir] => {
            let files = corpus::write(Path::new(dir))?;
            println!(
                "wrote {} corpus files and expected.json to {dir}",
                files.len()
            );
        }
        _ => return Err(usage.into()),
    }
    Ok(())
}
