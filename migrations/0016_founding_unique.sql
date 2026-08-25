-- mig 0016: Founding-Members signup is idempotent per (email, tier).
-- A prospect re-submitting the same tier must NOT create a duplicate signal (it would
-- also over-count the firm per-tier cap). This UNIQUE index is the race-safe backstop:
-- the app pre-checks for a friendly response, but a concurrent double-submit is caught
-- here rather than storing two rows. Additive-only; applies clean from zero after 0015.
CREATE UNIQUE INDEX idx_founding_email_tier ON founding_member (email, tier);
