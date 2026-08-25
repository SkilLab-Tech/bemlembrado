-- mig 0006: USAGE_EVENT — per-turn token telemetry (FR-9). Columns map 1:1
-- to the /v1/usage savings ratio (cache_read + cache_write vs fresh). session_id is
-- intentionally NOT FK-constrained: usage may outlive a purged session per retention.
CREATE TABLE usage_event (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  session_id         TEXT,
  turn               INTEGER,
  tokens_fresh       INTEGER,
  tokens_cache_read  INTEGER,
  tokens_cache_write INTEGER,
  provider           TEXT,
  model              TEXT,
  cost_usd           REAL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_usage_tenant_time ON usage_event (tenant_id, created_at);
CREATE INDEX idx_usage_session_turn ON usage_event (session_id, turn);
