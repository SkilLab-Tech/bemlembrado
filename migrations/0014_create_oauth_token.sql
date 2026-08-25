-- mig 0014: scoped access tokens (OAuth-style delegated auth). Unlike the
-- tenant API key (full access), a scoped token grants a least-privilege subset of
-- scopes to a delegated caller. Only the token HASH is stored (SHA-256 + pepper) —
-- never the raw token — the same discipline as TENANT.api_key_hash. Scopes are a
-- space-separated string (OAuth convention). expires_at NULL = no expiry; revoked_at
-- NULL = active. FK CASCADE so a tenant delete removes its tokens.
CREATE TABLE oauth_token (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  scopes      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX idx_oauth_token_tenant ON oauth_token (tenant_id);
