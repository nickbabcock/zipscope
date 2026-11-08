//! The worker-owned store: column pages, the name and comment arenas, and
//! a side arena for raw names.

use zipscope_heap::{Full, Room, try_with_capacity};

use crate::arena::Arena;
use crate::contract::{Column, PAGE_ROWS};

/// The values of one row, before the store adds the name and comment to the
/// arenas.
#[derive(Debug, Clone, Default)]
pub struct Row<'a> {
    pub uncompressed_size: f64,
    pub compressed_size: f64,
    pub local_header_offset: f64,
    pub modified: f64,
    /// The decoded UTF-8 name.
    pub name: &'a [u8],
    /// The decoded UTF-8 comment.
    pub comment: &'a [u8],
    pub crc32: u32,
    pub external_attributes: u32,
    pub method: u16,
    pub flags: u16,
    pub version_made_by: u16,
    pub aes_method: u16,
    pub name_source: u8,
    pub time_kind: u8,
    pub encryption: u8,
    pub marks: u8,
}

/// An arena is full, so the row was not added.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreFull {
    Names,
    Comments,
    /// The memory budget has no room for the row.
    Memory,
}

impl std::fmt::Display for StoreFull {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreFull::Names => f.write_str("The name arena is full"),
            StoreFull::Comments => f.write_str("The comment arena is full"),
            StoreFull::Memory => std::fmt::Display::fmt(&Full, f),
        }
    }
}

/// The columns of one page, in contract order. Each column has the
/// capacity for `PAGE_ROWS` values, so it never moves.
#[derive(Debug)]
struct Page {
    uncompressed_size: Vec<f64>,
    compressed_size: Vec<f64>,
    local_header_offset: Vec<f64>,
    modified: Vec<f64>,
    name_offset: Vec<u32>,
    name_length: Vec<u32>,
    comment_offset: Vec<u32>,
    comment_length: Vec<u32>,
    crc32: Vec<u32>,
    external_attributes: Vec<u32>,
    method: Vec<u16>,
    flags: Vec<u16>,
    version_made_by: Vec<u16>,
    aes_method: Vec<u16>,
    name_source: Vec<u8>,
    time_kind: Vec<u8>,
    encryption: Vec<u8>,
    marks: Vec<u8>,
}

fn column<T>() -> Result<Vec<T>, Full> {
    try_with_capacity(PAGE_ROWS)
}

impl Page {
    /// Allocates a page at its full size.
    fn try_new() -> Result<Self, Full> {
        Ok(Page {
            uncompressed_size: column()?,
            compressed_size: column()?,
            local_header_offset: column()?,
            modified: column()?,
            name_offset: column()?,
            name_length: column()?,
            comment_offset: column()?,
            comment_length: column()?,
            crc32: column()?,
            external_attributes: column()?,
            method: column()?,
            flags: column()?,
            version_made_by: column()?,
            aes_method: column()?,
            name_source: column()?,
            time_kind: column()?,
            encryption: column()?,
            marks: column()?,
        })
    }

    fn push(&mut self, row: &Row, name: (u32, u32), comment: (u32, u32)) {
        self.uncompressed_size.push(row.uncompressed_size);
        self.compressed_size.push(row.compressed_size);
        self.local_header_offset.push(row.local_header_offset);
        self.modified.push(row.modified);
        self.name_offset.push(name.0);
        self.name_length.push(name.1);
        self.comment_offset.push(comment.0);
        self.comment_length.push(comment.1);
        self.crc32.push(row.crc32);
        self.external_attributes.push(row.external_attributes);
        self.method.push(row.method);
        self.flags.push(row.flags);
        self.version_made_by.push(row.version_made_by);
        self.aes_method.push(row.aes_method);
        self.name_source.push(row.name_source);
        self.time_kind.push(row.time_kind);
        self.encryption.push(row.encryption);
        self.marks.push(row.marks);
    }

    fn ptr(&self, column: Column) -> *const u8 {
        match column {
            Column::UncompressedSize => self.uncompressed_size.as_ptr().cast(),
            Column::CompressedSize => self.compressed_size.as_ptr().cast(),
            Column::LocalHeaderOffset => self.local_header_offset.as_ptr().cast(),
            Column::Modified => self.modified.as_ptr().cast(),
            Column::NameOffset => self.name_offset.as_ptr().cast(),
            Column::NameLength => self.name_length.as_ptr().cast(),
            Column::CommentOffset => self.comment_offset.as_ptr().cast(),
            Column::CommentLength => self.comment_length.as_ptr().cast(),
            Column::Crc32 => self.crc32.as_ptr().cast(),
            Column::ExternalAttributes => self.external_attributes.as_ptr().cast(),
            Column::Method => self.method.as_ptr().cast(),
            Column::Flags => self.flags.as_ptr().cast(),
            Column::VersionMadeBy => self.version_made_by.as_ptr().cast(),
            Column::AesMethod => self.aes_method.as_ptr().cast(),
            Column::NameSource => self.name_source.as_ptr(),
            Column::TimeKind => self.time_kind.as_ptr(),
            Column::Encryption => self.encryption.as_ptr(),
            Column::Marks => self.marks.as_ptr(),
        }
    }

