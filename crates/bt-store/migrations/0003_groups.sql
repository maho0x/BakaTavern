-- Group chats (SillyTavern groups): a set of characters who reply in turn.
CREATE TABLE groups (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    avatar       TEXT REFERENCES files (hash),
    fav          INTEGER NOT NULL DEFAULT 0,
    -- SillyTavern group settings (activation_strategy, generation_mode, join prefix and suffix,
    -- ...), verbatim; members, chats and the fields above are kept apart.
    data         TEXT NOT NULL DEFAULT '{}',
    -- SillyTavern group id (its file name) this group was imported from.
    source_id    TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    last_chat_at INTEGER,
    rev          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX groups_user ON groups (user_id, name COLLATE NOCASE);

CREATE TABLE group_members (
    group_id     TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    character_id TEXT NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,
    -- Doesn't reply on its own (SillyTavern `disabled_members`).
    muted        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, character_id)
) WITHOUT ROWID;
CREATE INDEX group_members_character ON group_members (character_id);

-- Group chats belong to a group (`chats.group_id`) instead of a character.
CREATE INDEX chats_group ON chats (group_id, updated_at DESC);

-- The character who wrote a message in a group chat (SillyTavern `original_avatar`).
ALTER TABLE messages ADD COLUMN character_id TEXT REFERENCES characters (id) ON DELETE SET NULL;
