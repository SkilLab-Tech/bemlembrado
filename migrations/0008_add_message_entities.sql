-- mig 0008: episodic enrichment — entities extracted per message, stored
-- as a JSON array string. Additive + nullable (existing rows keep NULL). The
-- entity-log writer lands in F2.
ALTER TABLE message ADD COLUMN entities_json TEXT;