    fn value(&self, index: usize, column: Column) -> f64 {
        match column {
            Column::UncompressedSize => self.uncompressed_size[index],
            Column::CompressedSize => self.compressed_size[index],
            Column::LocalHeaderOffset => self.local_header_offset[index],
            Column::Modified => self.modified[index],
            Column::NameOffset => f64::from(self.name_offset[index]),
            Column::NameLength => f64::from(self.name_length[index]),
            Column::CommentOffset => f64::from(self.comment_offset[index]),
            Column::CommentLength => f64::from(self.comment_length[index]),
            Column::Crc32 => f64::from(self.crc32[index]),
            Column::ExternalAttributes => f64::from(self.external_attributes[index]),
            Column::Method => f64::from(self.method[index]),
            Column::Flags => f64::from(self.flags[index]),
            Column::VersionMadeBy => f64::from(self.version_made_by[index]),
            Column::AesMethod => f64::from(self.aes_method[index]),
            Column::NameSource => f64::from(self.name_source[index]),
            Column::TimeKind => f64::from(self.time_kind[index]),
            Column::Encryption => f64::from(self.encryption[index]),
            Column::Marks => f64::from(self.marks[index]),
        }
    }
}

/// The raw bytes of the names that were decoded with loss.
#[derive(Debug, Default)]
struct RawNames {
    bytes: Vec<u8>,
    /// (row, start, end) in row order.
    rows: Vec<(usize, usize, usize)>,
}

/// The most page slots that the EOCD entry count can reserve. The count is
/// only a hint, because an archive can give a false count.
const MAX_HINT_PAGES: usize = 16;

/// The most bytes of one stored name or comment. A field has at most
/// 65,535 bytes, and a decode gives at most 3 bytes for each raw byte (a
/// CP437 character or a U+FFFD replacement).
pub const MAX_ROW_TEXT_BYTES: usize = 3 * 0xffff;

/// Rows in 64k-row pages and names and comments in arenas. Memory grows
/// only when rows are added. A page is allocated at its full size and never
/// moves, so the worker can copy from it by pointer.
#[derive(Debug, Default)]
pub struct Store {
    pages: Vec<Page>,
    /// A page that [`Store::prepare`] allocated for the next row.
    spare: Option<Page>,
    rows: usize,
    names: Arena,
    comments: Arena,
    raw_names: RawNames,
}

impl Store {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Makes a store for an archive that declares `entries`. The count only
    /// reserves a small, clamped list of page slots. It allocates no page.
    #[must_use]
    pub fn with_hint(entries: u64) -> Self {
        let pages = entries
            .div_ceil(PAGE_ROWS as u64)
            .min(MAX_HINT_PAGES as u64);
        Store {
            pages: Vec::with_capacity(usize::try_from(pages).unwrap_or(MAX_HINT_PAGES)),
            ..Self::default()
        }
    }

    /// Allocates what a push of a row needs: a new page, new arena chunks
    /// and room for the raw name. The rows do not change.
    ///
    /// # Errors
    ///
    /// Returns [`Full`] when the memory budget has no room.
    pub fn prepare(&mut self, row: &Row, raw_name: Option<&[u8]>) -> Result<(), Full> {
        self.names.prepare(row.name.len())?;
        if !row.comment.is_empty() || self.comments.chunk_count() != 0 {
            self.comments.prepare(row.comment.len())?;
        }
        if self.rows == self.pages.len() * PAGE_ROWS && self.spare.is_none() {
            self.pages.room(1)?;
            self.spare = Some(Page::try_new()?);
        }
        if let Some(raw) = raw_name {
            self.raw_names.bytes.room(raw.len())?;
            self.raw_names.rows.room(1)?;
        }
        Ok(())
    }

