//! Minimal PNG chunk reader/writer, enough to read and write character card text chunks.

use crate::{FormatError, Result};

const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];

#[derive(Debug, Clone, Copy)]
pub struct Chunk<'a> {
    pub kind: [u8; 4],
    pub data: &'a [u8],
}

pub fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(&SIGNATURE)
}

pub fn chunks(bytes: &[u8]) -> Result<Vec<Chunk<'_>>> {
    if !is_png(bytes) {
        return Err(FormatError::NotPng);
    }
    let mut out = Vec::new();
    let mut pos = SIGNATURE.len();
    while pos < bytes.len() {
        if pos + 12 > bytes.len() {
            return Err(FormatError::CorruptPng("truncated chunk header"));
        }
        let len = u32::from_be_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
        let kind: [u8; 4] = bytes[pos + 4..pos + 8].try_into().unwrap();
        let start = pos + 8;
        let end = start.checked_add(len).filter(|e| e + 4 <= bytes.len());
        let Some(end) = end else {
            return Err(FormatError::CorruptPng("chunk length out of bounds"));
        };
        out.push(Chunk {
            kind,
            data: &bytes[start..end],
        });
        pos = end + 4;
        if &kind == b"IEND" {
            break;
        }
    }
    if out.last().map(|c| &c.kind) != Some(b"IEND") {
        return Err(FormatError::CorruptPng("missing IEND"));
    }
    Ok(out)
}

/// Text chunks as `(keyword, text)`. Handles `tEXt` and uncompressed `iTXt`.
pub fn text_chunks(bytes: &[u8]) -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    for chunk in chunks(bytes)? {
        match &chunk.kind {
            b"tEXt" => {
                if let Some(nul) = chunk.data.iter().position(|&b| b == 0) {
                    let key = latin1(&chunk.data[..nul]);
                    let text = latin1(&chunk.data[nul + 1..]);
                    out.push((key, text));
                }
            }
            b"iTXt" => {
                // keyword\0 compression_flag compression_method language\0 translated\0 text
                let d = chunk.data;
                let Some(k) = d.iter().position(|&b| b == 0) else {
                    continue;
                };
                if d.len() < k + 3 || d[k + 1] != 0 {
                    continue; // compressed iTXt is not used by card tools
                }
                let rest = &d[k + 3..];
                let Some(l) = rest.iter().position(|&b| b == 0) else {
                    continue;
                };
                let rest = &rest[l + 1..];
                let Some(t) = rest.iter().position(|&b| b == 0) else {
                    continue;
                };
                out.push((
                    latin1(&d[..k]),
                    String::from_utf8_lossy(&rest[t + 1..]).into_owned(),
                ));
            }
            _ => {}
        }
    }
    Ok(out)
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(kind);
    hasher.update(data);
    out.extend_from_slice(&hasher.finalize().to_be_bytes());
}

/// Returns a copy of `png` where every text chunk whose keyword matches one of `entries`
/// (case-insensitively) is removed and the given `tEXt` chunks are inserted before `IEND`.
/// Text must be Latin-1 safe (card payloads are base64).
pub fn with_text_chunks(png: &[u8], entries: &[(&str, &str)]) -> Result<Vec<u8>> {
    let parsed = chunks(png)?;
    let replaced = |data: &[u8]| {
        let key_end = data.iter().position(|&b| b == 0).unwrap_or(data.len());
        let key = latin1(&data[..key_end]);
        entries.iter().any(|(k, _)| k.eq_ignore_ascii_case(&key))
    };
    let mut out = Vec::with_capacity(
        png.len()
            + entries
                .iter()
                .map(|(k, v)| k.len() + v.len() + 13)
                .sum::<usize>(),
    );
    out.extend_from_slice(&SIGNATURE);
    for chunk in &parsed {
        if (&chunk.kind == b"tEXt" || &chunk.kind == b"iTXt") && replaced(chunk.data) {
            continue;
        }
        if &chunk.kind == b"IEND" {
            for (key, text) in entries {
                let mut data = Vec::with_capacity(key.len() + 1 + text.len());
                data.extend_from_slice(key.as_bytes());
                data.push(0);
                data.extend(
                    text.chars()
                        .map(|c| if (c as u32) < 256 { c as u8 } else { b'?' }),
                );
                write_chunk(&mut out, b"tEXt", &data);
            }
        }
        write_chunk(&mut out, &chunk.kind, chunk.data);
    }
    Ok(out)
}

/// Image size from the IHDR chunk.
pub fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let ihdr = chunks(bytes)
        .ok()?
        .into_iter()
        .find(|c| &c.kind == b"IHDR")?;
    if ihdr.data.len() < 8 {
        return None;
    }
    Some((
        u32::from_be_bytes(ihdr.data[0..4].try_into().ok()?),
        u32::from_be_bytes(ihdr.data[4..8].try_into().ok()?),
    ))
}

/// A valid 1x1 transparent PNG, used when a card has no avatar image.
pub fn placeholder() -> Vec<u8> {
    let mut out = SIGNATURE.to_vec();
    // 1x1, 8-bit RGBA
    write_chunk(&mut out, b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    // zlib stream of one filtered scanline: filter 0 + RGBA(0,0,0,0)
    write_chunk(
        &mut out,
        b"IDAT",
        &[
            0x78, 0x9c, 0x63, 0x60, 0x00, 0x02, 0x00, 0x00, 0x05, 0x00, 0x01,
        ],
    );
    write_chunk(&mut out, b"IEND", &[]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_reads_text_chunks() {
        let png = placeholder();
        assert_eq!(dimensions(&png), Some((1, 1)));
        let with = with_text_chunks(&png, &[("chara", "AAAA"), ("ccv3", "BBBB")]).unwrap();
        let texts = text_chunks(&with).unwrap();
        assert_eq!(
            texts,
            vec![
                ("chara".into(), "AAAA".into()),
                ("ccv3".into(), "BBBB".into())
            ]
        );
        // Replacing keeps a single copy of each keyword.
        let again = with_text_chunks(&with, &[("Chara", "CCCC")]).unwrap();
        let texts = text_chunks(&again).unwrap();
        assert_eq!(
            texts,
            vec![
                ("ccv3".into(), "BBBB".into()),
                ("Chara".into(), "CCCC".into())
            ]
        );
    }

    #[test]
    fn rejects_garbage() {
        assert!(matches!(chunks(b"nope"), Err(FormatError::NotPng)));
        let mut truncated = placeholder();
        truncated.truncate(20);
        assert!(chunks(&truncated).is_err());
    }
}
