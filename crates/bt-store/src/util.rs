use std::time::{SystemTime, UNIX_EPOCH};

/// Current time in unix milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// A new sortable identifier (ULID, 26 chars).
pub fn new_id() -> String {
    ulid::Ulid::generate().to_string()
}

/// Serializes a JSON value for a TEXT column (never SQL NULL).
pub fn json_text(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

/// Returns at most `max` characters of `text`, collapsed to a single line.
pub fn excerpt(text: &str, max: usize) -> String {
    let mut out = String::with_capacity(max.min(text.len()));
    let mut count = 0;
    let mut last_space = false;
    for ch in text.trim().chars() {
        if count >= max {
            out.push('…');
            break;
        }
        let ch = if ch.is_whitespace() { ' ' } else { ch };
        if ch == ' ' && last_space {
            continue;
        }
        last_space = ch == ' ';
        out.push(ch);
        count += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excerpt_collapses_whitespace_and_truncates() {
        assert_eq!(excerpt("  a\n\n b  c ", 10), "a b c");
        assert_eq!(excerpt("你好世界，欢迎", 4), "你好世界…");
    }
}
