//! Groups: characters who share a chat and reply in turn (SillyTavern groups).

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use super::tags;
use crate::error::OptionalExt;
use crate::util::{json_text, new_id, now_ms};
use crate::{Result, StoreError};

pub const ENTITY: &str = "group";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GroupMember {
    pub character_id: String,
    /// Doesn't reply on its own (SillyTavern `disabled_members`).
    #[serde(default)]
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Group {
    pub id: String,
    pub name: String,
    /// Avatar blob hash; none shows the members' avatars.
    pub avatar: Option<String>,
    pub fav: bool,
    /// Members in group order.
    pub members: Vec<GroupMember>,
    /// SillyTavern group settings (`activation_strategy`, `generation_mode`, ...), verbatim.
    #[ts(type = "Record<string, unknown>")]
    pub settings: Value,
    pub tags: Vec<String>,
    /// SillyTavern group id this group was imported from.
    pub source_id: Option<String>,
    pub chat_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_chat_at: Option<i64>,
    pub rev: i64,
}

const COLUMNS: &str = "g.id, g.name, g.avatar, g.fav, g.data, g.source_id,
    (SELECT COUNT(*) FROM chats WHERE group_id = g.id), g.created_at, g.updated_at, g.last_chat_at, g.rev";

fn from_row(row: &Row<'_>) -> rusqlite::Result<Group> {
    Ok(Group {
        id: row.get(0)?,
        name: row.get(1)?,
        avatar: row.get(2)?,
        fav: row.get(3)?,
        settings: row.get(4)?,
        source_id: row.get(5)?,
        chat_count: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        last_chat_at: row.get(9)?,
        rev: row.get(10)?,
        members: Vec::new(),
        tags: Vec::new(),
    })
}

/// Members of every group of the user, by group id.
fn members_by_group(
    conn: &Connection,
    user_id: &str,
    group_id: Option<&str>,
) -> Result<HashMap<String, Vec<GroupMember>>> {
    let mut stmt = conn.prepare_cached(
        "SELECT m.group_id, m.character_id, m.muted FROM group_members m JOIN groups g ON g.id = m.group_id
         WHERE g.user_id = ?1 AND (?2 IS NULL OR g.id = ?2) ORDER BY m.position",
    )?;
    let mut map: HashMap<String, Vec<GroupMember>> = HashMap::new();
    let rows = stmt.query_map(params![user_id, group_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            GroupMember {
                character_id: r.get(1)?,
                muted: r.get(2)?,
            },
        ))
    })?;
    for row in rows {
        let (group, member) = row?;
        map.entry(group).or_default().push(member);
    }
    Ok(map)
}

pub fn list(conn: &Connection, user_id: &str) -> Result<Vec<Group>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM groups g WHERE g.user_id = ?1 ORDER BY g.name COLLATE NOCASE, g.created_at"
    ))?;
    let mut rows: Vec<Group> = stmt
        .query_map([user_id], from_row)?
        .collect::<rusqlite::Result<_>>()?;
    let mut members = members_by_group(conn, user_id, None)?;
    let mut tag_map = tags::by_entity(conn, user_id, ENTITY)?;
    for row in &mut rows {
        row.members = members.remove(&row.id).unwrap_or_default();
        row.tags = tag_map.remove(&row.id).unwrap_or_default();
    }
    Ok(rows)
}

pub fn get(conn: &Connection, user_id: &str, id: &str) -> Result<Group> {
    let mut group = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM groups g WHERE g.user_id = ?1 AND g.id = ?2"),
            params![user_id, id],
            from_row,
        )
        .or_not_found()?;
    group.members = members_by_group(conn, user_id, Some(id))?
        .remove(id)
        .unwrap_or_default();
    group.tags = tags::for_entity(conn, ENTITY, id)?;
    Ok(group)
}

/// Fails with `NotFound` unless the group exists and belongs to the user.
pub fn ensure_owner(conn: &Connection, user_id: &str, id: &str) -> Result<()> {
    conn.query_row(
        "SELECT 1 FROM groups WHERE user_id = ?1 AND id = ?2",
        params![user_id, id],
        |_| Ok(()),
    )
    .or_not_found()
}

