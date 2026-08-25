import type { Db } from "../db/client";
import { requireNamespace, resolveNamespace } from "../auth/namespace";

/**
 * Single entry every memory op (add/search/delete) calls before touching
 * D1/Vectorize/KV: requires the namespace label (400 if absent) AND resolves it
 * to a tenant-owned id (404 cross-tenant). Thin reuse of the F1-17 resolver —
 * no re-implementation of tenant filtering (INVARIANT #2).
 */
export async function resolveMemoryNamespace(
  db: Db,
  tenantId: string,
  label: string | undefined | null,
  allowConfidential: boolean,
): Promise<{ id: string; confidential: boolean }> {
  return resolveNamespace(db, tenantId, requireNamespace(label), allowConfidential);
}
