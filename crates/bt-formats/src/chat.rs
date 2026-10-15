//! SillyTavern chat files (JSONL): one header line followed by one message per line.

use serde_json::{Map, Value, json};

use crate::date::parse_st_date;
use crate::{FormatError, Result};

/// Top-level message fields with a dedicated representation; everything else is kept verbatim.
const KNOWN_FIELDS: &[&str] = &[
    "name",
    "is_user",
    "is_system",
    "send_date",
    "mes",
    "extra",
    "swipes",
    "swipe_id",
    "swipe_info",
];

/// Key in [`StMessage::data`] recording how an imported message's swipe fields looked, when that
/// differs from what [`StMessage::to_json`] writes by default; the export reproduces it and drops
/// the key. SillyTavern only adds swipe data lazily, so files it wrote mix several shapes.
pub const SHAPE_KEY: &str = "__bt_shape";

#[derive(Debug, Clone, PartialEq)]
pub struct StMessage {
    /// `user` | `assistant` | `system` (SillyTavern narrator messages).
    pub role: String,
    pub name: String,
    /// `is_system`: excluded from prompts.
    pub hidden: bool,
    pub swipe_id: usize,
    /// Swipe texts; never empty. The active one is `swipes[swipe_id]` (SillyTavern's `mes`).
    pub swipes: Vec<String>,
    /// `swipe_info`, aligned with `swipes`.
    pub swipe_info: Vec<Value>,
    pub send_date: String,
    pub extra: Value,
    pub data: Map<String, Value>,
}

fn obj() -> Value {
    Value::Object(Map::new())
}

