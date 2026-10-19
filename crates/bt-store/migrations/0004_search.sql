-- Full-text search over messages: the text each message shows (its active swipe), indexed by
-- trigrams so any language and any substring of three or more characters can be found.
-- Contentless: the text stays in `swipes`; rows are keyed by the message's rowid.
CREATE VIRTUAL TABLE message_search USING fts5 (
    text,
    content = '',
    contentless_delete = 1,
    tokenize = 'trigram'
);

INSERT INTO message_search (rowid, text)
SELECT m.rowid, s.content
FROM messages m
JOIN swipes s ON s.message_id = m.id AND s.idx = m.swipe_id;

-- Reindexes one message (its swipes or its active swipe changed).
CREATE TRIGGER message_search_swipe_insert AFTER INSERT ON swipes BEGIN
    DELETE FROM message_search WHERE rowid = (SELECT rowid FROM messages WHERE id = new.message_id);
    INSERT INTO message_search (rowid, text)
    SELECT m.rowid, s.content FROM messages m
    JOIN swipes s ON s.message_id = m.id AND s.idx = m.swipe_id
    WHERE m.id = new.message_id;
END;

CREATE TRIGGER message_search_swipe_update AFTER UPDATE ON swipes BEGIN
    DELETE FROM message_search WHERE rowid = (SELECT rowid FROM messages WHERE id = new.message_id);
    INSERT INTO message_search (rowid, text)
    SELECT m.rowid, s.content FROM messages m
    JOIN swipes s ON s.message_id = m.id AND s.idx = m.swipe_id
    WHERE m.id = new.message_id;
END;

CREATE TRIGGER message_search_swipe_delete AFTER DELETE ON swipes BEGIN
    DELETE FROM message_search WHERE rowid = (SELECT rowid FROM messages WHERE id = old.message_id);
    INSERT INTO message_search (rowid, text)
    SELECT m.rowid, s.content FROM messages m
    JOIN swipes s ON s.message_id = m.id AND s.idx = m.swipe_id
    WHERE m.id = old.message_id;
END;

CREATE TRIGGER message_search_message_swipe AFTER UPDATE OF swipe_id ON messages BEGIN
    DELETE FROM message_search WHERE rowid = new.rowid;
    INSERT INTO message_search (rowid, text)
    SELECT new.rowid, s.content FROM swipes s WHERE s.message_id = new.id AND s.idx = new.swipe_id;
END;

CREATE TRIGGER message_search_message_delete AFTER DELETE ON messages BEGIN
    DELETE FROM message_search WHERE rowid = old.rowid;
END;
