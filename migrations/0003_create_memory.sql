-- mig 0003: MEMORY — semantic|episodic rows. vector_id links the D1 row to
-- its Vectorize id so right-to-delete can cascade to BOTH stores (D1 cascade deletes
-- rows; F2/F5 delete the matching Vectorize ids). ttl nullable = no expiry.
CREATE TABLE memory (
  id            TEXT PRIMARY KEY,
  namespace_id  TEXT NOT NULL REFERENCES namespace(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('semantic', 'episodic')),
  text          TEXT,
  vector_id     TEXT,
  metadata_json TEXT,
  created_at    INTEGER NOT NULL,
  ttl           INTEGER
);
CREATE INDEX idx_memory_ns_kind ON memory (namespace_id, kind);
CREATE INDEX idx_memory_ttl ON memory (ttl);
