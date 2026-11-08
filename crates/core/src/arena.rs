//! An append-only byte arena in fixed chunks.

use zipscope_heap::{Full, Room, try_with_capacity};

use crate::contract::{CHUNK_BITS, CHUNK_BYTES, MAX_CHUNKS};

/// The arena has no space for more bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArenaFull;

/// Append-only bytes in chunks of `CHUNK_BYTES`. A value never spans chunks,
/// and a chunk never moves after it is allocated. An offset is
/// `chunk << CHUNK_BITS | position`.
#[derive(Debug, Default)]
pub struct Arena {
    chunks: Vec<Vec<u8>>,
    /// A chunk that [`Arena::prepare`] allocated for the next push.
    spare: Option<Vec<u8>>,
}

impl Arena {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn needs_chunk(&self, length: usize) -> bool {
        match self.chunks.last() {
            None => true,
            Some(chunk) => chunk.len() + length > CHUNK_BYTES,
        }
    }

    /// Allocates what a push of a value of `length` bytes needs: a new
    /// chunk when the value does not fit in the last chunk. The arena does
    /// not change until the push.
    ///
    /// # Errors
    ///
    /// Returns [`Full`] when the memory budget has no room for the chunk.
    pub fn prepare(&mut self, length: usize) -> Result<(), Full> {
        if self.spare.is_none()
            && self.needs_chunk(length)
            && self.chunks.len() < MAX_CHUNKS
            && length <= CHUNK_BYTES
        {
            self.chunks.room(1)?;
            self.spare = Some(try_with_capacity(CHUNK_BYTES)?);
        }
        Ok(())
    }

    /// Appends a value and returns its offset. The first push allocates the
    /// first chunk, also for an empty value. A value that does not fit in the
    /// remaining space of the last chunk starts a new chunk.
    ///
    /// # Errors
    ///
    /// Returns `ArenaFull` if the value or the arena exceeds its size limit.
    pub fn push(&mut self, value: &[u8]) -> Result<u32, ArenaFull> {
        debug_assert!(value.len() <= CHUNK_BYTES);
        if self.needs_chunk(value.len()) {
            if self.chunks.len() == MAX_CHUNKS || value.len() > CHUNK_BYTES {
                return Err(ArenaFull);
            }
            self.prepare(value.len()).map_err(|_full| ArenaFull)?;
            let chunk = self.spare.take().ok_or(ArenaFull)?;
            self.chunks.push(chunk);
        }
        let index = self.chunks.len() - 1;
        let chunk = &mut self.chunks[index];
        // An empty value at the end of a full chunk keeps a position inside
        // the chunk, so its offset does not point at the next chunk.
        let position = chunk.len().min(CHUNK_BYTES - 1);
        chunk.extend_from_slice(value);
        Ok(
            ((u32::try_from(index).map_err(|_err| ArenaFull)?) << CHUNK_BITS)
                | u32::try_from(position).map_err(|_err| ArenaFull)?,
        )
    }

    /// Returns the value at an offset.
    #[must_use]
    pub fn get(&self, offset: u32, length: u32) -> &[u8] {
        let chunk = &self.chunks[(offset >> CHUNK_BITS) as usize];
        let start = (offset as usize) & (CHUNK_BYTES - 1);
        &chunk[start..start + length as usize]
    }

    /// Returns true when a push of at most `length` bytes can allocate a
    /// new chunk: no chunk is ready and the last chunk can have less room
    /// than `length`.
    #[must_use]
    pub fn may_need_chunk(&self, length: usize) -> bool {
        self.spare.is_none() && self.chunks.len() < MAX_CHUNKS && self.needs_chunk(length)
    }

    /// Returns the number of chunks.
    #[must_use]
    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }

    /// Returns the filled bytes of a chunk.
    #[must_use]
    pub fn chunk(&self, index: usize) -> &[u8] {
        &self.chunks[index]
    }

    /// Returns the bytes that the arena has allocated.
    #[must_use]
    pub fn allocated_bytes(&self) -> usize {
        (self.chunks.len() + usize::from(self.spare.is_some())) * CHUNK_BYTES
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_nothing_until_the_first_push() {
        let mut arena = Arena::new();
        assert_eq!(arena.chunk_count(), 0);
        assert_eq!(arena.push(b"").unwrap(), 0);
        assert_eq!(arena.chunk_count(), 1);
        assert_eq!(arena.push(b"abc").unwrap(), 0);
        assert_eq!(arena.push(b"de").unwrap(), 3);
        assert_eq!(arena.get(3, 2), b"de");
        assert_eq!(arena.chunk(0), b"abcde");
    }

    #[test]
    fn values_never_span_chunks() {
        let mut arena = Arena::new();
        let value = vec![7u8; 60_000];
        let mut offsets = Vec::new();
        for _ in 0..80 {
            offsets.push(arena.push(&value).unwrap());
        }
        assert_eq!(arena.chunk_count(), 2);
        let per_chunk = CHUNK_BYTES / value.len();
        let first_in_second = offsets[per_chunk];
        assert_eq!(first_in_second, 1 << CHUNK_BITS);
        assert_eq!(arena.chunk(0).len(), per_chunk * value.len());
        for offset in offsets {
            assert_eq!(
                arena.get(offset, u32::try_from(value.len()).unwrap()),
                &*value
            );
        }
    }

    #[test]
    fn empty_values_do_not_start_a_chunk() {
        let mut arena = Arena::new();
        arena.push(&vec![1u8; CHUNK_BYTES]).unwrap();
        assert_eq!(
            arena.push(b"").unwrap(),
            u32::try_from(CHUNK_BYTES).unwrap() - 1
        );
        assert_eq!(arena.chunk_count(), 1);
        assert_eq!(arena.push(b"x").unwrap(), 1 << CHUNK_BITS);
        assert_eq!(arena.chunk_count(), 2);
    }
}
