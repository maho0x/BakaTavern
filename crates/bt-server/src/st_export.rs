//! Exporting everything as a SillyTavern user folder (zip), so the data can go back to
//! SillyTavern: cards, chats, lorebooks, presets and persona avatars as files, and a
//! `settings.json`. The web app writes most of `settings.json` (it knows its own settings) using
//! the file names from [`names`]; personas and tags are filled in here.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Seek, Write};

use bt_formats::{card, chat, png, worldinfo};
use bt_store::repo::{characters, chats, lorebooks, messages, personas, presets, tags};
use serde::Serialize;
use serde_json::{Map, Value, json};
use ts_rs::TS;
use zip::write::SimpleFileOptions;

use crate::attachments;
use crate::convert::{message_to_st, sanitize_file_name};
use crate::error::{ApiError, ApiResult};
use crate::media;
use crate::state::AppState;

/// Preset kinds and the SillyTavern folder for each.
const PRESET_DIRS: &[(&str, &str)] = &[
    ("openai", "OpenAI Settings"),
    ("textgen", "TextGen Settings"),
    ("kobold", "KoboldAI Settings"),
    ("novel", "NovelAI Settings"),
    ("instruct", "instruct"),
    ("context", "context"),
    ("sysprompt", "sysprompt"),
    ("reasoning", "reasoning"),
];

/// File names SillyTavern will know the characters and personas by.
#[derive(Debug, Clone, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StExportNames {
    /// Character id → avatar file (`Name.png`).
    pub characters: BTreeMap<String, String>,
    /// Persona id → avatar file in `User Avatars`.
    pub personas: BTreeMap<String, String>,
}

/// A `.png` name that is not taken yet: `Name.png`, `Name_2.png`, ...
fn unique_png(wanted: &str, taken: &mut HashSet<String>) -> String {
    let stem = wanted
        .strip_suffix(".png")
        .or_else(|| wanted.strip_suffix(".PNG"))
        .unwrap_or(wanted);
    let stem = sanitize_file_name(stem);
    let stem = if stem.is_empty() {
        "character".to_string()
    } else {
        stem
    };
    let mut name = format!("{stem}.png");
    let mut n = 2;
    while !taken.insert(name.to_lowercase()) {
        name = format!("{stem}_{n}.png");
        n += 1;
    }
    name
}

/// Deterministic file names (imported items keep their SillyTavern names).
pub async fn names(state: &AppState, user_id: &str) -> ApiResult<StExportNames> {
    let user_id = user_id.to_string();
    let (characters, personas) = state
        .db
        .read(move |c| Ok((characters::list(c, &user_id)?, personas::list(c, &user_id)?)))
        .await?;
    let mut names = StExportNames::default();
    let mut taken = HashSet::new();
    let mut sorted = characters;
    sorted.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    for c in &sorted {
        let wanted = c
            .source_file
            .as_deref()
            .filter(|f| f.to_lowercase().ends_with(".png"))
            .unwrap_or(&c.name);
        names
            .characters
            .insert(c.id.clone(), unique_png(wanted, &mut taken));
    }
    let mut taken = HashSet::new();
    for p in &personas {
        let wanted = p
            .source_file
            .clone()
            .filter(|f| f.to_lowercase().ends_with(".png"))
            .unwrap_or_else(|| format!("user-{}", p.name));
        names
            .personas
            .insert(p.id.clone(), unique_png(&wanted, &mut taken));
    }
    Ok(names)
}

fn zip_error(e: impl std::fmt::Display) -> ApiError {
    ApiError::internal(format!("writing the export: {e}"))
}

