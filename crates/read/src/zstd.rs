//! The Zstandard decoder for entry data: the C zstd library.
//!
//! The compressed range of an entry can hold more than one frame, and
//! skippable frames. The decoders decode all frames in the range, and the
//! verifying reader of rawzip checks the size and the CRC-32 of the
//! combined output.
//!
//! The window of a frame sets the memory of the decoder, and the window
//! size is a value in the archive. Thus the decoder refuses a frame that
//! needs a window of more than [`MAX_WINDOW_BYTES`]. It does not support
//! dictionaries.

/// The log2 of [`MAX_WINDOW_BYTES`].
pub const MAX_WINDOW_LOG: u32 = 25;

/// The largest window that the decoder accepts: 32 MiB.
///
/// Zstandard levels 1 to 20 use a window of this size or smaller. Levels 21
/// and 22, and long mode, can use a larger window; the decoder refuses
/// those frames.
pub const MAX_WINDOW_BYTES: u64 = 1 << MAX_WINDOW_LOG;

/// The window limit for a memory limit of `bytes`: the largest power of two
/// that is not more than `bytes` and not more than [`MAX_WINDOW_BYTES`].
/// `None` when `bytes` is less than the smallest window of the format.
#[must_use]
pub fn window_log_for(bytes: u64) -> Option<u32> {
    if bytes < 1 << 10 {
        return None;
    }
    Some(bytes.ilog2().min(MAX_WINDOW_LOG))
}

/// The window limit of a stream, which the caller can change.
///
/// The read worker changes it before each read, because the memory limit
/// changes while the parse worker grows the store. A decoder reads it at
/// the start of each frame, before it allocates the window of the frame.
///
/// Each `set` also starts a new call. A decoder allocates at most one new
/// window in one call: when a later frame of the same call needs a larger
/// window, the decoder stops at the frame boundary with [`pause`], and the
/// next call allocates the window under a new memory cap.
#[derive(Debug, Clone)]
pub struct WindowLimit(std::rc::Rc<(std::cell::Cell<u64>, std::cell::Cell<u64>)>);

impl WindowLimit {
    #[must_use]
    pub fn new(bytes: u64) -> Self {
        WindowLimit(std::rc::Rc::new((
            std::cell::Cell::new(bytes),
            std::cell::Cell::new(0),
        )))
    }

    /// Sets the limit for the frames that start after this call, and starts
    /// a new call.
    pub fn set(&self, bytes: u64) {
        self.0.0.set(bytes);
        self.0.1.set(self.0.1.get().wrapping_add(1));
    }

    #[must_use]
    pub fn get(&self) -> u64 {
        self.0.0.get()
    }

    /// Starts a new call with the same limit.
    pub fn next_call(&self) {
        self.0.1.set(self.0.1.get().wrapping_add(1));
    }

    /// The number of the current call.
    #[must_use]
    pub fn call(&self) -> u64 {
        self.0.1.get()
    }
}

/// The error that stops a call at a frame boundary, before a frame that
/// needs a new window. It is not a decode error: the next call continues.
#[must_use]
pub fn pause() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::WouldBlock,
        "A Zstandard frame needs a new window, which the next call allocates",
    )
}

/// True for the error of [`pause`].
#[must_use]
pub fn is_pause(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::WouldBlock
}

/// The window of the frame header at the start of `bytes`, or `None` for a
/// skippable frame, a header that `bytes` does not hold in full, or no
/// frame (the decoder then reports the error).
#[must_use]
pub fn header_window(bytes: &[u8]) -> Option<u64> {
    let magic = u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?);
    if magic != 0xFD2F_B528 {
        return None;
    }
    let descriptor = *bytes.get(4)?;
    if descriptor & 0x20 == 0 {
        let window = *bytes.get(5)?;
        let base = 1u64 << (10 + u64::from(window >> 3));
        return Some(base + base / 8 * u64::from(window & 7));
    }
    // A single segment: the window is the content size.
    let dictionary = [0, 1, 2, 4][usize::from(descriptor & 3)];
    let size = [1, 2, 4, 8][usize::from(descriptor >> 6)];
    let field = bytes.get(5 + dictionary..5 + dictionary + size)?;
    let mut value = [0u8; 8];
    value[..size].copy_from_slice(field);
    let content = u64::from_le_bytes(value);
    Some(if size == 2 { content + 256 } else { content })
}

fn memory_too_small() -> std::io::Error {
    invalid("There is not enough memory below the memory limit for a Zstandard window")
}

fn invalid(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message.into())
}

fn truncated() -> std::io::Error {
    invalid("The Zstandard data ends in the middle of a frame")
}

pub use c::Decoder;

pub mod c {
    //! The decoder of the C zstd library.

    use std::io::Read;

    use zstd_safe::{DCtx, DParameter, InBuffer, OutBuffer};

    use super::{WindowLimit, invalid, truncated};

    /// The most bytes of a frame header.
    const MAX_HEADER_BYTES: usize = 18;

    /// The bytes that the decoder reads from the compressed data in one
    /// step.
    const INPUT_BYTES: usize = 64 * 1024;

    /// Decodes all frames of the compressed data with
    /// `ZSTD_decompressStream`. The library skips skippable frames and
    /// starts the next frame after the end of a frame.
    pub struct Decoder<R> {
        source: R,
        context: DCtx<'static>,
        input: Box<[u8]>,
        start: usize,
        end: usize,
        /// The source has no more bytes.
        exhausted: bool,
        /// The last call ended a frame and flushed all of its output.
        complete: bool,
        limit: WindowLimit,
        /// The `ZSTD_d_windowLogMax` that the context has.
        applied: u32,
        /// The largest window of a frame that started. The library keeps
        /// buffers that are large enough, so a frame with a window that is
        /// not larger allocates nothing new.
        window: u64,
        /// The call in which the last larger window was allocated.
        grew_in: Option<u64>,
    }

