//! Files for the walk to the end record.
//!
//! Each shape of an end record is here, with the record that the rule
//! chooses for it. `crates/layout/tests/end_record.rs` uses them. All files
//! are small.

pub const END_SIGNATURE: &[u8; 4] = b"PK\x05\x06";
pub const LOCATOR_SIGNATURE: &[u8; 4] = b"PK\x06\x07";

/// The fixed part of an end record.
pub const END_BYTES: u64 = 22;

/// What the rule must do with a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Want {
    /// The open chooses this record.
    Opens {
        eocd: u64,
        directory: u64,
        /// The names of the listing. The parse can stop after them.
        rows: Vec<&'static str>,
        /// True when the parse stops with an error of the central directory.
        parse_error: bool,
        skipped: u32,
        others: u32,
        /// The declared and the present bytes of a cut comment.
        cut: Option<(u16, u16)>,
        /// The chosen record also gives a place with another directory.
        second: bool,
    },
    /// The open fails with this text.
    Fails(&'static str),
}

/// A file and what the rule must do with it.
#[derive(Debug, Clone)]
pub struct Shape {
    pub name: &'static str,
    pub bytes: Vec<u8>,
    pub want: Want,
}

/// A stored archive up to its end record.
#[derive(Debug, Clone)]
pub struct Body {
    pub bytes: Vec<u8>,
    /// The place of the central directory in `bytes`.
    pub directory: u64,
    /// The size of the central directory.
    pub directory_size: u32,
    /// The directory offset field. It does not count a prefix.
    pub declared: u32,
    pub count: u16,
}

impl Body {
    /// An end record for this body with `comment`. The comment length field
    /// says `declared`.
    #[must_use]
    pub fn end(&self, comment: &[u8], declared: u16) -> Vec<u8> {
        let mut out = self.bytes.clone();
        out.extend_from_slice(&end_record(
            self.count,
            self.directory_size,
            self.declared,
            declared,
        ));
        out.extend_from_slice(comment);
        out
    }

    /// The offset of an end record that follows this body.
    #[must_use]
    pub fn eocd(&self) -> u64 {
        self.bytes.len() as u64
    }

    /// The bytes of the central directory.
    ///
    /// # Panics
    ///
    /// Panics on a 16-bit platform.
    #[must_use]
    pub fn directory_bytes(&self) -> &[u8] {
        let start = usize::try_from(self.directory).unwrap();
        &self.bytes[start..start + self.directory_size as usize]
    }
}

/// An end record. All disk fields are 0.
#[must_use]
pub fn end_record(count: u16, directory_size: u32, directory: u32, comment_length: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(22);
    out.extend_from_slice(END_SIGNATURE);
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&directory_size.to_le_bytes());
    out.extend_from_slice(&directory.to_le_bytes());
    out.extend_from_slice(&comment_length.to_le_bytes());
    out
}

/// A Zip64 locator that points to `record`.
#[must_use]
pub fn locator(record: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(20);
    out.extend_from_slice(LOCATOR_SIGNATURE);
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&record.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());
    out
}

/// Stored entries with these names and bodies, after `prefix`. The last record
/// has the comment `last_comment`.
///
/// # Panics
///
/// Panics when a value does not fit its field.
#[must_use]
pub fn body_with(prefix: &[u8], entries: &[(&str, &[u8])], last_comment: &[u8]) -> Body {
    let mut bytes = prefix.to_vec();
    let mut directory = Vec::new();
    for (index, (name, data)) in entries.iter().enumerate() {
        let offset = u32::try_from(bytes.len() - prefix.len()).unwrap();
        let crc = rawzip::crc32(data).to_le_bytes();
        let size = u32::try_from(data.len()).unwrap().to_le_bytes();
        let length = u16::try_from(name.len()).unwrap().to_le_bytes();
        bytes.extend_from_slice(b"PK\x03\x04\x14\0\0\0\0\0\0\0\0\0");
        bytes.extend_from_slice(&crc);
        bytes.extend_from_slice(&size);
        bytes.extend_from_slice(&size);
        bytes.extend_from_slice(&length);
        bytes.extend_from_slice(&[0; 2]);
        bytes.extend_from_slice(name.as_bytes());
        bytes.extend_from_slice(data);
        let comment: &[u8] = if index + 1 == entries.len() {
            last_comment
        } else {
            &[]
        };
        directory.extend_from_slice(b"PK\x01\x02\x14\0\x14\0\0\0\0\0\0\0\0\0");
        directory.extend_from_slice(&crc);
        directory.extend_from_slice(&size);
        directory.extend_from_slice(&size);
        directory.extend_from_slice(&length);
        directory.extend_from_slice(&[0; 2]);
        directory.extend_from_slice(&u16::try_from(comment.len()).unwrap().to_le_bytes());
        directory.extend_from_slice(&[0; 8]);
        directory.extend_from_slice(&offset.to_le_bytes());
        directory.extend_from_slice(name.as_bytes());
        directory.extend_from_slice(comment);
    }
    let place = bytes.len() as u64;
    let declared = u32::try_from(bytes.len() - prefix.len()).unwrap();
    bytes.extend_from_slice(&directory);
    Body {
        bytes,
        directory: place,
        directory_size: u32::try_from(directory.len()).unwrap(),
        declared,
        count: u16::try_from(entries.len()).unwrap(),
    }
}

