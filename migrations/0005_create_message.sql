-- mig 0005: MESSAGE — episodic log. role includes 'tool' DELIBERATELY
-- (INVARIANT #1): the retrieved Context Block is emitted as a tool-role message,
-- so the schema must persist that role faithfully for replay / cache-identity tests.
CREATE TABLE message (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content     TEXT,
  token_count INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_message_session_time ON message (session_id, created_at);
