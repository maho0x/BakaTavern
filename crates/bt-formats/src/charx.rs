//! CHARX (Character Card V3 archive): a ZIP with `card.json` and embedded assets referenced as
//! `embeded://<path>` (sic, as written by the spec).

use std::io::{Cursor, Read};

use serde_json::Value;

use crate::{FormatError, Result};

/// Upper bounds that keep a hostile archive from exhausting memory.
const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct CharxAsset {
    /// Asset type from the card (`icon`, `background`, `emotion`, `user_icon`, ...).
    pub kind: String,
    pub name: String,
    pub ext: String,
    pub path: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct Charx {
    /// Raw `card.json` (not yet normalized).
    pub card: Value,
    /// Bytes of the main icon, if present.
    pub avatar: Option<Vec<u8>>,
    pub assets: Vec<CharxAsset>,
}

pub fn is_zip(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
}

fn read_entry(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    name: &str,
    budget: &mut u64,
) -> Result<Option<Vec<u8>>> {
    let file = match archive.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let limit = MAX_ENTRY_BYTES.min(*budget);
    let mut buf = Vec::new();
    file.take(limit + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > limit {
        return Err(FormatError::Invalid(format!(
            "archive entry {name:?} is too large"
        )));
    }
    *budget -= buf.len() as u64;
    Ok(Some(buf))
}

pub fn read(bytes: &[u8]) -> Result<Charx> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    let mut budget = MAX_TOTAL_BYTES;
    let card_bytes = read_entry(&mut archive, "card.json", &mut budget)?
        .ok_or_else(|| FormatError::Invalid("card.json not found in the archive".into()))?;
    let card: Value = serde_json::from_slice(&card_bytes)?;

    let mut assets = Vec::new();
    let declared = card
        .pointer("/data/assets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for asset in declared {
        let Some(uri) = asset.get("uri").and_then(Value::as_str) else {
            continue;
        };
        let Some(path) = uri
            .strip_prefix("embeded://")
            .or_else(|| uri.strip_prefix("embedded://"))
        else {
            continue;
        };
        if let Some(bytes) = read_entry(&mut archive, path, &mut budget)? {
            let field = |k: &str| {
                asset
                    .get(k)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            };
            assets.push(CharxAsset {
                kind: field("type"),
                name: field("name"),
                ext: field("ext"),
                path: path.into(),
                bytes,
            });
        }
    }
    let avatar = assets
        .iter()
        .find(|a| a.kind == "icon" && a.name == "main")
        .or_else(|| assets.iter().find(|a| a.kind == "icon"))
        .map(|a| a.bytes.clone());
    Ok(Charx {
        card,
        avatar,
        assets,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_card_and_icon() {
        let mut buf = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("card.json", opts).unwrap();
            zip.write_all(br#"{"spec":"chara_card_v3","data":{"name":"X","assets":[
                {"type":"icon","uri":"embeded://assets/icon/main.png","name":"main","ext":"png"},
                {"type":"background","uri":"https://example.com/bg.png","name":"bg","ext":"png"}]}}"#)
                .unwrap();
            zip.start_file("assets/icon/main.png", opts).unwrap();
            zip.write_all(b"PNGDATA").unwrap();
            zip.finish().unwrap();
        }
        assert!(is_zip(&buf));
        let charx = read(&buf).unwrap();
        assert_eq!(charx.card["data"]["name"], "X");
        assert_eq!(charx.avatar.as_deref(), Some(&b"PNGDATA"[..]));
        assert_eq!(charx.assets.len(), 1);
    }
}