/// Two entries: `a.txt` and `b.txt`.
#[must_use]
pub fn two_rows() -> Body {
    body_with(b"", &[("a.txt", b"data a"), ("b.txt", b"data b")], b"")
}

fn with_comment(body: &Body, comment: &[u8]) -> Vec<u8> {
    body.end(comment, u16::try_from(comment.len()).unwrap())
}

/// A true Zip64 archive with one entry. The offsets of its fields do not count
/// `prefix`, as when data is put before an archive.
fn zip64(prefix: &[u8], comment: &[u8]) -> Vec<u8> {
    let body = body_with(b"", &[("a.txt", b"zip64 body")], b"");
    let mut out = prefix.to_vec();
    out.extend_from_slice(&body.bytes);
    out.extend_from_slice(b"PK\x06\x06");
    out.extend_from_slice(&44u64.to_le_bytes());
    out.extend_from_slice(&[45, 0, 45, 0]);
    out.extend_from_slice(&[0; 8]);
    out.extend_from_slice(&1u64.to_le_bytes());
    out.extend_from_slice(&1u64.to_le_bytes());
    out.extend_from_slice(&u64::from(body.directory_size).to_le_bytes());
    out.extend_from_slice(&u64::from(body.declared).to_le_bytes());
    out.extend_from_slice(&locator(body.bytes.len() as u64));
    out.extend_from_slice(&end_record(
        u16::MAX,
        u32::MAX,
        u32::MAX,
        u16::try_from(comment.len()).unwrap(),
    ));
    out.extend_from_slice(comment);
    out
}

/// A Zip64 record with this directory.
fn zip64_record(entries: u64, directory_size: u64, directory: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(56);
    out.extend_from_slice(b"PK\x06\x06");
    out.extend_from_slice(&44u64.to_le_bytes());
    out.extend_from_slice(&[45, 0, 45, 0]);
    out.extend_from_slice(&[0; 8]);
    out.extend_from_slice(&entries.to_le_bytes());
    out.extend_from_slice(&entries.to_le_bytes());
    out.extend_from_slice(&directory_size.to_le_bytes());
    out.extend_from_slice(&directory.to_le_bytes());
    out
}

/// A local header, a central record, a Zip64 record and a locator of the entry
/// `fake.txt`, for the place `at` in the file. Then an end record whose classic
/// fields differ from the Zip64 record: rawzip refuses that record, and it uses
/// the classic fields, which give no directory. Python uses the Zip64 record.
fn fake_behind_locator(at: u64, comment_length: u16) -> Vec<u8> {
    let fake = body_with(b"", &[("fake.txt", b"fake data")], b"");
    let local_bytes = usize::try_from(fake.directory).unwrap();
    let mut out = fake.bytes[..local_bytes].to_vec();
    let directory = at + fake.directory;
    let mut central = fake.directory_bytes().to_vec();
    central[42..46].copy_from_slice(&u32::try_from(at).unwrap().to_le_bytes());
    out.extend_from_slice(&central);
    let record = at + out.len() as u64;
    out.extend_from_slice(&zip64_record(1, central.len() as u64, directory));
    out.extend_from_slice(&locator(record));
    out.extend_from_slice(&end_record(7, 1, 1, comment_length));
    out
}

fn opens(eocd: u64, directory: u64, rows: &[&'static str]) -> Want {
    Want::Opens {
        eocd,
        directory,
        rows: rows.to_vec(),
        parse_error: false,
        skipped: 0,
        others: 0,
        cut: None,
        second: false,
    }
}

fn with(want: Want, change: impl FnOnce(&mut u32, &mut u32, &mut Option<(u16, u16)>)) -> Want {
    let mut want = want;
    if let Want::Opens {
        skipped,
        others,
        cut,
        ..
    } = &mut want
    {
        change(skipped, others, cut);
    }
    want
}

/// `skipped` signatures after the chosen record.
fn skipped(want: Want, count: u32) -> Want {
    with(want, |skipped, _, _| *skipped = count)
}

/// One other record with a central directory.
fn another(want: Want) -> Want {
    with(want, |_, others, _| *others = 1)
}

fn cut(want: Want, declared: u16, present: u16) -> Want {
    with(want, |_, _, cut| *cut = Some((declared, present)))
}

fn second_directory(want: Want) -> Want {
    let mut want = want;
    if let Want::Opens { second, .. } = &mut want {
        *second = true;
    }
    want
}

fn parse_error(want: Want) -> Want {
    let mut want = want;
    if let Want::Opens { parse_error, .. } = &mut want {
        *parse_error = true;
    }
    want
}

/// A record that passes each check in memory, and costs 3 reads.
///
/// It has a false locator that points to the file, and a directory place and a
/// declared offset that are far before the kept bytes. `far` is the first place
/// of the three, and `at` is the place of this value.
///
/// # Panics
///
/// Panics when a value does not fit its field.
#[must_use]
pub fn costly_decoy(far: u32, at: u64) -> Vec<u8> {
    let mut out = locator(u64::from(far));
    let size = u32::try_from(at + 20 - u64::from(far) - 1000).unwrap();
    out.extend_from_slice(&end_record(1, size, far + 2000, 0));
    out
}

/// A large file of zero bytes with `count` costly records, and then `after`
/// zero bytes.
#[must_use]
pub fn costly_tail(count: usize, after: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; 4 << 20];
    for _ in 0..count {
        let place = bytes.len() as u64;
        bytes.extend_from_slice(&costly_decoy(1 << 20, place));
    }
    bytes.extend(std::iter::repeat_n(0_u8, after));
    bytes
}

