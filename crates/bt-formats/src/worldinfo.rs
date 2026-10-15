//! SillyTavern World Info files: `{ "entries": { "<uid>": { ... } }, ...book fields }`.

use serde_json::{Map, Value, json};

use crate::{FormatError, Result};

#[derive(Debug, Clone, PartialEq)]
pub struct StWorld {
    /// Book-level fields other than `entries`.
    pub data: Map<String, Value>,
    /// Entries in uid order, each with a numeric `uid`.
    pub entries: Vec<Value>,
}

pub fn is_world(value: &Value) -> bool {
    matches!(
        value.get("entries"),
        Some(Value::Object(_) | Value::Array(_))
    )
}

pub fn parse(value: Value) -> Result<StWorld> {
    let Value::Object(mut map) = value else {
        return Err(FormatError::Invalid(
            "world info must be a JSON object".into(),
        ));
    };
    let raw = map
        .remove("entries")
        .ok_or_else(|| FormatError::Invalid("world info has no entries".into()))?;
    let pairs: Vec<(Option<i64>, Value)> = match raw {
        Value::Object(entries) => entries
            .into_iter()
            .map(|(k, v)| (k.parse().ok(), v))
            .collect(),
        Value::Array(entries) => entries.into_iter().map(|v| (None, v)).collect(),
        _ => {
            return Err(FormatError::Invalid(
                "world info entries must be an object".into(),
            ));
        }
    };
    let mut entries = Vec::with_capacity(pairs.len());
    for (key_uid, mut entry) in pairs {
        let Value::Object(fields) = &mut entry else {
            continue;
        };
        let uid = match fields.get("uid") {
            Some(Value::Number(n)) => n.as_i64(),
            Some(Value::String(s)) => s.parse().ok(),
            _ => None,
        }
        .or(key_uid);
        if let Some(uid) = uid {
            fields.insert("uid".into(), json!(uid));
        }
        entries.push(entry);
    }
    entries.sort_by_key(|e| e.get("uid").and_then(Value::as_i64).unwrap_or(i64::MAX));
    Ok(StWorld { data: map, entries })
}

pub fn to_json(data: &Value, entries: &[Value]) -> Value {
    let mut by_uid = Map::new();
    for (i, entry) in entries.iter().enumerate() {
        let uid = entry.get("uid").and_then(Value::as_i64).unwrap_or(i as i64);
        by_uid.insert(uid.to_string(), entry.clone());
    }
    let mut out = Map::new();
    out.insert("entries".into(), Value::Object(by_uid));
    if let Some(fields) = data.as_object() {
        for (k, v) in fields {
            if k != "entries" {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let src = json!({"entries": {"5": {"uid": 5, "key": ["a"]}, "2": {"key": ["b"]}}, "originalData": {"x": 1}});
        let world = parse(src).unwrap();
        assert_eq!(world.entries[0]["uid"], 2);
        assert_eq!(world.data["originalData"]["x"], 1);
        let out = to_json(&Value::Object(world.data.clone()), &world.entries);
        assert_eq!(out["entries"]["5"]["key"][0], "a");
        assert_eq!(parse(out).unwrap(), world);
        assert!(parse(json!({"name": "x"})).is_err());
    }
}
