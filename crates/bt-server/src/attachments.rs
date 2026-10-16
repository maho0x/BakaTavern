//! Attachment links in SillyTavern messages (`extra.media`, `extra.files` and their older forms),
//! which point into SillyTavern's user folder (`user/images/...`, `user/files/...`) there and to
//! the blob store (`/api/files/<hash>`) here. Import and export rewrite them.

use serde_json::Value;

/// What an attachment link is for: SillyTavern keeps media in `user/images`, file text in
/// `user/files`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Media,
    File,
}

/// Calls `f` on every attachment link of a message (its `extra` and its swipes' `extra`); a
/// returned value replaces the link.
pub fn rewrite(
    extra: &mut Value,
    swipe_info: &mut [Value],
    f: &mut impl FnMut(&str, Kind) -> Option<String>,
) {
    rewrite_extra(extra, f);
    for info in swipe_info {
        if let Some(extra) = info.get_mut("extra") {
            rewrite_extra(extra, f);
        }
    }
}

/// The attachment links of a message.
pub fn links(extra: &Value, swipe_info: &[Value]) -> Vec<(String, Kind)> {
    let mut found = Vec::new();
    let (mut extra, mut swipe_info) = (extra.clone(), swipe_info.to_vec());
    rewrite(&mut extra, &mut swipe_info, &mut |url, kind| {
        found.push((url.to_string(), kind));
        None
    });
    found
}

fn rewrite_extra(extra: &mut Value, f: &mut impl FnMut(&str, Kind) -> Option<String>) {
    let Value::Object(extra) = extra else {
        return;
    };
    let mut visit = |value: &mut Value, kind: Kind| {
        if let Some(url) = value.as_str().filter(|u| !u.is_empty())
            && let Some(new) = f(url, kind)
        {
            *value = Value::String(new);
        }
    };
    for (list, kind) in [("media", Kind::Media), ("files", Kind::File)] {
        if let Some(Value::Array(items)) = extra.get_mut(list) {
            for item in items {
                if let Some(url) = item.get_mut("url") {
                    visit(url, kind);
                }
            }
        }
    }
    for key in ["image", "video"] {
        if let Some(value) = extra.get_mut(key) {
            visit(value, Kind::Media);
        }
    }
    if let Some(Value::Array(items)) = extra.get_mut("image_swipes") {
        for item in items {
            visit(item, Kind::Media);
        }
    }
    if let Some(url) = extra.get_mut("file").and_then(|file| file.get_mut("url")) {
        visit(url, Kind::File);
    }
}

/// The blob hash of a link to this server's file store.
pub fn stored_hash(url: &str) -> Option<&str> {
    url.strip_prefix("/api/files/")
        .filter(|hash| bt_store::BlobStore::is_valid_hash(hash))
}

/// A link into SillyTavern's user folder as a relative path (`user/images/x.png`), when it is one.
pub fn st_user_path(url: &str) -> Option<String> {
    let path = url.trim_start_matches('/');
    let path = percent_decode(path);
    let safe = path.starts_with("user/")
        && !path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..");
    safe.then_some(path)
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3])
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn finds_and_rewrites_every_kind_of_link() {
        let mut message = json!({
            "mes": "hi",
            "extra": {
                "media": [{ "url": "user/images/Aiko/a.png", "type": "image" }],
                "files": [{ "url": "/user/files/notes.txt", "name": "notes.txt" }],
                "image": "user/images/Aiko/old.png",
                "image_swipes": ["user/images/Aiko/s1.png"],
                "file": { "url": "user/files/old.txt" }
            },
            "swipe_info": [{ "extra": { "media": [{ "url": "user/images/Aiko/b.png" }] } }]
        });
        let mut infos = message["swipe_info"].as_array().unwrap().clone();
        let found = links(&message["extra"], &infos);
        assert_eq!(found.len(), 6);
        assert!(found.contains(&("/user/files/notes.txt".into(), Kind::File)));
        rewrite(&mut message["extra"], &mut infos, &mut |url, kind| {
            Some(format!(
                "{}:{url}",
                if kind == Kind::Media { "m" } else { "f" }
            ))
        });
        message["swipe_info"] = Value::Array(infos);
        assert_eq!(
            message["extra"]["media"][0]["url"],
            "m:user/images/Aiko/a.png"
        );
        assert_eq!(message["extra"]["file"]["url"], "f:user/files/old.txt");
        assert_eq!(
            message["swipe_info"][0]["extra"]["media"][0]["url"],
            "m:user/images/Aiko/b.png"
        );
    }

    #[test]
    fn only_safe_user_folder_paths() {
        assert_eq!(
            st_user_path("/user/images/Ai%20ko/a.png").as_deref(),
            Some("user/images/Ai ko/a.png")
        );
        assert_eq!(st_user_path("user/../secrets.json"), None);
        assert_eq!(st_user_path("https://example.com/a.png"), None);
        assert_eq!(stored_hash("/api/files/zz"), None);
    }
}
