-- mig 0002: NAMESPACE — per-user/per-agent isolation unit + required query scope.
-- FK -> tenant ON DELETE CASCADE is the first leg of the LGPD right-to-delete cascade.
CREATE TABLE namespace (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, label)
);
CREATE INDEX idx_namespace_tenant ON namespace (tenant_id);
