-- mig 0004: SESSION — DO-backed at runtime (SessionDO), but D1 remains the
-- source of truth for session metadata. Depends only on NAMESPACE (CASCADE).
CREATE TABLE session (
  id           TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES namespace(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  started_at   INTEGER NOT NULL
);
CREATE INDEX idx_session_namespace ON session (namespace_id);
