//! Character cards: Tavern V1, Character Card V2/V3 and SillyTavern's on-disk variant.
//!
//! Canonical form stored by BakaTavern: `{ "spec": "chara_card_v3", "spec_version": "3.0",
//! "data": { ... }, <other top-level fields such as create_date> }`. The V1 fields that SillyTavern
//! mirrors at the top level are dropped on import and regenerated on export.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value, json};

use crate::{FormatError, Result, png};

pub const V2_SPEC: &str = "chara_card_v2";
pub const V3_SPEC: &str = "chara_card_v3";

const STRING_FIELDS: &[&str] = &[
    "name",
    "description",
    "personality",
    "scenario",
    "first_mes",
    "mes_example",
    "creator_notes",
    "system_prompt",
    "post_history_instructions",
    "creator",
    "character_version",
];

/// Field order of the canonical `data` object; unknown fields follow in their original order.
const DATA_ORDER: &[&str] = &[
    "name",
    "description",
    "personality",
    "scenario",
    "first_mes",
    "mes_example",
    "creator_notes",
    "system_prompt",
    "post_history_instructions",
    "alternate_greetings",
    "character_book",
    "tags",
    "creator",
    "character_version",
    "extensions",
    "group_only_greetings",
    "assets",
    "nickname",
    "creator_notes_multilingual",
    "source",
    "creation_date",
    "modification_date",
];

/// Top-level fields SillyTavern derives from `data` (or that only describe the file).
const TOP_LEVEL_DERIVED: &[&str] = &[
    "name",
    "description",
    "personality",
    "scenario",
    "first_mes",
    "mes_example",
    "creatorcomment",
    "avatar",
    "chat",
    "talkativeness",
    "fav",
    "tags",
    "spec",
    "spec_version",
    "data",
];

/// Reads the raw card JSON embedded in a PNG (`ccv3` preferred over `chara`).
pub fn read_png(bytes: &[u8]) -> Result<Value> {
    let texts = png::text_chunks(bytes)?;
    let pick = |key: &str| {
        texts
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
    };
    let payload = pick("ccv3")
        .or_else(|| pick("chara"))
        .ok_or(FormatError::NoCharacterData)?;
    decode_payload(payload)
}

fn decode_payload(payload: &str) -> Result<Value> {
    let compact: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
    match STANDARD.decode(compact.as_bytes()) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        // A few tools store the JSON itself rather than base64.
        Err(_) => serde_json::from_str(payload).map_err(|_| FormatError::Base64),
    }
}

fn coerce_string(value: Option<Value>) -> Value {
    match value {
        Some(Value::String(s)) => Value::String(s),
        Some(Value::Number(n)) => Value::String(n.to_string()),
        Some(Value::Bool(b)) => Value::String(b.to_string()),
        _ => Value::String(String::new()),
    }
}

fn coerce_string_array(value: Option<Value>, split_commas: bool) -> Value {
    let items = match value {
        Some(Value::Array(items)) => items
            .into_iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .collect(),
        Some(Value::String(s)) if split_commas => s
            .split(',')
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect(),
        Some(Value::String(s)) if !s.is_empty() => vec![s],
        _ => Vec::new(),
    };
    Value::Array(items.into_iter().map(Value::String).collect())
}

/// Normalizes any supported card JSON to the canonical V3 form.
pub fn normalize(raw: Value) -> Result<Value> {
    let Value::Object(mut top) = raw else {
        return Err(FormatError::Invalid(
            "a character card must be a JSON object".into(),
        ));
    };
    let mut data = match top.get("data") {
        Some(Value::Object(d)) if !d.is_empty() => d.clone(),
        _ => {
            // Tavern V1: everything at the top level.
            let mut d = Map::new();
            for field in [
                "name",
                "description",
                "personality",
                "scenario",
                "first_mes",
                "mes_example",
                "tags",
            ] {
                if let Some(v) = top.get(field) {
                    d.insert(field.into(), v.clone());
                }
            }
            if let Some(v) = top.get("creatorcomment") {
                d.insert("creator_notes".into(), v.clone());
            }
            let mut ext = Map::new();
            for field in ["talkativeness", "fav"] {
                if let Some(v) = top.get(field) {
                    ext.insert(field.into(), v.clone());
                }
            }
            d.insert("extensions".into(), Value::Object(ext));
            d
        }
    };

    for field in STRING_FIELDS {
        let v = coerce_string(data.remove(*field));
        data.insert((*field).into(), v);
    }
    let name = data["name"].as_str().unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return Err(FormatError::Invalid(
            "the character card has no name".into(),
        ));
    }
    data.insert("name".into(), Value::String(name));
    for field in ["alternate_greetings", "group_only_greetings"] {
        let v = coerce_string_array(data.remove(field), false);
        data.insert(field.into(), v);
    }
    let tags = coerce_string_array(data.remove("tags"), true);
    data.insert("tags".into(), tags);
    if !data.get("extensions").is_some_and(Value::is_object) {
        data.insert("extensions".into(), json!({}));
    }
    if data.get("character_book").is_some_and(|b| !b.is_object()) {
        data.remove("character_book");
    }

    let mut ordered = Map::new();
    for field in DATA_ORDER {
        if let Some(v) = data.remove(*field) {
            ordered.insert((*field).into(), v);
        }
    }
    ordered.extend(data);

    for field in TOP_LEVEL_DERIVED {
        top.remove(*field);
    }
    let mut out = Map::new();
    out.insert("spec".into(), json!(V3_SPEC));
    out.insert("spec_version".into(), json!("3.0"));
    out.insert("data".into(), Value::Object(ordered));
    out.extend(top);
    Ok(Value::Object(out))
}

