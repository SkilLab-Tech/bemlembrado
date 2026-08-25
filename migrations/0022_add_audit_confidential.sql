-- mig 0022 (LGPD controller-posture): flag audit_log rows that touched a CONFIDENTIAL namespace,
-- so "who read sensitive data when" is a filterable query (WHERE confidential = 1). The confidential
-- flag is sourced at the ONE resolve choke point (resolveNamespace) and carried into recordAudit, so
-- no read path can mark it inconsistently. Additive; DEFAULT 0 — the trail is closed from deploy
-- forward (pre-existing rows can't be retro-attributed from hashed/opaque targets). Applies clean
-- from zero after 0021. The existing idx_audit_tenant_ts index already serves the tenant+time scan;
-- a dedicated (tenant_id, confidential, created_at) index is deferred until volume needs it.
ALTER TABLE audit_log ADD COLUMN confidential INTEGER NOT NULL DEFAULT 0;
