-- mig 0007: idempotent-upsert key for MEMORY. (ttl already shipped in 0003.)
-- Partial UNIQUE index so multiple rows may have a NULL dedupe_key, but a given
-- (namespace_id, dedupe_key) pair is unique — the basis for idempotent add_memory.
ALTER TABLE memory ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX idx_memory_ns_dedupe ON memory (namespace_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
