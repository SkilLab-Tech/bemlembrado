-- mig 0013: write-time consolidation provenance. `updated_at` records when a
-- memory row was last rewritten by consolidation (a CONTESTED write merged into it).
-- NULL = never consolidated (the row still reads exactly as first inserted). Additive
-- and nullable, so existing rows and the default (consolidation-off) write path are
-- unaffected.
ALTER TABLE memory ADD COLUMN updated_at INTEGER;
