-- BakaTavern schema v1.
-- Conventions: ULID text primary keys, unix-millisecond timestamps, JSON stored as TEXT.
-- Documents that SillyTavern defines (cards, presets, world info entries, chat metadata)
-- are kept verbatim as JSON so that import/export stays lossless.

CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    handle        TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT,
    ip         TEXT
) WITHOUT ROWID;
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE settings (
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    namespace  TEXT NOT NULL,
    data       TEXT NOT NULL,
    rev        INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, namespace)
) WITHOUT ROWID;

CREATE TABLE secrets (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider        TEXT NOT NULL,
    label           TEXT NOT NULL,
    masked          TEXT NOT NULL,
    ciphertext      BLOB NOT NULL,
    allowed_origins TEXT NOT NULL DEFAULT '[]',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX secrets_user ON secrets (user_id, provider);

-- Content-addressed blobs (blake3). The bytes live in data/blobs/<hash[0..2]>/<hash>.
CREATE TABLE files (
    hash       TEXT PRIMARY KEY,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    width      INTEGER,
    height     INTEGER,
    created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE characters (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    avatar       TEXT REFERENCES files (hash),
    card         TEXT NOT NULL,
    fav          INTEGER NOT NULL DEFAULT 0,
    creator      TEXT NOT NULL DEFAULT '',
    version      TEXT NOT NULL DEFAULT '',
    excerpt      TEXT NOT NULL DEFAULT '',
    source_file  TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    last_chat_at INTEGER,
    rev          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX characters_user_name ON characters (user_id, name COLLATE NOCASE);
CREATE INDEX characters_user_source ON characters (user_id, source_file);

CREATE TABLE tags (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT,
    color2     TEXT,
    folder     TEXT NOT NULL DEFAULT 'none' CHECK (folder IN ('none', 'open', 'closed')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    hidden     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, name)
);

CREATE TABLE entity_tags (
    tag_id      TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    PRIMARY KEY (tag_id, entity_type, entity_id)
) WITHOUT ROWID;
CREATE INDEX entity_tags_entity ON entity_tags (entity_type, entity_id);

CREATE TABLE personas (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    avatar      TEXT REFERENCES files (hash),
    description TEXT NOT NULL DEFAULT '',
    -- SillyTavern persona_description_positions: 0 in prompt, 2 top of AN, 3 bottom of AN, 4 at depth, 9 none.
    position    INTEGER NOT NULL DEFAULT 0,
    depth       INTEGER NOT NULL DEFAULT 2,
    role        INTEGER NOT NULL DEFAULT 0,
    lorebook    TEXT,
    data        TEXT NOT NULL DEFAULT '{}',
    is_default  INTEGER NOT NULL DEFAULT 0,
    source_file TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    rev         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX personas_user ON personas (user_id, name COLLATE NOCASE);

CREATE TABLE chats (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    character_id    TEXT REFERENCES characters (id) ON DELETE CASCADE,
    group_id        TEXT,
    title           TEXT NOT NULL,
    -- SillyTavern chat_metadata (the JSONL header), kept verbatim.
    metadata        TEXT NOT NULL DEFAULT '{}',
    -- Remaining JSONL header fields (user_name, character_name, create_date, ...).
    header          TEXT NOT NULL DEFAULT '{}',
    message_count   INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER,
    preview         TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    rev             INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX chats_character ON chats (character_id, updated_at DESC);
CREATE INDEX chats_user_recent ON chats (user_id, updated_at DESC);

-- seq is the 0-based message index (SillyTavern mesId); it is kept contiguous.
CREATE TABLE messages (
    id         TEXT PRIMARY KEY,
    chat_id    TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    name       TEXT NOT NULL,
    hidden     INTEGER NOT NULL DEFAULT 0,
    swipe_id   INTEGER NOT NULL DEFAULT 0,
    send_date  TEXT NOT NULL DEFAULT '',
    -- SillyTavern message.extra, verbatim.
    extra      TEXT NOT NULL DEFAULT '{}',
    -- Any other top-level message fields (force_avatar, variables, ...), verbatim.
    data       TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    rev        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX messages_chat_seq ON messages (chat_id, seq);

CREATE TABLE swipes (
    message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    idx        INTEGER NOT NULL,
    content    TEXT NOT NULL,
    -- SillyTavern swipe_info[idx], verbatim (send_date, gen_started, gen_finished, extra, ...).
    info       TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (message_id, idx)
) WITHOUT ROWID;

CREATE TABLE lorebooks (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    -- Book-level fields other than `entries`, verbatim.
    data       TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    rev        INTEGER NOT NULL DEFAULT 1,
    UNIQUE (user_id, name)
);

CREATE TABLE lorebook_entries (
    book_id    TEXT NOT NULL REFERENCES lorebooks (id) ON DELETE CASCADE,
    uid        INTEGER NOT NULL,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (book_id, uid)
) WITHOUT ROWID;

-- Named JSON documents in SillyTavern formats: chat completion / textgen / kobold / novel presets,
-- instruct / context / sysprompt / reasoning templates, themes, quick reply sets.
CREATE TABLE presets (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    rev        INTEGER NOT NULL DEFAULT 1,
    UNIQUE (user_id, kind, name)
);

-- Durable LLM generation jobs: the raw upstream response is kept until a client acknowledges it.
CREATE TABLE generation_jobs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    chat_id     TEXT,
    status      TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'aborted')),
    meta        TEXT NOT NULL DEFAULT '{}',
    http_status INTEGER,
    headers     TEXT NOT NULL DEFAULT '{}',
    body        BLOB,
    error       TEXT,
    acked       INTEGER NOT NULL DEFAULT 0,
    -- Client (x-bt-client-id) allowed to store the result; see repo::jobs::claim.
    claimed_by  TEXT,
    claimed_at  INTEGER,
    created_at  INTEGER NOT NULL,
    finished_at INTEGER
);
CREATE INDEX generation_jobs_pending ON generation_jobs (user_id, acked, chat_id);
