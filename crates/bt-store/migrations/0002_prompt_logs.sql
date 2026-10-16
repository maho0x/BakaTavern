-- The prompts generations sent (BakaTavern's replacement for SillyTavern's itemized prompts):
-- a breakdown by part and the final messages or text, as the web app recorded them.
CREATE TABLE prompt_logs (
    chat_id    TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    -- When the generation started (the reply's `gen_started`, an ISO date).
    started_at TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, started_at)
) WITHOUT ROWID;
CREATE INDEX prompt_logs_created ON prompt_logs (created_at);