/// The file that makes the most reads.
///
/// A costly record 2 KB before the end makes a read of the bytes where a comment can
/// hold it. Near the start of the search window, more costly records make a read of
/// the window, and then the trials. Then rawzip opens the nearest record.
///
/// # Panics
///
/// Panics when a value does not fit its field.
#[must_use]
pub fn worst_tail(near_the_window_start: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; 4 << 20];
    for _ in 0..near_the_window_start {
        let place = bytes.len() as u64;
        bytes.extend_from_slice(&costly_decoy(1 << 20, place));
    }
    let window = 1 << 20;
    let near = near_the_window_start * 42;
    bytes.extend(std::iter::repeat_n(0_u8, window - near - 2000));
    let place = bytes.len() as u64;
    bytes.extend_from_slice(&costly_decoy(1 << 20, place));
    bytes.extend(std::iter::repeat_n(0_u8, 2000 - 42));
    bytes
}

/// The text of a failure when no record can be used.
///
/// It is the same value as `zipscope_layout::end::NO_RECORD_TEXT`, and a test
/// compares them.
pub const NO_RECORD: &str = "The end of this file looks like a zip end record, but the record \
                             cannot be used. The file can be cut off or damaged, or it is not a \
                             zip archive";
const NO_SIGNATURE: &str = "Missing end of central directory";
const INVALID: &str = "Invalid end of central directory";