impl StMessage {
    pub fn from_json(value: Value) -> Result<Self> {
        let Value::Object(mut map) = value else {
            return Err(FormatError::Invalid("chat message is not an object".into()));
        };
        // Old chats lack some of these; the export leaves them out again while they are unset.
        let absent: Vec<Value> = ["is_user", "is_system", "extra"]
            .into_iter()
            .filter(|k| !map.contains_key(*k))
            .map(Value::from)
            .collect();
        let is_user = map.get("is_user").and_then(Value::as_bool).unwrap_or(false);
        let hidden = map
            .get("is_system")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let extra = match map.remove("extra") {
            Some(v @ Value::Object(_)) => v,
            _ => obj(),
        };
        let narrator = extra.get("type").and_then(Value::as_str) == Some("narrator");
        let role = if is_user {
            "user"
        } else if narrator {
            "system"
        } else {
            "assistant"
        };
        let name = match map.get("name") {
            Some(Value::String(s)) => s.clone(),
            Some(other) if !other.is_null() => other.to_string(),
            _ => String::new(),
        };
        let send_date = map.get("send_date").map(date_text).unwrap_or_default();
        let mes = match map.get("mes") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => String::new(),
            Some(other) => other.to_string(),
        };
        let mut swipes: Vec<String> = match map.get("swipes") {
            Some(Value::Array(items)) => items
                .iter()
                .map(|v| match v {
                    Value::String(s) => s.clone(),
                    Value::Null => String::new(),
                    other => other.to_string(),
                })
                .collect(),
            _ => Vec::new(),
        };
        let had_swipes = !swipes.is_empty();
        let mut swipe_id = map.get("swipe_id").and_then(Value::as_u64).unwrap_or(0) as usize;
        if swipes.is_empty() {
            swipes.push(mes);
            swipe_id = 0;
        } else {
            swipe_id = swipe_id.min(swipes.len() - 1);
            // `mes` is what SillyTavern displays; keep the active swipe in sync with it.
            swipes[swipe_id] = mes;
        }
        let mut swipe_info: Vec<Value> = match map.get("swipe_info") {
            Some(Value::Array(items)) => items
                .iter()
                .map(|v| if v.is_object() { v.clone() } else { obj() })
                .collect(),
            _ => Vec::new(),
        };
        let info_len = swipe_info.len();
        swipe_info.resize(swipes.len(), obj());
        // Old chats store `send_date` as a number: keep the original value next to the text.
        let keep_date = map.get("send_date").is_some_and(|v| !v.is_string());
        for key in KNOWN_FIELDS {
            if !(*key == "send_date" && keep_date) {
                map.remove(*key);
            }
        }
        let mut message = Self {
            role: role.into(),
            name,
            hidden,
            swipe_id,
            swipes,
            swipe_info,
            send_date,
            extra,
            data: map,
        };
        let mut shape = Map::new();
        if had_swipes != message.default_has_swipes() {
            shape.insert("swipes".into(), json!(had_swipes));
        }
        if had_swipes && info_len != message.swipes.len() {
            shape.insert("info".into(), json!(info_len));
        }
        if !absent.is_empty() {
            shape.insert("absent".into(), Value::Array(absent));
        }
        if !shape.is_empty() {
            message.data.insert(SHAPE_KEY.into(), Value::Object(shape));
        }
        Ok(message)
    }

    /// SillyTavern gives swipe data to every message but user and small system ones.
    fn default_has_swipes(&self) -> bool {
        self.role != "user" && self.extra.get("isSmallSys").and_then(Value::as_bool) != Some(true)
    }

    pub fn created_at(&self) -> Option<i64> {
        parse_st_date(&self.send_date)
    }

    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("name".into(), json!(self.name));
        out.insert("is_user".into(), json!(self.role == "user"));
        out.insert("is_system".into(), json!(self.hidden));
        let original_date = self
            .data
            .get("send_date")
            .filter(|v| !v.is_string() && date_text(v) == self.send_date);
        out.insert(
            "send_date".into(),
            original_date
                .cloned()
                .unwrap_or_else(|| json!(self.send_date)),
        );
        let mes = self.swipes.get(self.swipe_id).cloned().unwrap_or_default();
        out.insert("mes".into(), json!(mes));
        out.insert("extra".into(), self.extra.clone());
        for (k, v) in &self.data {
            if k != SHAPE_KEY {
                out.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        let shape = self.data.get(SHAPE_KEY);
        let has_swipes = self.swipes.len() > 1
            || shape
                .and_then(|s| s.get("swipes"))
                .and_then(Value::as_bool)
                .unwrap_or_else(|| self.default_has_swipes());
        if has_swipes {
            // Reproduce a shorter imported `swipe_info`, unless newer swipes carry data.
            let used = self
                .swipe_info
                .iter()
                .rposition(|i| i.as_object().is_some_and(|o| !o.is_empty()))
                .map_or(0, |i| i + 1);
            let len = shape
                .and_then(|s| s.get("info"))
                .and_then(Value::as_u64)
                .map_or(self.swipe_info.len(), |n| (n as usize).max(used))
                .min(self.swipe_info.len());
            out.insert("swipe_id".into(), json!(self.swipe_id));
            out.insert("swipes".into(), json!(self.swipes));
            out.insert("swipe_info".into(), json!(self.swipe_info[..len]));
        }
        let absent = shape
            .and_then(|s| s.get("absent"))
            .and_then(Value::as_array);
        for key in absent.into_iter().flatten().filter_map(Value::as_str) {
            let unset = match out.get(key) {
                Some(Value::Bool(b)) => !b,
                Some(Value::Object(o)) => o.is_empty(),
                _ => false,
            };
            if unset {
                out.remove(key);
            }
        }
        Value::Object(out)
    }
}

/// `send_date` as text: strings as they are, numbers (old chats) in decimal.
fn date_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StChat {
    /// Header fields other than `chat_metadata` (`user_name`, `character_name`, `create_date`, ...).
    pub header: Map<String, Value>,
    pub metadata: Value,
    pub messages: Vec<StMessage>,
    /// Lines that were not valid JSON and were skipped.
    pub skipped_lines: usize,
}

fn is_header(map: &Map<String, Value>) -> bool {
    !map.contains_key("mes")
        && (map.contains_key("chat_metadata")
            || map.contains_key("user_name")
            || map.contains_key("character_name"))
}

