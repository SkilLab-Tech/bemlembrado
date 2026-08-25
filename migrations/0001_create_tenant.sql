-- mig 0001: TENANT — the tenant isolation anchor (INVARIANT #2).
-- api_key_hash stores only the hash, never the raw key (UNIQUE implies its index).
CREATE TABLE tenant (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  plan         TEXT NOT NULL DEFAULT 'open' CHECK (plan IN ('open', 'starter', 'pro', 'managed')),
  api_key_hash TEXT UNIQUE,
  created_at   INTEGER NOT NULL
);
