-- mig 0019: managed BYOK — a tenant's own provider API key, stored
-- ENCRYPTED AT REST (AES-GCM; the raw key never touches D1). The KEK lives in a Workers
-- Secret (BYOK_KEK), never here. One key per (tenant, provider); INSERT OR REPLACE to
-- rotate. FK-CASCADE from tenant so a right-to-erasure delete removes the key too.
-- Additive-only; applies clean from zero after 0018.
CREATE TABLE tenant_provider_key (
  tenant_id  TEXT    NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  provider   TEXT    NOT NULL,          -- 'anthropic' | 'maritaca'
  ciphertext TEXT    NOT NULL,          -- base64( AES-GCM ciphertext + auth tag )
  iv         TEXT    NOT NULL,          -- base64( 12-byte nonce )
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, provider)
);