pub fn find_by_source_id(
    conn: &Connection,
    user_id: &str,
    source_id: &str,
) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM groups WHERE user_id = ?1 AND source_id = ?2",
            params![user_id, source_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// Settings as stored: an object without the fields kept elsewhere.
fn clean_settings(settings: &Value) -> Value {
    let mut map = settings.as_object().cloned().unwrap_or_else(Map::new);
    for key in [
        "id",
        "name",
        "members",
        "disabled_members",
        "chats",
        "chat_id",
        "avatar_url",
        "fav",
        "date_added",
        "create_date",
        "date_last_chat",
        "chat_size",
    ] {
        map.remove(key);
    }
    Value::Object(map)
}

fn write_members(
    conn: &Connection,
    user_id: &str,
    group_id: &str,
    members: &[GroupMember],
) -> Result<()> {
    conn.execute("DELETE FROM group_members WHERE group_id = ?1", [group_id])?;
    let mut stmt = conn.prepare_cached(
        "INSERT INTO group_members (group_id, character_id, position, muted)
         SELECT ?1, id, ?3, ?4 FROM characters WHERE user_id = ?5 AND id = ?2",
    )?;
    let mut seen = std::collections::HashSet::new();
    for (position, member) in members.iter().enumerate() {
        if seen.insert(member.character_id.as_str()) {
            stmt.execute(params![
                group_id,
                member.character_id,
                position as i64,
                member.muted,
                user_id
            ])?;
        }
    }
    Ok(())
}

pub struct NewGroup {
    pub name: String,
    pub avatar: Option<String>,
    pub fav: bool,
    pub members: Vec<GroupMember>,
    pub settings: Value,
    pub source_id: Option<String>,
    pub created_at: Option<i64>,
}

fn valid_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() {
        Err(StoreError::Invalid("a group needs a name".into()))
    } else {
        Ok(name)
    }
}

/// Fails unless every member is a character of the user.
fn check_members(conn: &Connection, user_id: &str, members: &[GroupMember]) -> Result<()> {
    for member in members {
        if !super::characters::exists(conn, user_id, &member.character_id)? {
            return Err(StoreError::Invalid(format!(
                "no character {}",
                member.character_id
            )));
        }
    }
    Ok(())
}

pub fn create(conn: &Connection, user_id: &str, new: NewGroup) -> Result<Group> {
    let name = valid_name(&new.name)?;
    check_members(conn, user_id, &new.members)?;
    let id = new_id();
    let now = now_ms();
    conn.execute(
        "INSERT INTO groups (id, user_id, name, avatar, fav, data, source_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            user_id,
            name,
            new.avatar,
            new.fav,
            json_text(&clean_settings(&new.settings)),
            new.source_id,
            new.created_at.unwrap_or(now),
            now
        ],
    )?;
    write_members(conn, user_id, &id, &new.members)?;
    get(conn, user_id, &id)
}

#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct GroupPatch {
    pub name: Option<String>,
    pub fav: Option<bool>,
    pub members: Option<Vec<GroupMember>>,
    /// Settings to merge into the current ones.
    #[ts(optional, type = "Record<string, unknown>")]
    pub settings: Option<Value>,
}

pub fn update(
    conn: &Connection,
    user_id: &str,
    id: &str,
    patch: &GroupPatch,
    expected_rev: Option<i64>,
) -> Result<Group> {
    let current = get(conn, user_id, id)?;
    super::check_rev(current.rev, expected_rev)?;
    let name = match &patch.name {
        Some(name) => valid_name(name)?.to_string(),
        None => current.name.clone(),
    };
    if let Some(members) = &patch.members {
        check_members(conn, user_id, members)?;
    }
    let mut settings = current.settings.as_object().cloned().unwrap_or_default();
    if let Some(Value::Object(changes)) = patch.settings.as_ref().map(clean_settings) {
        settings.extend(changes);
    }
    conn.execute(
        "UPDATE groups SET name = ?3, fav = ?4, data = ?5, updated_at = ?6, rev = rev + 1
         WHERE user_id = ?1 AND id = ?2",
        params![
            user_id,
            id,
            name,
            patch.fav.unwrap_or(current.fav),
            json_text(&Value::Object(settings)),
            now_ms()
        ],
    )?;
    if let Some(members) = &patch.members {
        write_members(conn, user_id, id, members)?;
    }
    get(conn, user_id, id)
}