    impl<R> std::fmt::Debug for Decoder<R> {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("Decoder").finish_non_exhaustive()
        }
    }

    impl<R: Read> Decoder<R> {
        /// Makes a decoder. `declared` is the uncompressed size from the
        /// central directory. The C decoder does not use it: a window
        /// limit lower than the frame window refuses valid data.
        ///
        /// # Errors
        ///
        /// Returns an error when the library cannot make a context.
        pub fn new(source: R, declared: u64) -> std::io::Result<Self> {
            Self::with_window(source, declared, super::MAX_WINDOW_BYTES)
        }

        /// Makes a decoder that refuses a window of more than `window`
        /// bytes (and more than [`super::MAX_WINDOW_BYTES`]). The read
        /// worker makes the window smaller when the memory limit leaves
        /// less room.
        ///
        /// # Errors
        ///
        /// Returns an error when `window` is less than 1 KiB, or when the
        /// library cannot make a context.
        pub fn with_window(source: R, declared: u64, window: u64) -> std::io::Result<Self> {
            Self::with_limit(source, declared, WindowLimit::new(window))
        }

        /// Makes a decoder with a window limit that the caller can change.
        /// The decoder applies the limit at the start of each frame, before
        /// the library allocates the window of the frame.
        ///
        /// # Errors
        ///
        /// As [`Decoder::with_window`].
        pub fn with_limit(source: R, declared: u64, limit: WindowLimit) -> std::io::Result<Self> {
            let _ = declared;
            let log = super::window_log_for(limit.get()).ok_or_else(super::memory_too_small)?;
            // The C library reports a null allocation as an error, so its
            // allocations are fallible: they never take the slack.
            let mut context = crate::heap::fallible(DCtx::try_create)
                .ok_or_else(|| invalid("Zstandard cannot start"))?;
            context
                .set_parameter(DParameter::WindowLogMax(log))
                .map_err(|code| invalid(zstd_safe::get_error_name(code)))?;
            Ok(Decoder {
                source,
                context,
                input: crate::heap::try_buffer(INPUT_BYTES)?.into_boxed_slice(),
                start: 0,
                end: 0,
                exhausted: false,
                complete: true,
                limit,
                applied: log,
                window: 0,
                grew_in: None,
            })
        }

        /// Before a frame starts: returns [`super::pause`] when the frame
        /// needs a larger window and this call already allocated one.
        fn check_new_window(&mut self) -> std::io::Result<()> {
            // Make sure that the input holds the full header, when the data
            // has it.
            if self.end - self.start < MAX_HEADER_BYTES && !self.exhausted {
                self.input.copy_within(self.start..self.end, 0);
                self.end -= self.start;
                self.start = 0;
                while self.end < MAX_HEADER_BYTES {
                    let read = self.source.read(&mut self.input[self.end..])?;
                    if read == 0 {
                        break;
                    }
                    self.end += read;
                }
            }
            let Some(window) = super::header_window(&self.input[self.start..self.end]) else {
                return Ok(());
            };
            if window <= self.window {
                return Ok(());
            }
            let call = self.limit.call();
            if self.grew_in == Some(call) {
                return Err(super::pause());
            }
            self.grew_in = Some(call);
            self.window = window;
            Ok(())
        }

        /// Applies the current limit before a frame starts. The library
        /// takes a parameter only between frames, and it reads the window
        /// of a frame with the frame header.
        fn apply_limit(&mut self) -> std::io::Result<()> {
            // The library frees its buffers before it allocates larger
            // ones, and it keeps buffers that are large enough. Thus the
            // memory of the context is also free for the next window.
            let own = u64::try_from(self.context.sizeof()).unwrap_or(u64::MAX);
            let bytes = self.limit.get().saturating_add(own);
            let log = super::window_log_for(bytes).ok_or_else(super::memory_too_small)?;
            if log != self.applied {
                self.context
                    .set_parameter(DParameter::WindowLogMax(log))
                    .map_err(|code| invalid(zstd_safe::get_error_name(code)))?;
                self.applied = log;
            }
            Ok(())
        }

        /// The bytes of the decoder state, which include its window.
        #[must_use]
        pub fn memory(&self) -> usize {
            self.context.sizeof()
        }
    }

    impl<R: Read> Read for Decoder<R> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if buf.is_empty() {
                return Ok(0);
            }
            loop {
                if self.start == self.end && !self.exhausted {
                    self.end = self.source.read(&mut self.input)?;
                    self.start = 0;
                    self.exhausted = self.end == 0;
                }
                if self.exhausted && self.complete {
                    return Ok(0);
                }
                if self.complete {
                    // A new frame can start with this input. Each call
                    // ends at the end of a frame, so the limit applies to
                    // each frame.
                    self.check_new_window()?;
                    self.apply_limit()?;
                }
                let mut input = InBuffer::around(&self.input[self.start..self.end]);
                let mut output = OutBuffer::around(&mut *buf);
                let context = &mut self.context;
                let hint =
                    crate::heap::fallible(|| context.decompress_stream(&mut output, &mut input))
                        .map_err(|code| invalid(zstd_safe::get_error_name(code)))?;
                let consumed = input.pos();
                let produced = output.pos();
                self.start += consumed;
                self.complete = hint == 0;
                if produced > 0 {
                    return Ok(produced);
                }
                if self.exhausted && consumed == 0 {
                    // No input and no output: the data ends in a frame.
                    return if self.complete {
                        Ok(0)
                    } else {
                        Err(truncated())
                    };
                }
            }
        }
    }
}