/// The files of all the shapes.
///
/// # Panics
///
/// Panics when a value does not fit its field.
#[must_use]
#[expect(
    clippy::too_many_lines,
    reason = "One table of shapes reads best in one place."
)]
pub fn shapes() -> Vec<Shape> {
    let mut shapes = Vec::new();
    let mut add = |name: &'static str, bytes: Vec<u8>, want: Want| {
        shapes.push(Shape { name, bytes, want });
    };
    let two = two_rows();
    let names = ["a.txt", "b.txt"];
    let (eocd, directory) = (two.eocd(), two.directory);
    let plain = opens(eocd, directory, &names);

    let fake = body_with(b"", &[("FAKE.txt", b"fake")], b"");
    let fake_size = fake.directory_size;
    let fake_row = ["FAKE.txt"];
    // Archives with no stray signature.
    add("plain", with_comment(&two, b""), plain.clone());
    add(
        "comment",
        with_comment(&two, b"a plain comment"),
        plain.clone(),
    );
    let mut trailing = with_comment(&two, b"");
    trailing.extend_from_slice(b"trailing bytes");
    add("trailing", trailing, plain.clone());
    let prefix: &[u8] = b"#!/bin/sh\nprefix\n";
    let shifted = body_with(prefix, &[("a.txt", b"data a"), ("b.txt", b"data b")], b"");
    add(
        "prefix",
        with_comment(&shifted, b""),
        opens(shifted.eocd(), shifted.directory, &names),
    );
    let empty = body_with(b"", &[], b"");
    add("empty-zip", with_comment(&empty, b""), opens(0, 0, &[]));
    add(
        "empty-zip-comment",
        with_comment(&empty, b"empty"),
        opens(0, 0, &[]),
    );

    // An optimized jar: the directory is at the start of the file, with a copy
    // of the end record after it, and the data is after them. rawzip reads the
    // directory, and it stops with an error at the copy. The last record stays
    // the choice, as with rawzip alone.
    let mut jar = two.directory_bytes().to_vec();
    jar.extend_from_slice(&end_record(two.count, two.directory_size, 0, 0));
    let directory_bytes = usize::try_from(two.directory).unwrap();
    jar.extend_from_slice(&two.bytes[..directory_bytes]);
    let jar_eocd = jar.len() as u64;
    jar.extend_from_slice(&end_record(two.count, two.directory_size, 0, 0));
    add(
        "optimized-jar",
        jar,
        parse_error(opens(jar_eocd, 0, &names)),
    );

    // A stray signature in the comment.
    let stray_text = {
        let mut text = b"note PK\x05\x06 ".to_vec();
        text.extend_from_slice(&[b'x'; 40]);
        text
    };
    add(
        "stray-text",
        with_comment(&two, &stray_text),
        skipped(plain.clone(), 1),
    );
    add(
        "stray-at-end",
        with_comment(&two, b"note PK\x05\x06"),
        skipped(plain.clone(), 1),
    );
    let zero_record = end_record(0, 0, 0, 0);
    let mut stray = b"c:".to_vec();
    stray.extend_from_slice(&zero_record);
    add(
        "stray-zero",
        with_comment(&two, &stray),
        skipped(plain.clone(), 1),
    );
    stray.extend_from_slice(b"after");
    add(
        "stray-zero-short",
        with_comment(&two, &stray),
        skipped(plain.clone(), 1),
    );
    let mut false_directory = b"c:".to_vec();
    false_directory.extend_from_slice(&end_record(3, 100, 7, 5));
    false_directory.extend_from_slice(b"after");
    add(
        "stray-false-directory",
        with_comment(&two, &false_directory),
        skipped(plain.clone(), 1),
    );
    // A copy of the true record: its directory is true, and the true record
    // is in the way.
    let copy = end_record(two.count, two.directory_size, two.declared, 0);
    add(
        "stray-copy",
        with_comment(&two, &copy),
        skipped(plain.clone(), 1),
    );
    // The same copy in a cut comment: the true record is cut, but its directory
    // ends at it, and the copy is weak.
    add(
        "stray-copy-cut",
        two.end(&copy, 500),
        skipped(cut(plain.clone(), 500, 22), 1),
    );
    // The same copy, with bytes after the comment of the true record.
    let mut short_copy = with_comment(&two, &copy);
    short_copy.extend_from_slice(b"after");
    add("stray-copy-short", short_copy, skipped(plain.clone(), 1));
    let mut many = Vec::new();
    for _ in 0..2000 {
        many.extend_from_slice(END_SIGNATURE);
        many.extend_from_slice(&[0xff; 20]);
    }
    add(
        "many-strays",
        with_comment(&two, &many),
        skipped(plain.clone(), 2000),
    );
    let many_zero: Vec<u8> = zero_record.repeat(2900);
    add(
        "many-zero-records",
        with_comment(&two, &many_zero),
        skipped(plain.clone(), 2900),
    );

    // A stray signature with bytes that look like a locator before it.
    let mut stray_locator = locator(3);
    stray_locator.extend_from_slice(&end_record(3, 100, 7, 0));
    add(
        "stray-locator",
        with_comment(&two, &stray_locator),
        skipped(plain.clone(), 1),
    );

    // A cut comment.
    add("cut", two.end(b"cut comm", 100), cut(plain.clone(), 100, 8));
    add(
        "cut-at-record",
        two.end(b"", 100),
        cut(plain.clone(), 100, 0),
    );
    add(
        "cut-stray",
        two.end(b"cut PK\x05\x06 stray", 500),
        skipped(cut(plain.clone(), 500, 14), 1),
    );

    add(
        "prefix-cut",
        shifted.end(b"cut comm", 100),
        cut(opens(shifted.eocd(), shifted.directory, &names), 100, 8),
    );
    let mut zip64_cut = zip64(b"", b"cut comm");
    let field = zip64_cut.len() - 8 - 2;
    zip64_cut[field..field + 2].copy_from_slice(&100u16.to_le_bytes());
    let zip64_cut_eocd = zip64_cut.len() as u64 - 8 - END_BYTES;
    add(
        "zip64-cut",
        zip64_cut,
        cut(opens(zip64_cut_eocd, 45, &["a.txt"]), 100, 8),
    );

    // A record whose size reaches back to exactly the start of the file, where
    // the directory is. Its declared offset is false.
    let mut from_zero = fake.directory_bytes().to_vec();
    from_zero.extend_from_slice(&end_record(1, fake_size, 5, 0));
    add(
        "directory-at-zero",
        from_zero,
        opens(u64::from(fake_size), 0, &fake_row),
    );
    // A false record with a size past the start of the file and a place in the
    // file for its offset.
    add(
        "stray-size-too-large",
        with_comment(&two, &end_record(1, u32::MAX - 5, 3, 0)),
        skipped(plain.clone(), 1),
    );
    // A false offset at the place of the record: the prefix repair reads the
    // directory at the place that the size gives.
    let mut at_record = two.bytes.clone();
    at_record.extend_from_slice(&end_record(
        two.count,
        two.directory_size,
        u32::try_from(eocd).unwrap(),
        0,
    ));
    add("offset-at-record", at_record, plain.clone());
    // A directory of one record of 46 bytes, the smallest one.
    let no_name = body_with(b"", &[("", b"x")], b"");
    add(
        "smallest-directory",
        with_comment(&no_name, b""),
        opens(no_name.eocd(), no_name.directory, &[""]),
    );
    // The same, with a false size: its directory is only at its offset.
    let mut false_size = no_name.bytes.clone();
    false_size.extend_from_slice(&end_record(1, 53, no_name.declared, 0));
    add(
        "smallest-directory-false-size",
        false_size,
        opens(no_name.eocd(), no_name.directory, &[""]),
    );
    let no_name_prefix = body_with(prefix, &[("", b"x")], b"");
    add(
        "smallest-directory-prefix",
        with_comment(&no_name_prefix, b""),
        opens(no_name_prefix.eocd(), no_name_prefix.directory, &[""]),
    );
    // An empty Zip64 archive. rawzip takes a Zip64 record at offset 0 as no
    // record, so bytes are before it.
    let mut z64_empty = b"data".to_vec();
    z64_empty.extend_from_slice(b"PK\x06\x06");
    z64_empty.extend_from_slice(&44u64.to_le_bytes());
    z64_empty.extend_from_slice(&[45, 0, 45, 0]);
    z64_empty.extend_from_slice(&[0; 8 + 8 + 8 + 8]);
    z64_empty.extend_from_slice(&4u64.to_le_bytes());
    z64_empty.extend_from_slice(&locator(4));
    z64_empty.extend_from_slice(&end_record(0, 0, u32::MAX, 0));
    add("zip64-empty", z64_empty, opens(80, 4, &[]));
    // Many false records with a place in memory for their directory. They cost
    // no trial, in the walk or in the notes.
    let mut small_strays = Vec::new();
    for at in 0..40_u32 {
        let place = u32::try_from(eocd).unwrap() + 22 + at * 22;
        small_strays.extend_from_slice(&end_record(1, place - 10, 3, 0));
    }
    add(
        "many-small-strays",
        with_comment(&two, &small_strays),
        skipped(plain.clone(), 40),
    );
    // An empty archive right after an archive: the comment of the first record
    // ends where the second record starts, so it does not hold it. The listing
    // is empty, so nothing else tells of the first archive.
    let mut after_archive = with_comment(&two, b"");
    let second = after_archive.len() as u64;
    after_archive.extend_from_slice(&end_record(0, 0, u32::try_from(second).unwrap(), 0));
    add(
        "empty-after-archive",
        after_archive,
        another(opens(second, second, &[])),
    );
    // The comment of the true record ends where a fake record starts, so it does
    // not hold that record.
    let held_directory = fake.directory_bytes();
    let directly_after = eocd + END_BYTES + u64::from(fake_size);
    let mut after_comment = with_comment(&two, held_directory);
    after_comment.extend_from_slice(&end_record(1, fake_size, 0, 0));
    add(
        "fake-after-comment",
        after_comment,
        opens(
            directly_after,
            directly_after - u64::from(fake_size),
            &fake_row,
        ),
    );
    // A fake directory and record after an archive, outside its comment. The fake
    // row is the listing. The walk gives no note here. It keeps the true record in
    // `OpenedEnd::earlier`, and the parse removes that record if a row covers it.
    let mut appended = with_comment(&two, b"");
    let appended_directory = appended.len() as u64;
    let fake_after = body_with(b"", &[("FAKE.txt", b"fake")], b"");
    appended.extend_from_slice(fake_after.directory_bytes());
    let appended_eocd = appended.len() as u64;
    appended.extend_from_slice(&end_record(1, fake_after.directory_size, 0, 0));
    add(
        "fake-appended",
        appended,
        opens(appended_eocd, appended_directory, &["FAKE.txt"]),
    );

    // A comment with a complete fake record and a fake central directory.
    let fake_in_comment = |tail: &[u8], declared: u16| -> Vec<u8> {
        let mut comment = fake.directory_bytes().to_vec();
        comment.extend_from_slice(&end_record(1, fake_size, 0, declared));
        comment.extend_from_slice(tail);
        comment
    };
    let fake_eocd = eocd + END_BYTES + u64::from(fake_size);
    let fake_directory = eocd + END_BYTES;
    add(
        "fake-exact",
        with_comment(&two, &fake_in_comment(b"", 0)),
        another(opens(fake_eocd, fake_directory, &fake_row)),
    );
    add(
        "fake-short",
        with_comment(&two, &fake_in_comment(b"tail", 0)),
        another(opens(fake_eocd, fake_directory, &fake_row)),
    );
    add(
        "fake-with-comment",
        with_comment(&two, &fake_in_comment(b"tail", 4)),
        another(opens(fake_eocd, fake_directory, &fake_row)),
    );
    // The fake record is cut. The true record fits, so it wins.
    add(
        "fake-cut",
        with_comment(&two, &fake_in_comment(b"tail", 300)),
        another(plain.clone()),
    );
    // A fake record behind a locator. rawzip refuses it and takes the true record,
    // and Python extracts the fake entry. It is in the comment, or after the archive,
    // and in each place it can have a cut comment of its own.
    let start = eocd + END_BYTES;
    add(
        "fake-zip64-in-comment",
        with_comment(&two, &fake_behind_locator(start, 0)),
        another(plain.clone()),
    );
    add(
        "fake-zip64-in-comment-cut",
        with_comment(&two, &fake_behind_locator(start, 300)),
        another(plain.clone()),
    );
    // A fake directory only at the offset in a Zip64 record. The size in that record
    // gives no directory.
    let mut offset_only = fake_behind_locator(start, 0);
    let size_field = offset_only.len() - 22 - 20 - 56 + 40;
    offset_only[size_field] += 1;
    add(
        "fake-zip64-offset-only",
        with_comment(&two, &offset_only),
        another(plain.clone()),
    );
    let mut after = with_comment(&two, b"");
    after.extend_from_slice(&fake_behind_locator(start, 0));
    add("fake-zip64-after-archive", after, another(plain.clone()));
    let mut after = with_comment(&two, b"");
    after.extend_from_slice(&fake_behind_locator(start, 300));
    add(
        "fake-zip64-after-archive-cut",
        after,
        another(plain.clone()),
    );
    // One end record with two directories: its offset gives the rows of one, and
    // its size gives the rows of the other. A digital signature stops rawzip after
    // the first. Python extracts the second.
    let three = body_with(
        b"",
        &[
            ("a.txt", b"data a"),
            ("b.txt", b"data b"),
            ("B.txt", b"other"),
        ],
        b"",
    );
    let locals_bytes = usize::try_from(three.directory).unwrap();
    let rows_bytes = 2 * (46 + "a.txt".len());
    let records = three.directory_bytes();
    let mut two_directories = three.bytes[..locals_bytes].to_vec();
    two_directories.extend_from_slice(&records[..rows_bytes]);
    two_directories.extend_from_slice(b"PK\x05\x05\0\0");
    let second_size = u32::try_from(records.len() - rows_bytes).unwrap();
    two_directories.extend_from_slice(&records[rows_bytes..]);
    let mut with_classic = two_directories.clone();
    let classic_eocd = with_classic.len() as u64;
    with_classic.extend_from_slice(&end_record(1, second_size, three.declared, 0));
    add(
        "two-directories",
        with_classic,
        second_directory(opens(classic_eocd, three.directory, &names)),
    );
    // The same, with a Zip64 record at the fixed place. rawzip finds no record at
    // the offset in the locator, so it uses the classic fields. Python uses the
    // fixed place.
    let mut with_zip64 = two_directories.clone();
    let record_place = with_zip64.len() as u64;
    let locator_says = record_place - 5;
    with_zip64.extend_from_slice(&zip64_record(
        1,
        u64::from(second_size),
        locator_says - u64::from(second_size),
    ));
    with_zip64.extend_from_slice(&locator(locator_says));
    let zip64_eocd = with_zip64.len() as u64;
    with_zip64.extend_from_slice(&end_record(
        2,
        u32::try_from(zip64_eocd).unwrap() - u32::try_from(three.directory).unwrap(),
        three.declared,
        0,
    ));
    add(
        "two-directories-zip64",
        with_zip64,
        second_directory(opens(zip64_eocd, three.directory, &names)),
    );
    // A signature in the disk fields of the true record: the bytes after it are too
    // few for a record, and the search for the true record must stop before it.
    let mut in_disk_fields = with_comment(&two, b"");
    let disk_at = usize::try_from(eocd).unwrap() + 4;
    in_disk_fields[disk_at..disk_at + 4].copy_from_slice(END_SIGNATURE);
    add(
        "signature-in-disk-fields",
        in_disk_fields,
        skipped(plain.clone(), 1),
    );
    // A directory at offset 0, and a record whose size reaches back to exactly it.
    // Its comment holds the true archive.
    let at_zero = fake.directory_bytes().to_vec();
    let mut zero_head = at_zero.clone();
    zero_head.extend_from_slice(&[0; 22]);
    let inner = body_with(
        &zero_head,
        &[("a.txt", b"data a"), ("b.txt", b"data b")],
        b"",
    );
    let comment_bytes = inner.bytes.len() - zero_head.len() + 22;
    let mut zero_holder = inner.bytes.clone();
    let record = end_record(1, fake_size, 5, u16::try_from(comment_bytes).unwrap());
    zero_holder[at_zero.len()..zero_head.len()].copy_from_slice(&record);
    let zero_eocd = zero_holder.len() as u64;
    zero_holder.extend_from_slice(&end_record(2, inner.directory_size, inner.declared, 0));
    add(
        "directory-at-zero-holds-archive",
        zero_holder,
        another(opens(zero_eocd, inner.directory, &names)),
    );
    // A false offset at the true directory, and a fake directory at the place
    // that the size gives. rawzip reads the first, and the record ends in the
    // wrong place, so it is false here.
    let mut two_places = fake.directory_bytes().to_vec();
    two_places.extend_from_slice(&end_record(1, fake_size, two.declared, 0));
    add(
        "fake-two-directories",
        with_comment(&two, &two_places),
        another(plain.clone()),
    );
    // A fake directory only at the declared offset of a record in the comment,
    // and a false size. The true record holds that record, and its directory
    // ends at it, so it wins.
    let mut at_offset = fake.directory_bytes().to_vec();
    at_offset.extend_from_slice(&end_record(
        1,
        fake_size + 7,
        u32::try_from(eocd + END_BYTES).unwrap(),
        0,
    ));
    add(
        "fake-at-offset-only",
        with_comment(&two, &at_offset),
        another(plain.clone()),
    );
    // A fake empty archive at the place of its own record.
    let mut empty_comment = b"c:".to_vec();
    let empty_eocd = eocd + END_BYTES + 2;
    empty_comment.extend_from_slice(&end_record(0, 0, u32::try_from(empty_eocd).unwrap(), 0));
    add(
        "fake-empty",
        with_comment(&two, &empty_comment),
        another(opens(empty_eocd, empty_eocd, &[])),
    );

    // A signature in the central directory.
    let mut directory_comment = b"x PK\x05\x06 y".to_vec();
    directory_comment.extend_from_slice(&[b'z'; 30]);
    let in_directory = body_with(b"", &[("a.txt", b"hello")], &directory_comment);
    add(
        "stray-in-directory",
        with_comment(&in_directory, b""),
        opens(in_directory.eocd(), in_directory.directory, &["a.txt"]),
    );
    add(
        "stray-in-directory-cut",
        in_directory.bytes.clone(),
        Want::Fails(NO_RECORD),
    );

    // A signature in entry data.
    let mut stored = vec![0u8; 8];
    stored.extend_from_slice(END_SIGNATURE);
    stored.extend_from_slice(&[0; 40]);
    let in_data = body_with(b"", &[("a.bin", &stored), ("b.bin", b"tail")], b"");
    add(
        "stray-in-data",
        with_comment(&in_data, b""),
        opens(in_data.eocd(), in_data.directory, &["a.bin", "b.bin"]),
    );
    // The true record is gone. The signature in the data fits, and it has no
    // directory: the parse says so, as with rawzip alone.
    add(
        "stray-in-data-cut",
        in_data.bytes.clone(),
        parse_error(opens(8 + 30 + 5, 0, &[])),
    );
    // A stored zip in a zip. A file that lost the outer end record shows the
    // inner archive, as with rawzip alone.
    let inner = with_comment(&body_with(b"", &[("in.txt", b"inner")], b""), b"");
    let nested = body_with(b"", &[("inner.zip", &inner)], b"");
    let inner_at = 30 + "inner.zip".len() as u64;
    let inner_eocd = inner_at + inner.len() as u64 - END_BYTES;
    add(
        "nested",
        with_comment(&nested, b""),
        opens(nested.eocd(), nested.directory, &["inner.zip"]),
    );
    add(
        "nested-cut",
        nested.bytes.clone(),
        opens(inner_eocd, inner_eocd - (46 + 6), &["in.txt"]),
    );

    // A signature after the archive.
    let mut trailing_stray = with_comment(&two, b"");
    trailing_stray.extend_from_slice(b"trail PK\x05\x06 ");
    trailing_stray.extend_from_slice(&[b'y'; 40]);
    add("trailing-stray", trailing_stray, skipped(plain.clone(), 1));

    // The prefix repair after the walk.
    add(
        "prefix-stray",
        with_comment(&shifted, &stray_text),
        skipped(opens(shifted.eocd(), shifted.directory, &names), 1),
    );

    // Zip64.
    let z64 = zip64(b"", b"");
    let z64_eocd = z64.len() as u64 - END_BYTES;
    add("zip64", z64.clone(), opens(z64_eocd, 45, &["a.txt"]));
    add(
        "zip64-stray",
        zip64(b"", &stray_text),
        skipped(opens(z64_eocd, 45, &["a.txt"]), 1),
    );
    // Rawzip has no prefix repair for Zip64 (R1 in the rawzip notes): this file
    // stays as it is with rawzip alone.
    add(
        "zip64-prefix",
        zip64(b"prefix-bytes", b""),
        Want::Fails(INVALID),
    );
    add(
        "zip64-prefix-stray",
        zip64(b"prefix-bytes", &stray_text),
        Want::Fails(INVALID),
    );

    // A Zip64 record that holds a fake record at the far end of its longest
    // comment. The locator of the true record is at the edge of the kept bytes.
    let filler_bytes = usize::from(u16::MAX) - fake.directory_bytes().len() - 22;
    let mut long = vec![b'f'; filler_bytes];
    long.extend_from_slice(fake.directory_bytes());
    long.extend_from_slice(&end_record(1, fake_size, 0, 0));
    let long_zip64 = zip64(b"", &long);
    let long_eocd = long_zip64.len() as u64 - 22;
    add(
        "fake-after-long-zip64-comment",
        long_zip64,
        another(opens(
            long_eocd,
            long_eocd - u64::from(fake_size),
            &fake_row,
        )),
    );
    // A cut Zip64 record holds the fake record. Only its Zip64 record gives its
    // directory, so only a call of rawzip for a cut record can tell.
    let mut in_cut = fake.directory_bytes().to_vec();
    in_cut.extend_from_slice(&end_record(1, fake_size, 0, 0));
    let mut cut_zip64 = zip64(b"", &in_cut);
    let field = cut_zip64.len() - in_cut.len() - 2;
    cut_zip64[field..field + 2].copy_from_slice(&5000u16.to_le_bytes());
    let cut_eocd = cut_zip64.len() as u64 - 22;
    add(
        "fake-in-cut-zip64",
        cut_zip64,
        another(opens(cut_eocd, cut_eocd - u64::from(fake_size), &fake_row)),
    );
    // The record that holds the fake record has its directory only at its
    // declared offset, so it is weak. It still counts as another record.
    let mut weak_holder = two.bytes.clone();
    let mut held = fake.directory_bytes().to_vec();
    held.extend_from_slice(&end_record(1, fake_size, 0, 0));
    weak_holder.extend_from_slice(&end_record(
        two.count,
        two.directory_size + 7,
        two.declared,
        u16::try_from(held.len()).unwrap(),
    ));
    weak_holder.extend_from_slice(&held);
    let weak_eocd = weak_holder.len() as u64 - 22;
    add(
        "fake-in-weak-holder",
        weak_holder,
        another(opens(
            weak_eocd,
            weak_eocd - u64::from(fake_size),
            &fake_row,
        )),
    );
    // A Zip64 record holds a copy of a record with its directory far away. The
    // copy is weak. The Zip64 record is strong, so it wins.
    let z64_body = body_with(b"", &[("a.txt", b"zip64 body")], b"");
    let z64_copy = end_record(1, z64_body.directory_size + 9, z64_body.declared, 0);
    add(
        "zip64-holds-copy",
        zip64(b"", &z64_copy),
        skipped(opens(z64_eocd, 45, &["a.txt"]), 1),
    );
    // The same, with a Zip64 size that does not reach the Zip64 record. It is not
    // strong, so the weak copy stays the choice, and the parse reports its error.
    let mut false_size_zip64 = zip64(b"", &z64_copy);
    let size_field = usize::try_from(z64_body.eocd()).unwrap() + 40;
    let false_size = u64::from(z64_body.directory_size) + 1;
    false_size_zip64[size_field..size_field + 8].copy_from_slice(&false_size.to_le_bytes());
    add(
        "false-zip64-holds-copy",
        false_size_zip64,
        parse_error(opens(z64_eocd + END_BYTES, 45, &["a.txt"])),
    );
    // A false record holds a weak copy, and a true archive is before them. The false
    // record is not strong, so the copy stays the choice.
    let mut false_holder = with_comment(&two, b"");
    let false_copy = end_record(two.count, two.directory_size + 9, two.declared, 0);
    false_holder.extend_from_slice(&end_record(1, 60, 3, 22));
    let copy_eocd = false_holder.len() as u64;
    false_holder.extend_from_slice(&false_copy);
    add(
        "false-record-holds-copy",
        false_holder,
        parse_error(opens(copy_eocd, directory, &names)),
    );
    // A record with a directory at its size and another at its offset holds a weak
    // copy. It has two directories, so it is not strong, and the copy stays the choice.
    let mut two_places_holder = two.bytes.clone();
    two_places_holder.extend_from_slice(fake.directory_bytes());
    two_places_holder.extend_from_slice(&end_record(1, fake_size, two.declared, 22));
    let weak_copy_eocd = two_places_holder.len() as u64;
    two_places_holder.extend_from_slice(&false_copy);
    add(
        "two-directories-hold-copy",
        two_places_holder,
        another(parse_error(opens(
            weak_copy_eocd,
            directory,
            &["a.txt", "b.txt", "FAKE.txt"],
        ))),
    );
    // A true Zip64 archive with real values in its classic fields. Its first record
    // is exactly as long as the Zip64 record and the locator, so the classic size
    // gives a place with a directory signature. The Zip64 record gives the chosen
    // directory, so that place does not count, and the file gets no warning.
    let long_name = "a".repeat(30);
    let classic_values = body_with(b"", &[(&long_name, b"x"), ("b.txt", b"y")], b"");
    let mut real_values = classic_values.bytes.clone();
    let classic_record = classic_values.eocd();
    real_values.extend_from_slice(&zip64_record(
        2,
        u64::from(classic_values.directory_size),
        u64::from(classic_values.declared),
    ));
    real_values.extend_from_slice(&locator(classic_record));
    let classic_eocd_place = real_values.len() as u64;
    real_values.extend_from_slice(&end_record(
        2,
        classic_values.directory_size,
        classic_values.declared,
        0,
    ));
    add(
        "zip64-with-classic-values",
        real_values,
        opens(
            classic_eocd_place,
            classic_values.directory,
            &["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "b.txt"],
        ),
    );
    // A false locator next to a true classic record: the comment of the last
    // entry ends with its bytes. rawzip reads the record as classic.
    let false_locator = locator(1 << 40);
    let with_locator = body_with(b"", &[("a.txt", b"data a")], &false_locator);
    add(
        "false-locator",
        with_comment(&with_locator, b""),
        opens(with_locator.eocd(), with_locator.directory, &["a.txt"]),
    );
    let prefixed_locator = body_with(prefix, &[("a.txt", b"data a")], &false_locator);
    add(
        "false-locator-prefix",
        with_comment(&prefixed_locator, b""),
        opens(
            prefixed_locator.eocd(),
            prefixed_locator.directory,
            &["a.txt"],
        ),
    );
    add(
        "false-locator-prefix-stray",
        with_comment(&prefixed_locator, &stray_text),
        skipped(
            opens(
                prefixed_locator.eocd(),
                prefixed_locator.directory,
                &["a.txt"],
            ),
            1,
        ),
    );

    // Files that are no archive.
    add(
        "not-a-zip",
        b"This is not a zip archive at all.\n".repeat(10),
        Want::Fails(NO_SIGNATURE),
    );
    add("empty-file", Vec::new(), Want::Fails(NO_SIGNATURE));
    add("one-byte", b"P".to_vec(), Want::Fails(NO_SIGNATURE));
    add(
        "only-a-signature",
        END_SIGNATURE.to_vec(),
        Want::Fails(NO_RECORD),
    );
    add(
        "signatures-64",
        END_SIGNATURE.repeat(64),
        Want::Fails(NO_RECORD),
    );
    add(
        "signatures-1-mib",
        END_SIGNATURE.repeat(1 << 18),
        Want::Fails(NO_RECORD),
    );
    let whole = with_comment(&two, b"");
    let half = whole.len() / 2;
    add(
        "truncated-half",
        whole[..half].to_vec(),
        Want::Fails(NO_SIGNATURE),
    );
    add(
        "truncated-by-3",
        whole[..whole.len() - 3].to_vec(),
        Want::Fails(NO_RECORD),
    );
    add(
        "truncated-by-23",
        whole[..whole.len() - 23].to_vec(),
        Want::Fails(NO_SIGNATURE),
    );
    shapes
}
