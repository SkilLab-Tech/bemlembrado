import type { ByokProvider, Db } from "../db/client";
import { openSecret, sealSecret } from "../crypto/aead";

/**
 * Managed BYOK: a tenant brings its own provider API key so inference bills
 * to THEIR provider account. The key is sealed with AES-GCM (KEK = Workers Secret BYOK_KEK)
 * before it touches D1 — the plaintext is only ever recomposed in-memory on the turn path.
 */

/** Inference key overrides — the shape buildInferenceDeps() merges over the platform keys. */
export interface TenantProviderKeys {
  anthropicKey?: string;
  maritacaKey?: string;
}

export async function storeProviderKey(db: Db, kek: string, tenantId: string, provider: ByokProvider, rawKey: string, now: number): Promise<void> {
  const sealed = await sealSecret(kek, rawKey);
  await db.upsertProviderKey({ tenant_id: tenantId, provider, ciphertext: sealed.ciphertext, iv: sealed.iv, created_at: now });
}

/** Decrypt a tenant's stored provider keys into the inference override shape. A missing key is simply absent (not an error). */
export async function resolveTenantKeys(db: Db, kek: string, tenantId: string): Promise<TenantProviderKeys> {
  const out: TenantProviderKeys = {};
  const anthropic = await db.getProviderKey(tenantId, "anthropic");
  if (anthropic !== null) out.anthropicKey = await openSecret(kek, anthropic);
  const maritaca = await db.getProviderKey(tenantId, "maritaca");
  if (maritaca !== null) out.maritacaKey = await openSecret(kek, maritaca);
  return out;
}
