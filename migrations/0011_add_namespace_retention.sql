-- mig 0011: configurable retention. NULL/<=0 = keep forever;
-- >0 = days after which a memory/note is eligible for auto-purge (cron lands later).
-- Right-to-erasure (explicit delete) cascades immediately via the namespace delete.
ALTER TABLE namespace ADD COLUMN retention_days INTEGER;
