//! Conversions between SillyTavern file formats and stored rows.

use bt_formats::chat::StMessage;
use bt_store::repo::messages::{Message, NewMessage, Swipe};
use serde_json::{Map, Value};

pub fn st_to_new_message(m: StMessage) -> NewMessage {
    let created_at = m.created_at();
    let swipes = m
        .swipes
        .into_iter()
        .zip(m.swipe_info)
        .map(|(content, info)| Swipe { content, info })
        .collect();
    NewMessage {
        role: m.role,
        name: m.name,
        hidden: Some(m.hidden),
        swipe_id: Some(m.swipe_id as i64),
        swipes,
        send_date: Some(m.send_date),
        extra: Some(m.extra),
        data: Some(Value::Object(m.data)),
        created_at,
    }
}

pub fn message_to_st(m: &Message) -> StMessage {
    StMessage {
        role: m.role.clone(),
        name: m.name.clone(),
        hidden: m.hidden,
        swipe_id: m.swipe_id.max(0) as usize,
        swipes: m.swipes.iter().map(|s| s.content.clone()).collect(),
        swipe_info: m.swipes.iter().map(|s| s.info.clone()).collect(),
        send_date: m.send_date.clone(),
        extra: m.extra.clone(),
        data: m.data.as_object().cloned().unwrap_or_else(Map::new),
    }
}

/// `Content-Disposition` for a download, with an RFC 5987 UTF-8 file name.
pub fn attachment(file_name: &str) -> String {
    let ascii: String = file_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || " ._-()".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = file_name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"._-".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

/// File name safe on every OS (keeps Unicode letters).
pub fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "untitled".into()
    } else {
        trimmed.chars().take(120).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names() {
        assert_eq!(sanitize_file_name(" a/b:c? "), "a_b_c_");
        assert_eq!(sanitize_file_name(".."), "untitled");
        let header = attachment("角色.png");
        assert!(header.contains("filename=\"__.png\""));
        assert!(header.contains("filename*=UTF-8''%E8%A7%92%E8%89%B2.png"));
    }
}