    /// Adds a row. `raw_name` is the raw name when the decode had loss. The
    /// store keeps it in the side arena.
    ///
    /// # Errors
    ///
    /// Returns `StoreFull` if the name or comment arena exceeds its size limit.
    ///
    /// # Panics
    ///
    /// Panics in debug builds if a name or comment exceeds one arena chunk.
    pub fn push(&mut self, row: &Row, raw_name: Option<&[u8]>) -> Result<(), StoreFull> {
        self.prepare(row, raw_name)
            .map_err(|_full| StoreFull::Memory)?;
        let name_offset = self.names.push(row.name).map_err(|_err| StoreFull::Names)?;
        // Most entries have no comment. An empty comment before the first
        // chunk does not allocate a chunk, and its offset is 0. After that,
        // the arena rules apply.
        let comment_offset = if row.comment.is_empty() && self.comments.chunk_count() == 0 {
            0
        } else {
            self.comments
                .push(row.comment)
                .map_err(|_err| StoreFull::Comments)?
        };
        if self.rows == self.pages.len() * PAGE_ROWS {
            let page = self.spare.take().ok_or(StoreFull::Memory)?;
            self.pages.push(page);
        }
        if let Some(raw) = raw_name {
            let start = self.raw_names.bytes.len();
            self.raw_names.bytes.extend_from_slice(raw);
            let end = self.raw_names.bytes.len();
            self.raw_names.rows.push((self.rows, start, end));
        }
        let page = self.pages.last_mut().expect("a page exists");
        page.push(
            row,
            (
                name_offset,
                u32::try_from(row.name.len()).map_err(|_err| StoreFull::Names)?,
            ),
            (
                comment_offset,
                u32::try_from(row.comment.len()).map_err(|_err| StoreFull::Comments)?,
            ),
        );
        self.rows += 1;
        Ok(())
    }

    /// Returns the most bytes that the push of the next row can allocate
    /// in the pages and the arena chunks, which the mirrors copy: a page
    /// when the next row starts one, and a chunk for each arena whose last
    /// chunk can be too full for the text of one row
    /// (`MAX_ROW_TEXT_BYTES`). It does not count the first chunk of the
    /// comment arena (see `Store::has_comment_chunk`).
    #[must_use]
    pub fn next_growth_bound(&self) -> usize {
        use crate::contract::{CHUNK_BYTES, PAGE_BYTES};
        let page = self.rows == self.pages.len() * PAGE_ROWS && self.spare.is_none();
        let names = self.names.may_need_chunk(MAX_ROW_TEXT_BYTES);
        let comments =
            self.comments.chunk_count() != 0 && self.comments.may_need_chunk(MAX_ROW_TEXT_BYTES);
        usize::from(page) * PAGE_BYTES + (usize::from(names) + usize::from(comments)) * CHUNK_BYTES
    }

    /// Returns true when the comment arena has a chunk. Before the first
    /// comment, it has none, and the first comment allocates one.
    #[must_use]
    pub fn has_comment_chunk(&self) -> bool {
        self.comments.chunk_count() != 0
    }

    /// Returns the number of rows.
    #[must_use]
    pub fn rows(&self) -> usize {
        self.rows
    }

    /// Returns the number of pages.
    #[must_use]
    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    fn page(&self, row: usize) -> (&Page, usize) {
        (&self.pages[row / PAGE_ROWS], row % PAGE_ROWS)
    }

    /// Returns the name of a row.
    #[must_use]
    pub fn name(&self, row: usize) -> &[u8] {
        let (page, index) = self.page(row);
        self.names
            .get(page.name_offset[index], page.name_length[index])
    }

    /// Returns the name offset of a row in the name arena.
    #[must_use]
    pub fn name_offset(&self, row: usize) -> u32 {
        let (page, index) = self.page(row);
        page.name_offset[index]
    }

    /// Sets bits in the `marks` column of a row.
    pub fn add_marks(&mut self, row: usize, bits: u8) {
        let page = &mut self.pages[row / PAGE_ROWS];
        page.marks[row % PAGE_ROWS] |= bits;
    }

    /// Returns the `marks` value of a row.
    #[must_use]
    pub fn marks(&self, row: usize) -> u8 {
        let (page, index) = self.page(row);
        page.marks[index]
    }

    /// Returns the bytes that the store has allocated.
    #[must_use]
    pub fn allocated_bytes(&self) -> usize {
        use crate::contract::PAGE_BYTES;
        (self.pages.len() + usize::from(self.spare.is_some())) * PAGE_BYTES
            + self.pages.capacity() * size_of::<Page>()
            + self.names.allocated_bytes()
            + self.comments.allocated_bytes()
            + self.raw_names.bytes.capacity()
            + self.raw_names.rows.capacity() * size_of::<(usize, usize, usize)>()
    }

    /// Returns the comment of a row.
    #[must_use]
    pub fn comment(&self, row: usize) -> &[u8] {
        let (page, index) = self.page(row);
        match page.comment_length[index] {
            0 => &[],
            length => self.comments.get(page.comment_offset[index], length),
        }
    }

    /// Returns the raw name of a row, if its decode had loss.
    #[must_use]
    pub fn raw_name(&self, row: usize) -> Option<&[u8]> {
        let rows = &self.raw_names.rows;
        let found = rows.binary_search_by_key(&row, |&(row, _, _)| row).ok()?;
        let (_, start, end) = rows[found];
        Some(&self.raw_names.bytes[start..end])
    }