/// Writes the export into `out`. `settings` is the `settings.json` from the web app.
pub async fn write_zip<W: Write + Seek + Send + 'static>(
    state: &AppState,
    user_id: &str,
    mut settings: Value,
    out: W,
) -> ApiResult<W> {
    let names = names(state, user_id).await?;
    let uid = user_id.to_string();
    let data = state
        .db
        .read(move |c| {
            let characters = characters::list(c, &uid)?
                .into_iter()
                .map(|s| characters::get(c, &uid, &s.id))
                .collect::<Result<Vec<_>, _>>()?;
            let mut chat_files = Vec::new();
            for character in &characters {
                for chat_row in chats::list_for_character(c, &uid, &character.summary.id)? {
                    let rows = messages::all(c, &chat_row.id)?;
                    chat_files.push((character.summary.id.clone(), chat_row, rows));
                }
            }
            let books = lorebooks::list(c, &uid)?
                .into_iter()
                .map(|b| lorebooks::get(c, &uid, &b.id))
                .collect::<Result<Vec<_>, _>>()?;
            let presets = presets::list(c, &uid, None)?
                .into_iter()
                .map(|p| presets::get(c, &uid, &p.id))
                .collect::<Result<Vec<_>, _>>()?;
            let personas = personas::list(c, &uid)?;
            let tags = tags::list(c, &uid)?;
            let tag_map = tags::by_entity(c, &uid, characters::ENTITY)?;
            Ok((
                characters, chat_files, books, presets, personas, tags, tag_map,
            ))
        })
        .await?;
    let (characters, chat_files, books, preset_rows, persona_rows, tag_rows, tag_map) = data;

    // Personas and tags, which this side knows.
    let root = settings
        .as_object_mut()
        .ok_or_else(|| ApiError::bad_request("settings must be an object"))?;
    let power = root.entry("power_user").or_insert_with(|| json!({}));
    if let Some(power) = power.as_object_mut() {
        let mut persona_names = Map::new();
        let mut descriptions = power
            .get("persona_descriptions")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for p in &persona_rows {
            let file = &names.personas[&p.id];
            persona_names.insert(file.clone(), json!(p.name));
            let mut d = descriptions
                .get(file)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            d.insert("description".into(), json!(p.description));
            d.insert("position".into(), json!(p.position));
            d.insert("depth".into(), json!(p.depth));
            d.insert("role".into(), json!(p.role));
            d.insert(
                "lorebook".into(),
                json!(p.lorebook.clone().unwrap_or_default()),
            );
            if let Some(title) = p.data.get("title") {
                d.insert("title".into(), title.clone());
            }
            descriptions.insert(file.clone(), Value::Object(d));
            if p.is_default {
                power.insert("default_persona".into(), json!(file));
            }
        }
        power.insert("personas".into(), Value::Object(persona_names));
        power.insert("persona_descriptions".into(), Value::Object(descriptions));
    }
    let st_tags: Vec<Value> = tag_rows
        .iter()
        .map(|t| {
            json!({
                "id": t.id,
                "name": t.name,
                "color": t.color.clone().unwrap_or_default(),
                "color2": t.color2.clone().unwrap_or_default(),
                "folder_type": match t.folder.as_str() { "open" => "OPEN", "closed" => "CLOSED", _ => "NONE" },
                "sort_order": t.sort_order,
            })
        })
        .collect();
    root.insert("tags".into(), Value::Array(st_tags));
    let mut st_tag_map = Map::new();
    for (character_id, tag_ids) in &tag_map {
        if let Some(file) = names.characters.get(character_id) {
            st_tag_map.insert(file.clone(), json!(tag_ids));
        }
    }
    root.insert("tag_map".into(), Value::Object(st_tag_map));

    // Images are decoded and re-encoded as PNG off the async runtime.
    let blobs = state.blobs.clone();
    let avatars: Vec<(String, Option<String>)> = persona_rows
        .iter()
        .map(|p| (names.personas[&p.id].clone(), p.avatar.clone()))
        .collect();
    let character_names = names.characters.clone();
    tokio::task::spawn_blocking(move || -> ApiResult<W> {
        let mut zip = zip::ZipWriter::new(out);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let stored =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let png_of = |hash: &Option<String>| -> Vec<u8> {
            hash.as_ref()
                .and_then(|h| blobs.read(h).ok())
                .and_then(|bytes| media::to_png(&bytes).ok())
                .unwrap_or_else(png::placeholder)
        };

        for character in &characters {
            let file = &character_names[&character.summary.id];
            let image = card::write_png(&png_of(&character.summary.avatar), &character.card)
                .map_err(zip_error)?;
            zip.start_file(format!("characters/{file}"), stored)
                .map_err(zip_error)?;
            zip.write_all(&image).map_err(zip_error)?;
        }
        let mut chat_names = HashSet::new();
        let mut attachment_paths: HashMap<(String, attachments::Kind), String> = HashMap::new();
        let mut attachment_files: Vec<(String, Vec<u8>)> = Vec::new();
        for (character_id, chat_row, rows) in &chat_files {
            let folder = character_names[character_id]
                .trim_end_matches(".png")
                .to_string();
            let mut title = sanitize_file_name(&chat_row.title);
            let mut n = 2;
            while !chat_names.insert(format!("{folder}/{title}").to_lowercase()) {
                title = format!("{} ({n})", sanitize_file_name(&chat_row.title));
                n += 1;
            }
            let mut st_messages: Vec<_> = rows.iter().map(message_to_st).collect();
            // Attachments go where SillyTavern keeps them: media by character, file text apart.
            for message in &mut st_messages {
                attachments::rewrite(
                    &mut message.extra,
                    &mut message.swipe_info,
                    &mut |url, kind| {
                        let hash = attachments::stored_hash(url)?;
                        if let Some(path) = attachment_paths.get(&(hash.to_string(), kind)) {
                            return Some(path.clone());
                        }
                        let bytes = blobs.read(hash).ok()?;
                        let path = match kind {
                            attachments::Kind::Media => {
                                format!(
                                    "user/images/{folder}/{hash}.{}",
                                    extension(media::sniff_mime(&bytes))
                                )
                            }
                            attachments::Kind::File => format!("user/files/{hash}.txt"),
                        };
                        attachment_files.push((path.clone(), bytes));
                        attachment_paths.insert((hash.to_string(), kind), path.clone());
                        Some(path)
                    },
                );
            }
            let header = chat_row.header.as_object().cloned().unwrap_or_default();
            let text = chat::to_jsonl(&header, &chat_row.metadata, &st_messages);
            zip.start_file(format!("chats/{folder}/{title}.jsonl"), options)
                .map_err(zip_error)?;
            zip.write_all(text.as_bytes()).map_err(zip_error)?;
        }
        for (path, bytes) in &attachment_files {
            zip.start_file(path.as_str(), stored).map_err(zip_error)?;
            zip.write_all(bytes).map_err(zip_error)?;
        }
        for book in &books {
            let json = serde_json::to_vec_pretty(&worldinfo::to_json(&book.data, &book.entries))
                .map_err(zip_error)?;
            zip.start_file(
                format!("worlds/{}.json", sanitize_file_name(&book.name)),
                options,
            )
            .map_err(zip_error)?;
            zip.write_all(&json).map_err(zip_error)?;
        }
        for preset in &preset_rows {
            let Some((_, dir)) = PRESET_DIRS
                .iter()
                .find(|(kind, _)| *kind == preset.info.kind)
            else {
                continue;
            };
            let json = serde_json::to_vec_pretty(&preset.data).map_err(zip_error)?;
            zip.start_file(
                format!("{dir}/{}.json", sanitize_file_name(&preset.info.name)),
                options,
            )
            .map_err(zip_error)?;
            zip.write_all(&json).map_err(zip_error)?;
        }
        for (file, avatar) in &avatars {
            zip.start_file(format!("User Avatars/{file}"), stored)
                .map_err(zip_error)?;
            zip.write_all(&png_of(avatar)).map_err(zip_error)?;
        }
        let settings_json = serde_json::to_vec_pretty(&settings).map_err(zip_error)?;
        zip.start_file("settings.json", options)
            .map_err(zip_error)?;
        zip.write_all(&settings_json).map_err(zip_error)?;
        zip.finish().map_err(zip_error)
    })
    .await
    .map_err(ApiError::internal)?
}

/// The file extension SillyTavern would give an attachment of this type.
fn extension(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "audio/mpeg" => "mp3",
        "audio/ogg" => "ogg",
        "audio/wav" => "wav",
        "audio/flac" => "flac",
        "audio/aac" => "aac",
        "audio/mp4" => "m4a",
        _ => "bin",
    }
}