pub fn parse_jsonl(text: &str) -> Result<StChat> {
    let mut header = Map::new();
    let mut metadata = obj();
    let mut messages = Vec::new();
    let mut skipped_lines = 0;
    let mut first = true;
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let value: Value = match serde_json::from_str(line.trim_start_matches('\u{feff}')) {
            Ok(v) => v,
            Err(_) => {
                skipped_lines += 1;
                first = false;
                continue;
            }
        };
        if first {
            first = false;
            if let Value::Object(mut map) = value {
                if is_header(&map) {
                    if let Some(meta @ Value::Object(_)) = map.remove("chat_metadata") {
                        metadata = meta;
                    }
                    header = map;
                    continue;
                }
                messages.push(StMessage::from_json(Value::Object(map))?);
                continue;
            }
        }
        match StMessage::from_json(value) {
            Ok(m) => messages.push(m),
            Err(_) => skipped_lines += 1,
        }
    }
    if first {
        return Err(FormatError::Invalid("the chat file is empty".into()));
    }
    Ok(StChat {
        header,
        metadata,
        messages,
        skipped_lines,
    })
}

/// Serializes a chat as SillyTavern JSONL.
pub fn to_jsonl(header: &Map<String, Value>, metadata: &Value, messages: &[StMessage]) -> String {
    let mut head = Map::new();
    head.insert("user_name".into(), json!("unused"));
    head.insert("character_name".into(), json!("unused"));
    for (k, v) in header {
        head.insert(k.clone(), v.clone());
    }
    head.insert(
        "chat_metadata".into(),
        if metadata.is_object() {
            metadata.clone()
        } else {
            obj()
        },
    );
    let mut out = serde_json::to_string(&Value::Object(head)).unwrap_or_default();
    for message in messages {
        out.push('\n');
        out.push_str(&serde_json::to_string(&message.to_json()).unwrap_or_default());
    }
    out
}

/// Plain-text transcript (`Name: message` blocks), as SillyTavern's TXT export.
pub fn to_txt(messages: &[StMessage]) -> String {
    messages
        .iter()
        .filter(|m| !m.hidden)
        .map(|m| {
            format!(
                "{}: {}",
                m.name,
                m.swipes
                    .get(m.swipe_id)
                    .map(String::as_str)
                    .unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"user_name":"unused","character_name":"unused","create_date":"2026-10-14@23h56m12s","chat_metadata":{"integrity":"abc","note_prompt":"AN"}}
{"name":"Seraphina","is_user":false,"is_system":false,"send_date":"October 14, 2026 11:56pm","mes":"Hello","extra":{},"swipe_id":1,"swipes":["Hi","Hello"],"swipe_info":[{"send_date":"x","extra":{}},{"send_date":"y","extra":{"model":"m"}}]}
{"name":"You","is_user":true,"is_system":false,"send_date":"2026-10-14T23:57:00.000Z","mes":"Hey","extra":{"bias":""},"force_avatar":"a.png"}
not json
{"name":"System","is_user":false,"is_system":true,"send_date":"","mes":"narration","extra":{"type":"narrator"}}
"#;

    #[test]
    fn parses_and_round_trips() {
        let chat = parse_jsonl(SAMPLE).unwrap();
        assert_eq!(chat.skipped_lines, 1);
        assert_eq!(chat.metadata["note_prompt"], "AN");
        assert_eq!(chat.header["create_date"], "2026-10-14@23h56m12s");
        assert_eq!(chat.messages.len(), 3);
        let [ai, user, sys] = &chat.messages[..] else {
            panic!()
        };
        assert_eq!(
            (ai.role.as_str(), ai.swipe_id, ai.swipes[1].as_str()),
            ("assistant", 1, "Hello")
        );
        assert_eq!(ai.swipe_info[1]["extra"]["model"], "m");
        assert_eq!(user.role, "user");
        assert_eq!(user.data["force_avatar"], "a.png");
        assert!(user.created_at().is_some());
        assert_eq!((sys.role.as_str(), sys.hidden), ("system", true));

        let again = parse_jsonl(&to_jsonl(&chat.header, &chat.metadata, &chat.messages)).unwrap();
        assert_eq!(again.messages, chat.messages);
        assert_eq!(again.metadata, chat.metadata);
        let user_json = user.to_json();
        assert!(user_json.get("swipes").is_none());
        assert_eq!(to_txt(&chat.messages), "Seraphina: Hello\n\nYou: Hey");
    }

    #[test]
    fn headerless_files_are_accepted() {
        let chat = parse_jsonl(r#"{"name":"A","is_user":true,"mes":"x"}"#).unwrap();
        assert_eq!(chat.messages.len(), 1);
        assert!(parse_jsonl("\n\n").is_err());
    }
}