    /// Returns the value of a column in a row, as f64. Tests use it.
    #[must_use]
    pub fn value(&self, row: usize, column: Column) -> f64 {
        let (page, index) = self.page(row);
        page.value(index, column)
    }

    /// Returns a pointer to the first value of a column in a page, or null
    /// when the page does not exist. Values for all rows of the page follow
    /// without gaps.
    #[must_use]
    pub fn column_ptr(&self, page: usize, column: Column) -> *const u8 {
        match self.pages.get(page) {
            Some(page) => page.ptr(column),
            None => std::ptr::null(),
        }
    }

    /// Returns the name arena.
    #[must_use]
    pub fn names(&self) -> &Arena {
        &self.names
    }

    /// Returns the comment arena.
    #[must_use]
    pub fn comments(&self) -> &Arena {
        &self.comments
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(name: &str) -> Row<'_> {
        Row {
            name: name.as_bytes(),
            ..Row::default()
        }
    }

    #[test]
    fn adds_pages_as_rows_arrive() {
        let mut store = Store::new();
        assert_eq!(store.page_count(), 0);
        assert!(store.column_ptr(0, Column::NameOffset).is_null());
        for i in 0..=PAGE_ROWS {
            store.push(&named(&format!("f{i}")), None).unwrap();
        }
        assert_eq!(store.rows(), PAGE_ROWS + 1);
        assert_eq!(store.page_count(), 2);
        assert_eq!(store.name(0), b"f0");
        assert_eq!(store.name(PAGE_ROWS), format!("f{PAGE_ROWS}").as_bytes());
        for column in Column::ALL {
            assert!(!store.column_ptr(1, column).is_null());
        }
        assert!(store.column_ptr(2, Column::Crc32).is_null());
    }

    #[test]
    fn pages_do_not_move() {
        let mut store = Store::new();
        store.push(&named("first"), None).unwrap();
        let before: Vec<_> = Column::ALL
            .iter()
            .map(|&column| store.column_ptr(0, column))
            .collect();
        for _ in 1..PAGE_ROWS {
            store.push(&named("x"), None).unwrap();
        }
        let after: Vec<_> = Column::ALL
            .iter()
            .map(|&column| store.column_ptr(0, column))
            .collect();
        assert_eq!(before, after);
    }

    #[test]
    fn keeps_every_column() {
        let mut store = Store::new();
        let row = Row {
            uncompressed_size: 2f64.powi(40),
            compressed_size: 3.0,
            local_header_offset: 4.0,
            modified: 5.0,
            name: b"name",
            comment: b"comment",
            crc32: 6,
            external_attributes: 7,
            method: 8,
            flags: 9,
            version_made_by: 10,
            aes_method: 11,
            name_source: 12,
            time_kind: 13,
            encryption: 14,
            marks: 15,
        };
        store.push(&row, None).unwrap();
        let expected = [
            2f64.powi(40),
            3.0,
            4.0,
            5.0,
            0.0,
            4.0,
            0.0,
            7.0,
            6.0,
            7.0,
            8.0,
            9.0,
            10.0,
            11.0,
            12.0,
            13.0,
            14.0,
            15.0,
        ];
        for (column, value) in Column::ALL.iter().zip(expected) {
            assert_eq!(store.value(0, *column), value, "{column:?}");
        }
        assert_eq!(store.comment(0), b"comment");
    }

    #[test]
    fn empty_comments_allocate_no_chunk() {
        let mut store = Store::new();
        store.push(&named("a"), None).unwrap();
        assert_eq!(store.comments().chunk_count(), 0);
        assert_eq!(store.comment(0), b"");
        let row = Row {
            comment: b"hello",
            ..named("b")
        };
        store.push(&row, None).unwrap();
        store.push(&named("c"), None).unwrap();
        assert_eq!(store.comments().chunk_count(), 1);
        assert_eq!(store.comment(1), b"hello");
        assert_eq!(store.comment(2), b"");
        // After the first chunk, an empty comment follows the arena rules.
        assert_eq!(store.value(2, Column::CommentOffset), 5.0);
    }

    #[test]
    fn keeps_raw_names_only_when_given() {
        let mut store = Store::new();
        store.push(&named("a"), None).unwrap();
        store.push(&named("b\u{fffd}"), Some(b"b\xff")).unwrap();
        store.push(&named("c"), None).unwrap();
        assert_eq!(store.raw_name(0), None);
        assert_eq!(store.raw_name(1), Some(&b"b\xff"[..]));
        assert_eq!(store.raw_name(2), None);
    }

    #[test]
    fn the_hint_is_clamped_and_allocates_no_page() {
        let store = Store::with_hint(u64::MAX);
        assert_eq!(store.page_count(), 0);
        assert!(store.pages.capacity() <= MAX_HINT_PAGES);
        assert_eq!(Store::with_hint(0).pages.capacity(), 0);
    }
}
