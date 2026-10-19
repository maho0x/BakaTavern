//! Full-text search over the messages of a user's chats (the `message_search` index).

use rusqlite::{Connection, params_from_iter, types::Value as SqlValue};
use serde::Serialize;
use ts_rs::TS;

use crate::Result;

/// A message that matched, with where it is.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchHit {
    pub chat_id: String,
    pub chat_title: String,
    pub character_id: Option<String>,
    pub group_id: Option<String>,
    pub message_id: String,
    pub seq: i64,
    pub name: String,
    pub role: String,
    /// Text around the first match (whole words where possible).
    pub snippet: String,
    pub send_date: String,
    pub created_at: i64,
}

/// Where to search: every chat, or the chats of one character or group.
#[derive(Debug, Clone, Default)]
pub struct SearchScope {
    pub character_id: Option<String>,
    pub group_id: Option<String>,
}

/// Characters of context kept on each side of a match.
const CONTEXT: usize = 60;

/// Messages whose shown text contains `query` (ignoring case), newest first. The trigram index
/// needs three characters; shorter queries scan the text.
pub fn messages(
    conn: &Connection,
    user_id: &str,
    query: &str,
    scope: &SearchScope,
    limit: usize,
) -> Result<Vec<SearchHit>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut args: Vec<SqlValue> = vec![user_id.to_string().into()];
    let matcher = if query.chars().count() >= 3 {
        args.push(format!("\"{}\"", query.replace('"', "\"\"")).into());
        "m.rowid IN (SELECT rowid FROM message_search WHERE message_search MATCH ?2)"
    } else {
        args.push(query.to_lowercase().into());
        "instr(lower(s.content), ?2) > 0"
    };
    let mut sql = format!(
        "SELECT c.id, c.title, c.character_id, c.group_id, m.id, m.seq, m.name, m.role, s.content,
                m.send_date, m.created_at
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
         JOIN swipes s ON s.message_id = m.id AND s.idx = m.swipe_id
         WHERE c.user_id = ?1 AND {matcher}"
    );
    if let Some(id) = &scope.character_id {
        args.push(id.clone().into());
        sql.push_str(&format!(" AND c.character_id = ?{}", args.len()));
    }
    if let Some(id) = &scope.group_id {
        args.push(id.clone().into());
        sql.push_str(&format!(" AND c.group_id = ?{}", args.len()));
    }
    args.push((limit as i64).into());
    sql.push_str(&format!(
        " ORDER BY m.created_at DESC, m.seq DESC LIMIT ?{}",
        args.len()
    ));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args), |r| {
        let content: String = r.get(8)?;
        Ok(SearchHit {
            chat_id: r.get(0)?,
            chat_title: r.get(1)?,
            character_id: r.get(2)?,
            group_id: r.get(3)?,
            message_id: r.get(4)?,
            seq: r.get(5)?,
            name: r.get(6)?,
            role: r.get(7)?,
            snippet: snippet(&content, query),
            send_date: r.get(9)?,
            created_at: r.get(10)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// The text around the first match of `query` (ignoring case), with `…` where it was cut.
pub fn snippet(text: &str, query: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = chars.iter().flat_map(|c| c.to_lowercase()).collect();
    let needle: Vec<char> = query.chars().flat_map(|c| c.to_lowercase()).collect();
    // Lowercasing rarely changes lengths; then the position is approximate, which is fine here.
    let at = lower
        .windows(needle.len().max(1))
        .position(|w| w == needle.as_slice())
        .unwrap_or(0)
        .min(chars.len());
    let start = at.saturating_sub(CONTEXT);
    let end = (at + needle.len() + CONTEXT).min(chars.len()).max(start);
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(
        chars[start..end]
            .iter()
            .map(|&c| if c == '\n' { ' ' } else { c }),
    );
    if end < chars.len() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;
    use crate::repo::messages::{self, MessagePatch, NewMessage, Swipe};
    use crate::repo::{characters, chats, users};
    use serde_json::json;

    fn msg(role: &str, name: &str, text: &str) -> NewMessage {
        NewMessage {
            role: role.into(),
            name: name.into(),
            character_id: None,
            hidden: None,
            swipe_id: None,
            swipes: vec![Swipe {
                content: text.into(),
                info: json!({}),
            }],
            send_date: None,
            extra: None,
            data: None,
            created_at: None,
        }
    }

    #[test]
    fn finds_shown_text_in_any_language() {
        let db = Db::open_in_memory().unwrap();
        db.write_blocking(|c| {
            let user = users::ensure_default(c)?;
            let character = characters::create(
                c,
                &user.id,
                characters::NewCharacter {
                    card: json!({"data": {"name": "Aiko"}}),
                    avatar: None,
                    source_file: None,
                    created_at: None,
                },
            )?;
            let chat = chats::create(
                c,
                &user.id,
                chats::NewChat {
                    character_id: Some(character.summary.id.clone()),
                    group_id: None,
                    title: "Night".into(),
                    metadata: json!({}),
                    header: json!({}),
                    created_at: None,
                },
            )?;
            let added = messages::insert(
                c,
                &chat.id,
                None,
                &[
                    msg("user", "Mika", "The lighthouse keeper waved."),
                    msg("assistant", "Aiko", "灯塔的光照亮了海湾。"),
                ],
            )?;
            let all = SearchScope::default();
            let hits = messages(c, &user.id, "LIGHTHOUSE", &all, 10)?;
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].name, "Mika");
            assert_eq!(hits[0].chat_title, "Night");
            assert_eq!(hits[0].seq, 0);
            assert_eq!(messages(c, &user.id, "灯塔", &all, 10)?.len(), 1);
            assert_eq!(messages(c, &user.id, "照亮了", &all, 10)?.len(), 1);

            // Swiping changes what is found; deleting removes it.
            let reply = &added[1];
            messages::update(
                c,
                &reply.id,
                &MessagePatch {
                    swipes: Some(vec![
                        reply.swipes[0].clone(),
                        Swipe {
                            content: "A storm rolled in.".into(),
                            info: json!({}),
                        },
                    ]),
                    swipe_id: Some(1),
                    ..Default::default()
                },
                None,
            )?;
            assert!(messages(c, &user.id, "灯塔的光", &all, 10)?.is_empty());
            assert_eq!(messages(c, &user.id, "storm", &all, 10)?.len(), 1);
            messages::delete(c, &chat.id, std::slice::from_ref(&reply.id))?;
            assert!(messages(c, &user.id, "storm", &all, 10)?.is_empty());

            let mine = SearchScope {
                character_id: Some(character.summary.id.clone()),
                group_id: None,
            };
            assert_eq!(messages(c, &user.id, "keeper", &mine, 10)?.len(), 1);
            let other = SearchScope {
                character_id: Some("nobody".into()),
                group_id: None,
            };
            assert!(messages(c, &user.id, "keeper", &other, 10)?.is_empty());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn snippets_cut_around_the_match() {
        let text = format!("{}needle{}", "a".repeat(100), "b".repeat(100));
        let s = snippet(&text, "NEEDLE");
        assert!(s.starts_with('…') && s.ends_with('…'));
        assert!(s.contains("needle"));
        assert_eq!(snippet("short text", "text"), "short text");
    }
}
