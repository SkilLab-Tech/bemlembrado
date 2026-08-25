-- mig 0012: correlate an audit row to the request that produced it.
-- Additive + nullable: existing rows (and the export/delete recorders that
-- predate request-id plumbing) stay valid with request_id = NULL. No backfill.
ALTER TABLE audit_log ADD COLUMN request_id TEXT;
