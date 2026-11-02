-- Conversations whose title never left the placeholder (the first message was
-- stored through a path that did not set it) get the first user message as
-- their title. updated_at is left alone so the sidebar order does not change.
UPDATE conversations c
SET title = t.title
FROM (
    SELECT DISTINCT ON (conversation_id) conversation_id,
           CASE WHEN char_length(norm) <= 72 THEN norm
                ELSE btrim(left(norm, 72)) || '…' END AS title
    FROM (
        SELECT conversation_id, created_at,
               regexp_replace(btrim(content), '\s+', ' ', 'g') AS norm
        FROM messages
        WHERE role = 'user' AND btrim(content) <> ''
    ) m
    ORDER BY conversation_id, created_at
) t
WHERE c.id = t.conversation_id AND c.title = 'New conversation';
