//! Benchmark only. The reference source stays outside the production build.
use rawzip::ReaderAt;
use std::{cell::Cell, fmt, rc::Rc};
use wasm_bindgen::prelude::*;
use zipscope_core::contract::State;
use zipscope_core::ingest::{Ingest, Status};

#[expect(dead_code, reason = "Only the streaming reader is measured.")]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::needless_pass_by_value,
    reason = "Keep the external reference source unchanged."
)]
mod pdx_blob {
    include!(env!("PDX_BLOB_SOURCE"));
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn now() -> f64;
}

struct Counted {
    reader: Box<dyn ReaderAt>,
    read_ms: Rc<Cell<f64>>,
}

impl fmt::Debug for Counted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Counted")
            .field("read_ms", &self.read_ms)
            .finish_non_exhaustive()
    }
}

impl ReaderAt for Counted {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        let start = now();
        let result = self.reader.read_at(buf, offset);
        self.read_ms.set(self.read_ms.get() + now() - start);
        result
    }
}

#[wasm_bindgen]
#[derive(Debug)]
pub struct BenchParser {
    ingest: Ingest<Counted>,
    read_ms: Rc<Cell<f64>>,
}

fn open(reader: Box<dyn ReaderAt>, size: u64) -> Result<BenchParser, JsError> {
    let read_ms = Rc::new(Cell::new(0.0));
    let ingest = Ingest::open(
        Counted {
            reader,
            read_ms: Rc::clone(&read_ms),
        },
        size,
    )
    .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(BenchParser { ingest, read_ms })
}

#[wasm_bindgen]
impl BenchParser {
    /// Opens an archive with a JS reader.
    ///
    /// # Errors
    ///
    /// Returns an error if the archive cannot be opened.
    pub fn direct(reader: zipscope_core::JsReader, size: f64) -> Result<BenchParser, JsError> {
        open(Box::new(reader), file_size(size))
    }

    /// Opens an archive with the reference reader.
    ///
    /// # Errors
    ///
    /// Returns an error if the archive cannot be opened.
    pub fn pdx(blob: web_sys::Blob) -> Result<BenchParser, JsError> {
        let size = file_size(blob.size());
        let reader =
            pdx_blob::BlobReader::streaming(blob).map_err(|e| JsError::new(&e.to_string()))?;
        open(Box::new(reader), size)
    }

    pub fn parse(&mut self, count: u32) -> u32 {
        self.ingest.parse(count)
    }

    #[must_use]
    #[expect(
        clippy::cast_possible_truncation,
        reason = "The benchmark builds for wasm32."
    )]
    pub fn rows(&self) -> u32 {
        self.ingest.store().rows() as u32
    }

    #[must_use]
    pub fn state(&self) -> u32 {
        match self.ingest.status() {
            Status::Parsing => State::Parsing as u32,
            Status::Complete => State::Complete as u32,
            Status::Failed(_) => State::Failed as u32,
        }
    }

    #[must_use]
    pub fn error(&self) -> Option<String> {
        match self.ingest.status() {
            Status::Failed(message) => Some(message.clone()),
            _ => None,
        }
    }

    #[wasm_bindgen(js_name = readAtMs)]
    #[must_use]
    pub fn read_at_ms(&self) -> f64 {
        self.read_ms.get()
    }
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "The browser gives integer file sizes as f64 values."
)]
fn file_size(size: f64) -> u64 {
    size as u64
}
