-- mig 0021: vector-write confirmation flag on memory. add_memory is now
-- D1-first — it inserts the row with vector_ok = 0, upserts the vector, then flips the row
-- to vector_ok = 1. A crash therefore never leaves an orphan VECTOR with no D1 row (which
-- surfaced as a null-hydration search hit consuming a topK slot). DEFAULT 1 so every existing
-- row (and any caller that does not manage the flag) stays searchable — the flag only marks
-- the brief in-flight window of a fresh write.
-- Additive-only; applies clean from zero after 0020.
ALTER TABLE memory ADD COLUMN vector_ok INTEGER NOT NULL DEFAULT 1;
