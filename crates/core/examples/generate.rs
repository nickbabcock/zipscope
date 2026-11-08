//! Writes a test archive of empty entries and a manifest of its names.
//!
//! Usage: `cargo run --release -p zipscope-core --example generate -- <entries> <out.zip> [--shuffle] [--flat] [--letters]`
//!
//! The manifest is `<out.zip>.names.txt`, with one name on each line in
//! central-directory order. Paths are about 80 bytes, as in the spec.
//! `--shuffle` writes the same names in a fixed random order, so that the
//! name order is not the archive order (the sort benchmark uses it).
//! `--flat` puts all entries but the first index in the root folder, so
//! that one folder lists nearly all rows and the tree has a row to toggle.
//! `--letters` writes each digit as a letter, so that no name has
//! a digit.

use std::fs::File;
use std::io::{BufWriter, Write};

fn name(index: usize) -> String {
    format!(
        "project-1.2.0/src/module-{:03}/component-{:02}/file-{index:07}-generated-entry-name.txt",
        index / 1000,
        (index / 50) % 20,
    )
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let usage = "usage: generate <entries> <out.zip> [--shuffle] [--flat] [--letters]";
    let entries: usize = args.next().ok_or(usage)?.parse()?;
    let out = args.next().ok_or(usage)?;
    let flags: Vec<String> = args.collect();
    let has = |flag: &str| flags.iter().any(|arg| arg == flag);
    let (shuffle, flat, letters) = (has("--shuffle"), has("--flat"), has("--letters"));
    let mut order: Vec<usize> = (0..entries).collect();
    if shuffle {
        // Fisher-Yates with xorshift and a fixed seed.
        let mut seed = 0x9e37_79b9_7f4a_7c15_u64;
        for last in (1..entries).rev() {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let other = usize::try_from(seed % (last as u64 + 1))?;
            order.swap(last, other);
        }
    }
    if let Some(parent) = std::path::Path::new(&out).parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut archive = rawzip::ZipArchiveWriter::new(BufWriter::new(File::create(&out)?));
    let mut manifest = BufWriter::new(File::create(format!("{out}.names.txt"))?);
    for index in order {
        let mut name = name(index);
        if flat && index != 0 {
            name = name.replace('/', "-");
        }
        if letters {
            name = name
                .chars()
                .map(|c| {
                    c.to_digit(10)
                        .and_then(|digit| char::from_digit(digit + 10, 36))
                        .unwrap_or(c)
                })
                .collect();
        }
        let (mut entry, config) = archive.new_file(name.as_str()).start()?;
        let writer = config.wrap(&mut entry);
        let (_, descriptor) = writer.finish()?;
        entry.finish(descriptor)?;
        writeln!(manifest, "{name}")?;
    }
    archive.finish()?.flush()?;
    manifest.flush()?;
    println!("wrote {entries} entries to {out}");
    Ok(())
}
