//! Data that is compressed already. The remux stores it as it is, because
//! Zstandard makes it no smaller and costs time.
//!
//! The decision uses the extension of the name and the first bytes of the
//! data. Either one is enough.

/// Extensions of compressed formats, in lower case: images, audio and
/// video, archives and the formats that are zip archives, compressed
/// streams and compressed fonts.
const EXTENSIONS: &[&str] = &[
    // Images.
    "jpg", "jpeg", "jfif", "png", "apng", "gif", "webp", "avif", "heic", "heif", "jxl", "jp2",
    // Audio and video.
    "mp3", "m4a", "aac", "ogg", "oga", "opus", "flac", "mp4", "m4v", "mov", "mkv", "webm", "avi",
    "wmv", "flv", "3gp", // Zip archives and formats that are zip archives.
    "zip", "jar", "war", "ear", "aar", "apk", "aab", "ipa", "xpi", "crx", "whl", "egg", "nupkg",
    "vsix", "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub", "kmz",
    // Other archives and compressed streams.
    "gz", "tgz", "bz2", "tbz", "tbz2", "xz", "txz", "lz", "lzma", "lz4", "zst", "zstd", "tzst",
    "br", "7z", "rar", "cab", "dmg", // Fonts.
    "woff", "woff2",
];

/// Magic bytes at the start of compressed formats, with their offset.
const MAGIC: &[(usize, &[u8])] = &[
    (0, b"\xff\xd8\xff"),                   // JPEG
    (0, b"\x89PNG\r\n\x1a\n"),              // PNG
    (0, b"GIF8"),                           // GIF
    (0, b"\x1a\x45\xdf\xa3"),               // Matroska, WebM
    (0, b"OggS"),                           // Ogg
    (0, b"fLaC"),                           // FLAC
    (0, b"ID3"),                            // MP3 with a tag
    (0, b"PK\x03\x04"),                     // Zip
    (0, b"\x1f\x8b"),                       // gzip
    (0, b"BZh"),                            // bzip2
    (0, b"\xfd7zXZ\x00"),                   // xz
    (0, b"\x28\xb5\x2f\xfd"),               // Zstandard
    (0, b"\x04\x22\x4d\x18"),               // LZ4
    (0, b"7z\xbc\xaf\x27\x1c"),             // 7z
    (0, b"Rar!\x1a\x07"),                   // RAR
    (0, b"wOFF"),                           // WOFF
    (0, b"wOF2"),                           // WOFF2
    (4, b"ftyp"),                           // MP4, MOV, HEIF, AVIF
    (0, b"\x00\x00\x00\x0cjP  \r\n\x87\n"), // JPEG 2000
    (0, b"\xff\x0a"),                       // JPEG XL
];

/// True when the extension of `name` (the part after the last `.` of the
/// last segment) is a compressed format.
#[must_use]
pub fn compressed_name(name: &[u8]) -> bool {
    let last = name
        .rsplit(|byte| *byte == b'/' || *byte == b'\\')
        .next()
        .unwrap_or(name);
    let Some(dot) = last.iter().rposition(|byte| *byte == b'.') else {
        return false;
    };
    let extension = &last[dot + 1..];
    EXTENSIONS
        .iter()
        .any(|known| extension.eq_ignore_ascii_case(known.as_bytes()))
}

/// True when `head`, the first bytes of the data, starts as a compressed
/// format.
#[must_use]
pub fn compressed_head(head: &[u8]) -> bool {
    if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return true;
    }
    MAGIC
        .iter()
        .any(|(at, magic)| head.get(*at..*at + magic.len()) == Some(magic))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_compressed_extensions_in_any_case() {
        for name in [
            "a.jpg",
            "dir/photo.JPEG",
            "x/y/clip.mp4",
            "lib/inner.jar",
            "dist/pkg.whl",
            "nested.zip",
            "font.woff2",
            "data.tar.gz",
            "doc.DOCX",
        ] {
            assert!(compressed_name(name.as_bytes()), "{name}");
        }
        for name in [
            "a.txt",
            "jpg",
            "dir.jpg/readme",
            "a.json",
            "a.",
            "",
            "archive.zip.txt",
        ] {
            assert!(!compressed_name(name.as_bytes()), "{name}");
        }
    }

    #[test]
    fn knows_compressed_magic_bytes() {
        assert!(compressed_head(b"\xff\xd8\xff\xe0rest"));
        assert!(compressed_head(b"\x89PNG\r\n\x1a\nIHDR"));
        assert!(compressed_head(b"PK\x03\x04\x14\x00"));
        assert!(compressed_head(b"\x00\x00\x00\x18ftypmp42"));
        assert!(compressed_head(b"RIFF\x10\x00\x00\x00WEBPVP8 "));
        assert!(!compressed_head(b"RIFF\x10\x00\x00\x00WAVEfmt "));
        assert!(!compressed_head(b"hello world"));
        assert!(!compressed_head(b""));
        assert!(!compressed_head(b"\xff"));
    }
}
