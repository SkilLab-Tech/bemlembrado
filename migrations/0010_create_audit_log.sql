-- mig 0010: LGPD audit trail. One row per memory op
-- (read|write|export|delete), tenant-scoped + queryable by time range.
--
-- Tenant-scoped (NOT namespace-scoped) on purpose: deleting a namespace
-- (right-to-erasure, #50) must NOT erase the audit record OF that deletion.
-- Full account erasure cascades from tenant.
CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('read', 'write', 'export', 'delete')),
  target     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_tenant_ts ON audit_log (tenant_id, created_at);
