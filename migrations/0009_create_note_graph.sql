-- mig 0009 (vault-A2 / #42): LLM-Wiki link graph. R2 markdown is the source of
-- truth for notes; D1 mirrors note METADATA + the [[wikilink]] edge graph here so
-- backlinks/traversal/orphan-detection are cheap and ON DELETE CASCADE from
-- namespace erases the whole graph (right-to-erasure, #50).
--
-- Scoped by namespace_id only (transitively tenant-owned via namespace FK) —
-- same precedent as the memory table; INVARIANT #2 holds on the chain.
CREATE TABLE note (
  id           TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES namespace(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  type         TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (namespace_id, slug)
);
CREATE INDEX idx_note_ns ON note (namespace_id);

-- Directed [[wikilink]] edges. to_slug deliberately has NO FK to note: a link may
-- point at a not-yet-created note (an orphan link) — those are FLAGGED, not rejected.
CREATE TABLE note_link (
  namespace_id TEXT NOT NULL REFERENCES namespace(id) ON DELETE CASCADE,
  from_slug    TEXT NOT NULL,
  to_slug      TEXT NOT NULL,
  PRIMARY KEY (namespace_id, from_slug, to_slug)
);
CREATE INDEX idx_note_link_to ON note_link (namespace_id, to_slug);