fn data_of(card: &Value) -> Map<String, Value> {
    card.get("data")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// The JSON SillyTavern writes for a character: a V2 card with V1 fields mirrored at the top level.
pub fn to_st_json(card: &Value) -> Value {
    let data = data_of(card);
    let get = |k: &str| data.get(k).cloned().unwrap_or_else(|| json!(""));
    let ext = data.get("extensions").and_then(Value::as_object);
    let fav = match ext.and_then(|e| e.get("fav")) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s == "true",
        _ => false,
    };
    let mut out = Map::new();
    for field in [
        "name",
        "description",
        "personality",
        "scenario",
        "first_mes",
        "mes_example",
    ] {
        out.insert(field.into(), get(field));
    }
    out.insert("creatorcomment".into(), get("creator_notes"));
    out.insert("avatar".into(), json!("none"));
    out.insert(
        "talkativeness".into(),
        ext.and_then(|e| e.get("talkativeness"))
            .cloned()
            .unwrap_or(json!("0.5")),
    );
    out.insert("fav".into(), json!(fav));
    out.insert(
        "tags".into(),
        data.get("tags").cloned().unwrap_or(json!([])),
    );
    out.insert("spec".into(), json!(V2_SPEC));
    out.insert("spec_version".into(), json!("2.0"));
    out.insert("data".into(), Value::Object(data));
    if let Some(top) = card.as_object() {
        for (k, v) in top {
            if !matches!(k.as_str(), "spec" | "spec_version" | "data") && !out.contains_key(k) {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(out)
}

/// Same as [`to_st_json`] but declared as a V3 card (what SillyTavern writes to the `ccv3` chunk).
pub fn to_st_json_v3(card: &Value) -> Value {
    let mut v = to_st_json(card);
    v["spec"] = json!(V3_SPEC);
    v["spec_version"] = json!("3.0");
    v
}

/// Embeds the card into a PNG image (writes both `chara` and `ccv3` chunks).
pub fn write_png(image_png: &[u8], card: &Value) -> Result<Vec<u8>> {
    let v2 = STANDARD.encode(serde_json::to_vec(&to_st_json(card))?);
    let v3 = STANDARD.encode(serde_json::to_vec(&to_st_json_v3(card))?);
    png::with_text_chunks(image_png, &[("chara", &v2), ("ccv3", &v3)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_v1_cards() {
        let card = normalize(json!({
            "name": "Old", "description": "d", "first_mes": "hi", "creatorcomment": "notes",
            "tags": "a, b", "talkativeness": "0.7", "fav": true, "create_date": "2023-1-1 @00h00m00s"
        }))
        .unwrap();
        assert_eq!(card["spec"], V3_SPEC);
        assert_eq!(card["data"]["creator_notes"], "notes");
        assert_eq!(card["data"]["tags"], json!(["a", "b"]));
        assert_eq!(card["data"]["extensions"]["talkativeness"], "0.7");
        assert_eq!(card["data"]["alternate_greetings"], json!([]));
        assert_eq!(card["create_date"], "2023-1-1 @00h00m00s");
        assert!(card.get("name").is_none());
    }

    #[test]
    fn keeps_v2_data_and_unknown_fields() {
        let card = normalize(json!({
            "name": "stale mirror", "spec": "chara_card_v2", "spec_version": "2.0",
            "data": {"name": " Sera ", "extensions": {"fav": false, "custom": 1}, "x_tool": {"a": 1},
                     "alternate_greetings": ["a", 2, null], "character_book": null}
        }))
        .unwrap();
        assert_eq!(card["data"]["name"], "Sera");
        assert_eq!(card["data"]["x_tool"]["a"], 1);
        assert_eq!(card["data"]["extensions"]["custom"], 1);
        assert_eq!(card["data"]["alternate_greetings"], json!(["a", "2"]));
        assert!(card["data"].get("character_book").is_none());
        assert!(normalize(json!({"data": {"name": "  "}})).is_err());
    }

    #[test]
    fn png_round_trip() {
        let card = normalize(
            json!({"spec": "chara_card_v2", "data": {"name": "Bot", "description": "测试"}}),
        )
        .unwrap();
        let image = write_png(&png::placeholder(), &card).unwrap();
        let raw = read_png(&image).unwrap();
        assert_eq!(raw["spec"], V3_SPEC);
        assert_eq!(raw["name"], "Bot");
        assert_eq!(normalize(raw).unwrap(), card);
        let texts = png::text_chunks(&image).unwrap();
        let chara = texts.iter().find(|(k, _)| k == "chara").unwrap();
        let v2 = decode_payload(&chara.1).unwrap();
        assert_eq!(v2["spec"], V2_SPEC);
        assert_eq!(v2["data"]["description"], "测试");
    }
}
