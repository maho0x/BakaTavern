//! Moving a SillyTavern user directory (or its backup zip) into BakaTavern.
//!
//! Files with formats this crate knows become BakaTavern data: character cards, chats, groups
//! and their chats, lorebooks, presets, personas and tags, and (only when asked) API keys. SillyTavern's
//! `settings.json` is kept as a settings document for the web app, which maps it onto its own
//! settings: that mapping is domain knowledge and lives in TypeScript.
//!
//! Importing twice does not duplicate anything: cards, personas, lorebooks and chats that are
//! already here (same file name or title) are left alone; presets are updated in place.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};

use bt_formats::worldinfo;
use bt_store::repo::{
    characters, chats, groups, lorebooks, personas, presets, secrets, settings, tags,
};
use serde::Serialize;
use serde_json::{Value, json};
use ts_rs::TS;

use crate::attachments;
use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::routes::files::store_file;
use crate::routes::{characters as character_routes, chats as chat_routes};
use crate::state::AppState;

/// Settings namespace holding SillyTavern's settings until the web app has applied them.
pub const STASH_NAMESPACE: &str = "st_import";

/// Preset folders and the preset kind each holds.
const PRESET_DIRS: &[(&str, &str)] = &[
    ("OpenAI Settings", "openai"),
    ("TextGen Settings", "textgen"),
    ("KoboldAI Settings", "kobold"),
    ("NovelAI Settings", "novel"),
    ("instruct", "instruct"),
    ("context", "context"),
    ("sysprompt", "sysprompt"),
    ("reasoning", "reasoning"),
    ("QuickReplies", "qr"),
    ("themes", "theme"),
];

/// Picture and video files SillyTavern shows as chat backgrounds.
const BACKGROUND_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "mp4", "webm",
];

/// Folders whose contents BakaTavern cannot use yet; they are counted in the report.
const LATER_DIRS: &[(&str, &str)] = &[
    ("movingUI", "movingUi"),
    ("user/files", "dataBankFiles"),
    ("assets", "assets"),
    ("vectors", "vectors"),
    ("extensions", "extensions"),
];

/// Keys in SillyTavern's `secrets.json` that are not model APIs.
const NON_MODEL_KEYS: &[&str] = &[
    "api_key_horde",
    "api_key_novel",
    "api_key_serpapi",
    "api_key_serper",
    "api_key_tavily",
    "api_key_nomicai",
    "api_key_azure_tts",
    "api_key_custom_openai_tts",
    "api_key_stability",
    "api_key_bfl",
    "api_key_comfy_runpod",
    "api_key_falai",
    "api_key_elevenlabs",
];

#[derive(Debug, Clone, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StImportReport {
    pub characters: u32,
    pub groups: u32,
    /// Character and group chats.
    pub chats: u32,
    pub lorebooks: u32,
    pub presets: u32,
    pub personas: u32,
    pub secrets: u32,
    /// Images and files attached to chat messages.
    pub attachments: u32,
    /// Chat backgrounds.
    pub backgrounds: u32,
    /// Items already here from an earlier import, left as they are.
    pub unchanged: u32,
    /// What BakaTavern cannot use yet, by kind (group chats, backgrounds, ...).
    pub skipped: BTreeMap<String, u32>,
    pub failures: Vec<StImportFailure>,
    /// SillyTavern's settings were kept for the web app to apply.
    pub settings: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StImportFailure {
    /// Path inside the SillyTavern directory.
    pub file: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ImportOptions {
    /// Also import the API keys from `secrets.json`.
    pub secrets: bool,
}

/// The directory holding one user's SillyTavern data: the given directory itself, or
/// `data/default-user` (an install), `default-user` or a single user under `data/`, or `public`
/// (installs older than 1.12).
pub fn find_user_root(dir: &Path) -> Option<PathBuf> {
    let looks_like_user = |p: &Path| {
        p.join("settings.json").is_file()
            || p.join("characters").is_dir()
            || p.join("chats").is_dir()
    };
    if looks_like_user(dir) {
        return Some(dir.to_path_buf());
    }
    for candidate in [
        dir.join("data/default-user"),
        dir.join("default-user"),
        dir.join("public"),
    ] {
        if looks_like_user(&candidate) {
            return Some(candidate);
        }
    }
    let data = dir.join("data");
    let users: Vec<PathBuf> = std::fs::read_dir(&data)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && looks_like_user(p))
        .collect();
    match users.as_slice() {
        [only] => Some(only.clone()),
        _ => None,
    }
}