pub fn set_avatar(conn: &Connection, user_id: &str, id: &str, hash: Option<&str>) -> Result<Group> {
    let n = conn.execute(
        "UPDATE groups SET avatar = ?3, updated_at = ?4, rev = rev + 1 WHERE user_id = ?1 AND id = ?2",
        params![user_id, id, hash, now_ms()],
    )?;
    super::affected(n)?;
    get(conn, user_id, id)
}

/// Deletes a group with its chats.
pub fn delete(conn: &Connection, user_id: &str, id: &str) -> Result<()> {
    ensure_owner(conn, user_id, id)?;
    conn.execute(
        "DELETE FROM chats WHERE user_id = ?1 AND group_id = ?2",
        params![user_id, id],
    )?;
    conn.execute(
        "DELETE FROM groups WHERE user_id = ?1 AND id = ?2",
        params![user_id, id],
    )?;
    conn.execute(
        "DELETE FROM entity_tags WHERE entity_type = ?1 AND entity_id = ?2",
        params![ENTITY, id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;
    use crate::repo::{characters, chats, users};
    use serde_json::json;

    fn character(c: &Connection, user: &str, name: &str) -> String {
        characters::create(
            c,
            user,
            characters::NewCharacter {
                card: json!({"data": {"name": name}}),
                avatar: None,
                source_file: None,
                created_at: None,
            },
        )
        .unwrap()
        .summary
        .id
    }

    #[test]
    fn members_settings_and_chats() {
        let db = Db::open_in_memory().unwrap();
        db.write_blocking(|c| {
            let user = users::ensure_default(c)?.id;
            let (a, b) = (character(c, &user, "Aiko"), character(c, &user, "Ren"));
            let member = |id: &str, muted| GroupMember {
                character_id: id.into(),
                muted,
            };
            let group = create(
                c,
                &user,
                NewGroup {
                    name: "Café".into(),
                    avatar: None,
                    fav: false,
                    members: vec![member(&b, false), member(&a, true), member(&b, true)],
                    settings: json!({"id": "1", "activation_strategy": 1, "chats": ["x"]}),
                    source_id: None,
                    created_at: None,
                },
            )?;
            // Duplicates are dropped, order kept; ST's bookkeeping fields don't go into settings.
            assert_eq!(group.members, vec![member(&b, false), member(&a, true)]);
            assert_eq!(group.settings, json!({"activation_strategy": 1}));
            assert!(
                create(
                    c,
                    &user,
                    NewGroup {
                        name: "Bad".into(),
                        avatar: None,
                        fav: false,
                        members: vec![member("nobody", false)],
                        settings: json!({}),
                        source_id: None,
                        created_at: None,
                    },
                )
                .is_err()
            );

            let patch = GroupPatch {
                settings: Some(json!({"generation_mode": 2})),
                members: Some(vec![member(&a, false)]),
                ..Default::default()
            };
            let updated = update(c, &user, &group.id, &patch, Some(group.rev))?;
            assert_eq!(
                updated.settings,
                json!({"activation_strategy": 1, "generation_mode": 2})
            );
            assert_eq!(updated.members, vec![member(&a, false)]);
            assert!(update(c, &user, &group.id, &patch, Some(group.rev)).is_err());

            let chat = chats::create(
                c,
                &user,
                chats::NewChat {
                    character_id: None,
                    group_id: Some(group.id.clone()),
                    title: "Café - 1".into(),
                    metadata: json!({}),
                    header: json!({}),
                    created_at: None,
                },
            )?;
            assert_eq!(get(c, &user, &group.id)?.chat_count, 1);
            assert_eq!(chats::list_for_group(c, &user, &group.id)?.len(), 1);

            // Deleting a member's character removes it from the group.
            characters::delete(c, &user, &a)?;
            assert!(get(c, &user, &group.id)?.members.is_empty());

            delete(c, &user, &group.id)?;
            assert!(list(c, &user)?.is_empty());
            assert!(chats::get(c, &user, &chat.id).is_err());
            Ok(())
        })
        .unwrap();
    }
}
