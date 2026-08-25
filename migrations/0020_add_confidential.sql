-- mig 0020 (P4): per-namespace confidential ACL + the per-device claim that authorizes
-- reading it. Server-side DEFAULT-EXCLUDE: a namespace with confidential = 1 resolves to a
-- uniform NotFound for any credential whose claim is 0 — byte-identical to a namespace that
-- does not exist, so the ACL is not an existence oracle (same rule as tenant isolation).
-- The namespace flag is MONOTONIC by construction: the data layer exposes no 1 -> 0 write
-- (SQLite cannot CHECK old-vs-new, so the invariant is "no such statement exists", not a
-- constraint). oauth_token rows are immutable after issue (only revoked_at is ever written,
-- src/db/client.ts), so the token claim is monotonic for free.
-- Additive-only; applies clean from zero after 0019.
ALTER TABLE namespace   ADD COLUMN confidential INTEGER NOT NULL DEFAULT 0;
ALTER TABLE oauth_token ADD COLUMN confidential INTEGER NOT NULL DEFAULT 0;