/// Extracts a backup zip into `into` (entries that would escape it are skipped).
pub fn extract_zip<R: Read + std::io::Seek>(reader: R, into: &Path) -> anyhow::Result<()> {
    let mut archive = zip::ZipArchive::new(reader)?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let Some(relative) = file.enclosed_name() else {
            continue;
        };
        let target = into.join(relative);
        if file.is_dir() {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut data = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut data)?;
        std::fs::write(&target, data)?;
    }
    Ok(())
}

/// Files of a folder with one of the given extensions, by name.
fn files_in(dir: &Path, extensions: &[&str]) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| extensions.iter().any(|x| x.eq_ignore_ascii_case(e)))
        })
        .collect();
    files.sort();
    files
}

fn count_files(dir: &Path) -> u32 {
    let mut n = 0;
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            n += count_files(&path);
        } else {
            n += 1;
        }
    }
    n
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn stem(path: &Path) -> String {
    path.file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

struct Importer<'a> {
    state: &'a AppState,
    user_id: &'a str,
    root: PathBuf,
    report: StImportReport,
}

impl Importer<'_> {
    fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned()
    }

    fn fail(&mut self, path: &Path, error: impl std::fmt::Display) {
        let file = self.relative(path);
        tracing::warn!("SillyTavern import: {file}: {error}");
        self.report.failures.push(StImportFailure {
            file,
            message: error.to_string(),
        });
    }

    /// Cards, by SillyTavern avatar file name → character id.
    async fn characters(&mut self) -> HashMap<String, String> {
        let mut by_avatar = HashMap::new();
        for path in files_in(&self.root.join("characters"), &["png", "json", "charx"]) {
            let name = file_name(&path);
            let user_id = self.user_id.to_string();
            let lookup = name.clone();
            let existing = self
                .state
                .db
                .read(move |c| characters::find_by_source_file(c, &user_id, &lookup))
                .await;
            if let Ok(Some(id)) = existing {
                by_avatar.insert(name, id);
                self.report.unchanged += 1;
                continue;
            }
            let bytes = match tokio::fs::read(&path).await {
                Ok(b) => b,
                Err(e) => {
                    self.fail(&path, e);
                    continue;
                }
            };
            match character_routes::import_one(self.state, self.user_id, &name, bytes).await {
                Ok(character) => {
                    by_avatar.insert(name, character.summary.id);
                    self.report.characters += 1;
                }
                Err(e) => self.fail(&path, e.message),
            }
        }
        by_avatar
    }

    /// `chats/<avatar without extension>/<title>.jsonl`.
    async fn chats(&mut self, by_avatar: &HashMap<String, String>) {
        let by_stem: HashMap<String, &String> = by_avatar
            .iter()
            .map(|(avatar, id)| {
                (
                    Path::new(avatar)
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    id,
                )
            })
            .collect();
        let mut folders: Vec<PathBuf> = std::fs::read_dir(self.root.join("chats"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        folders.sort();
        for folder in folders {
            let Some(character_id) = by_stem.get(&file_name(&folder)).map(|id| (*id).clone())
            else {
                *self
                    .report
                    .skipped
                    .entry("chatsWithoutCharacter".into())
                    .or_default() += files_in(&folder, &["jsonl"]).len() as u32;
                continue;
            };
            for path in files_in(&folder, &["jsonl"]) {
                let title = stem(&path);
                let (user_id, id, t) = (
                    self.user_id.to_string(),
                    character_id.clone(),
                    title.clone(),
                );
                let taken = self
                    .state
                    .db
                    .read(move |c| {
                        chats::unique_title(c, &user_id, Some(&id), None, &t).map(|u| u != t)
                    })
                    .await;
                if matches!(taken, Ok(true)) {
                    self.report.unchanged += 1;
                    continue;
                }
                let text = match tokio::fs::read_to_string(&path).await {
                    Ok(t) => t,
                    Err(e) => {
                        self.fail(&path, e);
                        continue;
                    }
                };
                let mut parsed = match bt_formats::chat::parse_jsonl(&text) {
                    Ok(p) => p,
                    Err(e) => {
                        self.fail(&path, ApiError::from(e).message);
                        continue;
                    }
                };
                self.localize_attachments(&mut parsed).await;
                match chat_routes::import_parsed(
                    self.state,
                    self.user_id,
                    chat_routes::ChatOwner {
                        character_id: Some(character_id.clone()),
                        group_id: None,
                    },
                    title,
                    parsed,
                )
                .await
                {
                    Ok(_) => self.report.chats += 1,
                    Err(e) => self.fail(&path, e.message),
                }
            }
        }
    }

    /// `groups/<id>.json` with their chats from `group chats/`, by SillyTavern group id → group id.
    async fn groups(
        &mut self,
        settings: Option<&Value>,
        by_avatar: &HashMap<String, String>,
    ) -> HashMap<String, String> {
        let mut by_st_id = HashMap::new();
        let mut used_chats = std::collections::HashSet::new();
        for path in files_in(&self.root.join("groups"), &["json"]) {
            let json = match tokio::fs::read(&path)
                .await
                .map_err(anyhow::Error::from)
                .and_then(|b| Ok(serde_json::from_slice::<Value>(&b)?))
            {
                Ok(v) if v.is_object() => v,
                Ok(_) => {
                    self.fail(&path, "not a JSON object");
                    continue;
                }
                Err(e) => {
                    self.fail(&path, e);
                    continue;
                }
            };
            let st_id = match json.get("id") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => n.to_string(),
                _ => stem(&path),
            };
            let strings = |key: &str| -> Vec<String> {
                json.get(key)
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| match v {
                                Value::String(s) => Some(s.clone()),
                                Value::Number(n) => Some(n.to_string()),
                                _ => None,
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let chat_ids = strings("chats");
            used_chats.extend(chat_ids.iter().cloned());
            let (user_id, lookup) = (self.user_id.to_string(), st_id.clone());
            let existing = self
                .state
                .db
                .read(move |c| groups::find_by_source_id(c, &user_id, &lookup))
                .await
                .ok()
                .flatten();
            let group_id = match existing {
                Some(id) => {
                    self.report.unchanged += 1;
                    id
                }
                None => match self
                    .create_group(&path, &json, &st_id, settings, by_avatar)
                    .await
                {
                    Some(id) => id,
                    None => continue,
                },
            };
            by_st_id.insert(st_id, group_id.clone());
            for chat_id in chat_ids {
                self.group_chat(&group_id, &chat_id).await;
            }
        }
        let orphans = files_in(&self.root.join("group chats"), &["jsonl"])
            .iter()
            .filter(|p| !used_chats.contains(&stem(p)))
            .count() as u32;
        if orphans > 0 {
            *self
                .report
                .skipped
                .entry("chatsWithoutGroup".into())
                .or_default() += orphans;
        }
        by_st_id
    }

    async fn create_group(
        &mut self,
        path: &Path,
        json: &Value,
        st_id: &str,
        settings: Option<&Value>,
        by_avatar: &HashMap<String, String>,
    ) -> Option<String> {
        let list = |key: &str| -> Vec<String> {
            json.get(key)
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        };
        let disabled = list("disabled_members");
        let members: Vec<groups::GroupMember> = list("members")
            .iter()
            .filter_map(|avatar| {
                Some(groups::GroupMember {
                    character_id: by_avatar.get(avatar)?.clone(),
                    muted: disabled.contains(avatar),
                })
            })
            .collect();
        // A custom avatar is a data URL or a file under `user/images`.
        let avatar = match json.get("avatar_url").and_then(Value::as_str) {
            Some(url) if url.starts_with("data:") => {
                url.split_once(";base64,").and_then(|(_, data)| {
                    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data).ok()
                })
            }
            Some(url) if url.trim_start_matches('/').starts_with("user/") => {
                tokio::fs::read(self.root.join(url.trim_start_matches('/')))
                    .await
                    .ok()
            }
            _ => None,
        };
        let avatar = match avatar {
            Some(bytes) => store_file(self.state, bytes).await.ok().map(|f| f.hash),
            None => None,
        };
        let tag_ids: Vec<String> = settings
            .and_then(|s| {
                s.pointer(&format!(
                    "/tag_map/{}",
                    st_id.replace('~', "~0").replace('/', "~1")
                ))
            })
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let st_tag_names: HashMap<String, String> = settings
            .and_then(|s| s.get("tags"))
            .and_then(Value::as_array)
            .map(|tags| {
                tags.iter()
                    .filter_map(|t| {
                        let id = match t.get("id")? {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        };
                        Some((id, t.get("name")?.as_str()?.trim().to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let tag_names: Vec<String> = tag_ids
            .iter()
            .filter_map(|id| st_tag_names.get(id).cloned())
            .filter(|n| !n.is_empty())
            .collect();
        let new = groups::NewGroup {
            name: json
                .get("name")
                .and_then(Value::as_str)
                .filter(|n| !n.trim().is_empty())
                .unwrap_or("Group")
                .to_string(),
            avatar,
            fav: matches!(json.get("fav"), Some(Value::Bool(true)))
                || json.get("fav").and_then(Value::as_str) == Some("true"),
            members,
            settings: json.clone(),
            source_id: Some(st_id.to_string()),
            created_at: None,
        };
        let user_id = self.user_id.to_string();
        let created = self
            .state
            .db
            .write(move |c| {
                let tx = c.transaction()?;
                let group = groups::create(&tx, &user_id, new)?;
                let mut ids = Vec::new();
                for name in &tag_names {
                    ids.push(tags::ensure(&tx, &user_id, name)?.id);
                }
                tags::set_entity_tags(&tx, groups::ENTITY, &group.id, &ids)?;
                tx.commit()?;
                Ok(group.id)
            })
            .await;
        match created {
            Ok(id) => {
                self.report.groups += 1;
                Some(id)
            }
            Err(e) => {
                self.fail(path, ApiError::from(e).message);
                None
            }
        }
    }

    /// `group chats/<chat id>.jsonl` into a group (unless it already has a chat by that name).
    async fn group_chat(&mut self, group_id: &str, chat_id: &str) {
        let path = self
            .root
            .join("group chats")
            .join(format!("{chat_id}.jsonl"));
        let (user_id, id, t) = (
            self.user_id.to_string(),
            group_id.to_string(),
            chat_id.to_string(),
        );
        let taken = self
            .state
            .db
            .read(move |c| chats::unique_title(c, &user_id, None, Some(&id), &t).map(|u| u != t))
            .await;
        if matches!(taken, Ok(true)) {
            self.report.unchanged += 1;
            return;
        }
        let text = match tokio::fs::read_to_string(&path).await {
            Ok(t) => t,
            // SillyTavern lists chats it never saved (a new chat nobody wrote in).
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => {
                self.fail(&path, e);
                return;
            }
        };
        let mut parsed = match bt_formats::chat::parse_jsonl(&text) {
            Ok(p) => p,
            Err(e) => {
                self.fail(&path, ApiError::from(e).message);
                return;
            }
        };
        self.localize_attachments(&mut parsed).await;
        match chat_routes::import_parsed(
            self.state,
            self.user_id,
            chat_routes::ChatOwner {
                character_id: None,
                group_id: Some(group_id.to_string()),
            },
            chat_id.to_string(),
            parsed,
        )
        .await
        {
            Ok(_) => self.report.chats += 1,
            Err(e) => self.fail(&path, e.message),
        }
    }

    /// Brings the files a chat's messages attach (`user/images/...`, `user/files/...`) into the
    /// blob store and points the messages at them. Missing files keep their links.
    async fn localize_attachments(&mut self, chat: &mut bt_formats::chat::StChat) {
        let mut stored: HashMap<String, Option<String>> = HashMap::new();
        for message in &chat.messages {
            for (url, _) in attachments::links(&message.extra, &message.swipe_info) {
                if stored.contains_key(&url) {
                    continue;
                }
                let Some(path) = attachments::st_user_path(&url) else {
                    continue;
                };
                let link = match tokio::fs::read(self.root.join(&path)).await {
                    Ok(bytes) => match store_file(self.state, bytes).await {
                        Ok(record) => {
                            self.report.attachments += 1;
                            Some(format!("/api/files/{}", record.hash))
                        }
                        Err(e) => {
                            self.fail(&self.root.join(&path), e.message);
                            None
                        }
                    },
                    Err(_) => {
                        *self
                            .report
                            .skipped
                            .entry("missingAttachments".into())
                            .or_default() += 1;
                        None
                    }
                };
                stored.insert(url, link);
            }
        }
        for message in &mut chat.messages {
            attachments::rewrite(
                &mut message.extra,
                &mut message.swipe_info,
                &mut |url, _| stored.get(url).cloned().flatten(),
            );
        }
    }

    /// `worlds/<name>.json`, by name → lorebook id.
    async fn lorebooks(&mut self) -> HashMap<String, String> {
        let mut by_name = HashMap::new();
        for path in files_in(&self.root.join("worlds"), &["json"]) {
            let name = stem(&path);
            let (user_id, lookup) = (self.user_id.to_string(), name.clone());
            if let Ok(Some(id)) = self
                .state
                .db
                .read(move |c| lorebooks::id_by_name(c, &user_id, &lookup))
                .await
            {
                by_name.insert(name, id);
                self.report.unchanged += 1;
                continue;
            }
            let parsed = tokio::fs::read(&path)
                .await
                .map_err(anyhow::Error::from)
                .and_then(|b| Ok(serde_json::from_slice::<Value>(&b)?))
                .and_then(|v| Ok(worldinfo::parse(v)?));
            let world = match parsed {
                Ok(w) => w,
                Err(e) => {
                    self.fail(&path, e);
                    continue;
                }
            };
            let (user_id, book_name) = (self.user_id.to_string(), name.clone());
            let created = self
                .state
                .db
                .write(move |c| {
                    let tx = c.transaction()?;
                    let book = lorebooks::create(
                        &tx,
                        &user_id,
                        &book_name,
                        &Value::Object(world.data),
                        world.entries,
                    )?;
                    tx.commit()?;
                    Ok(book)
                })
                .await;
            match created {
                Ok(book) => {
                    by_name.insert(name, book.id);
                    self.report.lorebooks += 1;
                }
                Err(e) => self.fail(&path, ApiError::from(e).message),
            }
        }
        by_name
    }

    /// Preset folders, by `kind/name` → preset id. Existing presets are updated.
    async fn presets(&mut self) -> HashMap<String, String> {
        let mut by_key = HashMap::new();
        for (dir, kind) in PRESET_DIRS {
            for path in files_in(&self.root.join(dir), &["json"]) {
                let name = stem(&path);
                let data = match tokio::fs::read(&path)
                    .await
                    .map_err(anyhow::Error::from)
                    .and_then(|b| Ok(serde_json::from_slice::<Value>(&b)?))
                {
                    Ok(v) if v.is_object() => v,
                    Ok(_) => {
                        self.fail(&path, "not a JSON object");
                        continue;
                    }
                    Err(e) => {
                        self.fail(&path, e);
                        continue;
                    }
                };
                let (user_id, kind_s, preset_name) =
                    (self.user_id.to_string(), kind.to_string(), name.clone());
                match self
                    .state
                    .db
                    .write(move |c| presets::upsert(c, &user_id, &kind_s, &preset_name, &data))
                    .await
                {
                    Ok(preset) => {
                        by_key.insert(format!("{kind}/{name}"), preset.info.id);
                        self.report.presets += 1;
                    }
                    Err(e) => self.fail(&path, ApiError::from(e).message),
                }
            }
        }
        by_key
    }

    /// Chat backgrounds (`backgrounds/`): stored files, listed by their SillyTavern file name.
    async fn backgrounds(&mut self) -> Vec<Value> {
        let mut out = Vec::new();
        for path in files_in(&self.root.join("backgrounds"), BACKGROUND_EXTENSIONS) {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let stored = match tokio::fs::read(&path).await {
                Ok(bytes) => store_file(self.state, bytes).await,
                Err(e) => {
                    self.fail(&path, e);
                    continue;
                }
            };
            match stored {
                Ok(record) => {
                    self.report.backgrounds += 1;
                    out.push(json!({ "name": name, "hash": record.hash }));
                }
                Err(e) => self.fail(&path, e.message),
            }
        }
        out
    }

    /// Personas from `power_user` with avatars from `User Avatars`, by avatar file → persona id.
    async fn personas(&mut self, settings: &Value) -> HashMap<String, String> {
        let mut by_avatar = HashMap::new();
        let power = settings.get("power_user").cloned().unwrap_or(Value::Null);
        let Some(names) = power.get("personas").and_then(Value::as_object) else {
            return by_avatar;
        };
        let descriptions = power
            .get("persona_descriptions")
            .cloned()
            .unwrap_or(Value::Null);
        let user_id = self.user_id.to_string();
        let existing: HashMap<String, String> = self
            .state
            .db
            .read(move |c| personas::list(c, &user_id))
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.source_file.map(|f| (f, p.id)))
            .collect();
        for (avatar, name) in names {
            if let Some(id) = existing.get(avatar) {
                by_avatar.insert(avatar.clone(), id.clone());
                self.report.unchanged += 1;
                continue;
            }
            let d = descriptions.get(avatar).cloned().unwrap_or(Value::Null);
            let int =
                |key: &str, default: i64| d.get(key).and_then(Value::as_i64).unwrap_or(default);
            let mut data = serde_json::Map::new();
            for key in ["title", "connections"] {
                if let Some(v) = d.get(key) {
                    data.insert(key.into(), v.clone());
                }
            }
            let input = personas::PersonaInput {
                name: name.as_str().unwrap_or("User").to_string(),
                description: d
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                position: int("position", 0),
                depth: int("depth", 2),
                role: int("role", 0),
                lorebook: d
                    .get("lorebook")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                data: Value::Object(data),
            };
            let avatar_path = self.root.join("User Avatars").join(avatar);
            let avatar_hash = match tokio::fs::read(&avatar_path).await {
                Ok(bytes) => store_file(self.state, bytes).await.ok().map(|f| f.hash),
                Err(_) => None,
            };
            let (user_id, source) = (self.user_id.to_string(), avatar.clone());
            match self
                .state
                .db
                .write(move |c| {
                    personas::create(c, &user_id, &input, avatar_hash.as_deref(), Some(&source))
                })
                .await
            {
                Ok(persona) => {
                    by_avatar.insert(avatar.clone(), persona.id);
                    self.report.personas += 1;
                }
                Err(e) => self.fail(&avatar_path, ApiError::from(e).message),
            }
        }
        if let Some(default) = power.get("default_persona").and_then(Value::as_str)
            && let Some(id) = by_avatar.get(default).cloned()
        {
            let user_id = self.user_id.to_string();
            let _ = self
                .state
                .db
                .write(move |c| personas::set_default(c, &user_id, Some(&id)))
                .await;
        }
        by_avatar
    }

    /// SillyTavern's tags and `tag_map`, added to the imported characters.
    async fn tags(&mut self, settings: &Value, by_avatar: &HashMap<String, String>) {
        let Some(list) = settings.get("tags").and_then(Value::as_array) else {
            return;
        };
        let st_tags: Vec<(String, Value)> = list
            .iter()
            .filter_map(|t| {
                Some((
                    t.get("id")?
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| Some(t.get("id")?.to_string()))?,
                    t.clone(),
                ))
            })
            .collect();
        let tag_map = settings.get("tag_map").cloned().unwrap_or(Value::Null);
        let assignments: Vec<(String, Vec<String>)> = by_avatar
            .iter()
            .map(|(avatar, id)| {
                let ids = tag_map
                    .get(avatar)
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                (id.clone(), ids)
            })
            .collect();
        let user_id = self.user_id.to_string();
        let result = self
            .state
            .db
            .write(move |c| {
                let tx = c.transaction()?;
                let mut ours = HashMap::new();
                for (st_id, tag) in &st_tags {
                    let Some(name) = tag
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|n| !n.trim().is_empty())
                    else {
                        continue;
                    };
                    let mut created = tags::ensure(&tx, &user_id, name.trim())?;
                    let color = |key: &str| {
                        tag.get(key)
                            .and_then(Value::as_str)
                            .filter(|c| !c.is_empty())
                            .map(str::to_string)
                    };
                    created.color = color("color").or(created.color);
                    created.color2 = color("color2").or(created.color2);
                    created.folder = match tag.get("folder_type").and_then(Value::as_str) {
                        Some("OPEN") => "open".into(),
                        Some("CLOSED") => "closed".into(),
                        _ => created.folder,
                    };
                    let created = tags::update(&tx, &user_id, &created)?;
                    ours.insert(st_id.clone(), created.id);
                }
                for (character_id, st_ids) in &assignments {
                    let mut ids = tags::for_entity(&tx, characters::ENTITY, character_id)?;
                    for st_id in st_ids {
                        if let Some(id) = ours.get(st_id)
                            && !ids.contains(id)
                        {
                            ids.push(id.clone());
                        }
                    }
                    tags::set_entity_tags(&tx, characters::ENTITY, character_id, &ids)?;
                }
                tx.commit()?;
                Ok(())
            })
            .await;
        if let Err(e) = result {
            let path = self.root.join("settings.json");
            self.fail(&path, ApiError::from(e).message);
        }
    }

    /// API keys from `secrets.json`; returns `[{ id, provider, active, stId }]` for the web app,
    /// which sets the addresses each key may be sent to (`stId`: SillyTavern's id for the key,
    /// which connection profiles refer to).
    async fn secrets(&mut self) -> Vec<Value> {
        let path = self.root.join("secrets.json");
        let Ok(bytes) = tokio::fs::read(&path).await else {
            return Vec::new();
        };
        let Ok(Value::Object(all)) = serde_json::from_slice::<Value>(&bytes) else {
            self.fail(&path, "not a JSON object");
            return Vec::new();
        };
        let mut imported = Vec::new();
        for (key, value) in all {
            let Some(provider) = key.strip_prefix("api_key_") else {
                continue;
            };
            if NON_MODEL_KEYS.contains(&key.as_str()) {
                *self.report.skipped.entry("otherKeys".into()).or_default() += 1;
                continue;
            }
            // 1.19 keeps a list of keys per service; older versions a single string.
            let entries: Vec<(String, String, bool, Value)> = match &value {
                Value::String(s) => vec![(s.clone(), String::new(), true, Value::Null)],
                Value::Array(list) => list
                    .iter()
                    .filter_map(|e| {
                        Some((
                            e.get("value")?.as_str()?.to_string(),
                            e.get("label")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            e.get("active").and_then(Value::as_bool).unwrap_or(false),
                            e.get("id").cloned().unwrap_or(Value::Null),
                        ))
                    })
                    .collect(),
                _ => Vec::new(),
            };
            for (secret, label, active, st_id) in entries {
                let secret = secret.trim().to_string();
                if secret.is_empty() {
                    continue;
                }
                let masked = crypto::mask(&secret);
                let ciphertext = self.state.secrets.seal(secret.as_bytes());
                let label = if label.trim().is_empty() {
                    masked.clone()
                } else {
                    label
                };
                let (user_id, provider_s) = (self.user_id.to_string(), provider.to_string());
                let created = self
                    .state
                    .db
                    .write(move |c| {
                        secrets::create(
                            c,
                            &user_id,
                            secrets::NewSecret {
                                provider: &provider_s,
                                label: &label,
                                masked: &masked,
                                ciphertext: &ciphertext,
                                allowed_origins: &[],
                            },
                        )
                    })
                    .await;
                match created {
                    Ok(info) => {
                        self.report.secrets += 1;
                        imported.push(json!({
                            "id": info.id,
                            "provider": provider,
                            "active": active,
                            "stId": st_id,
                        }));
                    }
                    Err(e) => self.fail(&path, ApiError::from(e).message),
                }
            }
        }
        imported
    }

    fn count_later(&mut self) {
        for (dir, kind) in LATER_DIRS {
            let n = count_files(&self.root.join(dir));
            if n > 0 {
                *self.report.skipped.entry((*kind).into()).or_default() += n;
            }
        }
    }
}

/// Imports the SillyTavern data found in `dir` for `user_id`.
pub async fn import(
    state: &AppState,
    user_id: &str,
    dir: &Path,
    options: ImportOptions,
) -> ApiResult<StImportReport> {
    let root = find_user_root(dir).ok_or_else(|| {
        ApiError::bad_request(
            "no SillyTavern data found (expected settings.json, characters or chats)",
        )
    })?;
    let settings_json = match tokio::fs::read(root.join("settings.json")).await {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok(),
        Err(_) => None,
    };
    let mut importer = Importer {
        state,
        user_id,
        root,
        report: StImportReport::default(),
    };

    let characters_by_avatar = importer.characters().await;
    importer.chats(&characters_by_avatar).await;
    let groups_by_id = importer
        .groups(settings_json.as_ref(), &characters_by_avatar)
        .await;
    let lorebooks_by_name = importer.lorebooks().await;
    let presets_by_key = importer.presets().await;
    let empty = Value::Null;
    let personas_by_avatar = importer
        .personas(settings_json.as_ref().unwrap_or(&empty))
        .await;
    if let Some(settings_json) = &settings_json {
        importer.tags(settings_json, &characters_by_avatar).await;
    }
    let imported_secrets = if options.secrets {
        importer.secrets().await
    } else {
        Vec::new()
    };
    let backgrounds = importer.backgrounds().await;
    importer.count_later();

    if let Some(settings_json) = settings_json {
        let stash = json!({
            "settings": settings_json,
            "characters": characters_by_avatar,
            "groups": groups_by_id,
            "personas": personas_by_avatar,
            "lorebooks": lorebooks_by_name,
            "presets": presets_by_key,
            "secrets": imported_secrets,
            "backgrounds": backgrounds,
            "importedAt": bt_store::util::now_ms(),
        });
        let user_id = user_id.to_string();
        match state
            .db
            .write(move |c| settings::put(c, &user_id, STASH_NAMESPACE, &stash, None))
            .await
        {
            Ok(_) => importer.report.settings = true,
            Err(e) => {
                let path = importer.root.join("settings.json");
                importer.fail(&path, ApiError::from(e).message);
            }
        }
    }
    Ok(importer.report)
}

/// Tells open clients to reload what an import may have changed.
pub fn notify_imported(state: &AppState, user_id: &str, origin: &Option<String>) {
    for kind in [
        "character",
        "group",
        "lorebook",
        "preset",
        "persona",
        "tag",
        "secret",
    ] {
        state.notify(user_id, kind, "imported", "", None, origin);
    }
    state.notify(
        user_id,
        "settings",
        "updated",
        STASH_NAMESPACE,
        None,
        origin,
    );
}
