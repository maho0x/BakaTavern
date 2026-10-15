//! Image helpers: type sniffing, dimensions, PNG conversion and thumbnails.

use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageFormat, ImageReader};

/// MIME type from magic bytes.
pub fn sniff_mime(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xff, 0xd8, 0xff, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => "image/webp",
        [
            _,
            _,
            _,
            _,
            b'f',
            b't',
            b'y',
            b'p',
            b'a',
            b'v',
            b'i',
            b'f',
            ..,
        ] => "image/avif",
        [b'P', b'K', 3, 4, ..] => "application/zip",
        [b'%', b'P', b'D', b'F', ..] => "application/pdf",
        [b'I', b'D', b'3', ..] | [0xff, 0xfb, ..] => "audio/mpeg",
        [b'O', b'g', b'g', b'S', ..] => "audio/ogg",
        [_, _, _, _, b'f', b't', b'y', b'p', ..] => "video/mp4",
        _ if std::str::from_utf8(&bytes[..bytes.len().min(512)]).is_ok() => {
            match bytes.iter().find(|b| !b.is_ascii_whitespace()) {
                Some(b'{') | Some(b'[') => "application/json",
                _ => "text/plain",
            }
        }
        _ => "application/octet-stream",
    }
}

pub fn is_image(mime: &str) -> bool {
    mime.starts_with("image/")
}

pub fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

fn decode(bytes: &[u8]) -> anyhow::Result<DynamicImage> {
    Ok(ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()?
        .decode()?)
}

/// Returns PNG bytes, converting other image formats.
pub fn to_png(bytes: &[u8]) -> anyhow::Result<Vec<u8>> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Ok(bytes.to_vec());
    }
    let mut out = Vec::new();
    decode(bytes)?.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)?;
    Ok(out)
}

/// Scales an image to at most `max_width` wide (and twice that tall). Opaque images become JPEG,
/// images with transparency PNG. Returns the bytes and their MIME type.
pub fn thumbnail(bytes: &[u8], max_width: u32) -> anyhow::Result<(Vec<u8>, &'static str)> {
    let image = decode(bytes)?;
    let image = if image.width() > max_width || image.height() > max_width * 2 {
        image.thumbnail(max_width, max_width * 2)
    } else {
        image
    };
    let mut out = Vec::new();
    if image.color().has_alpha() {
        image.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)?;
        Ok((out, "image/png"))
    } else {
        image
            .to_rgb8()
            .write_with_encoder(JpegEncoder::new_with_quality(&mut out, 85))?;
        Ok((out, "image/jpeg"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_types() {
        assert_eq!(sniff_mime(&bt_formats::png::placeholder()), "image/png");
        assert_eq!(sniff_mime(b"  {\"a\":1}"), "application/json");
        assert_eq!(sniff_mime(b"PK\x03\x04rest"), "application/zip");
        assert_eq!(
            sniff_mime(&[0u8, 159, 146, 150]),
            "application/octet-stream"
        );
    }

    #[test]
    fn thumbnails_and_png_conversion() {
        let png = bt_formats::png::placeholder();
        assert_eq!(dimensions(&png), Some((1, 1)));
        let (thumb, mime) = thumbnail(&png, 64).unwrap();
        assert_eq!(mime, "image/png");
        assert!(!thumb.is_empty());
        assert_eq!(to_png(&png).unwrap(), png);
    }
}
