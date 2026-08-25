import { namespaceHidden } from "../auth/namespace";
import type { Db } from "../db/client";
import type { KvStore } from "../db/kv";
import { NotFound } from "../http/errors";
import { resolveMemoryNamespace } from "../memory/namespace-guard";
import { noteChunkIds } from "../vault/retrieve";
import type { VaultStore } from "../vault/store";
import type { Audit } from "./audit";

/**
 * LGPD right-to-erasure. Delete a namespace
 * and cascade across EVERY store: R2 vault objects + Vectorize vectors (episodes +
 * note chunks) + KV hot-path keys (`t:{tenant}:ns:{ns}:*`) + D1 (memory, note,
 * note_link, session->message via FK CASCADE) + an audit row. Ownership-checked
 * (tenant-scoped) so there is no cross-tenant delete.
 */

const MS_PER_DAY = 86_400_000;

export interface DeleteVectorize {
  deleteByIds(ids: string[]): Promise<unknown>;
}

export interface DeleteDeps {
  db: Db;
  vault: VaultStore;
  /** Absent when the Vectorize binding is unavailable (e.g. tests) — vectors are then skipped + reported. */
  vectorize: DeleteVectorize | undefined;
  /** Hot-path KV store — purges the namespace's cached keys. Optional: skipped + reported when absent. */
  kv?: KvStore;
  audit: Audit;
}

export interface DeleteResult {
  vaultObjects: number;
  vectors: number;
  vectorsSkipped: boolean;
  kvKeys: number;
}

/**
 * @param actor  audit-trail attribution for WHO performed the erasure (the API-key
 *   fingerprint / scoped-token id). Defaults to the tenant id when a finer principal
 *   is unavailable, preserving the tenant-scoped audit record either way.
 * @param allowConfidential  the DEVICE-DERIVED confidential claim (`principal.confidential`).
 *   Namespace ids are deterministic (`{tenant}:{label}`), so without this a non-confidential
 *   `memory:delete` token could compute a confidential id and cascade-delete a namespace it can
 *   never read. Fail-CLOSED default (`false`): a caller that forgets it can only DENY, never leak.
 */
export async function deleteNamespace(deps: DeleteDeps, tenantId: string, namespaceId: string, now: number, actor: string = tenantId, allowConfidential = false): Promise<DeleteResult> {
  const ns = await deps.db.getNamespaceById(tenantId, namespaceId);
  if (ns === null || namespaceHidden(ns, allowConfidential)) {
    throw new NotFound("namespace not found"); // ownership + confidential ACL — uniform 404, no existence oracle
  }

  // Collect vector ids from D1 BEFORE the cascade wipes the rows.
  const memories = await deps.db.listMemoriesByNamespace(namespaceId);
  const episodeVectorIds = memories.map((m) => m.vector_id).filter((v): v is string => v !== null);
  const notes = await deps.db.listNotesByNamespace(namespaceId);
  const noteVectorIds = notes.flatMap((n) => noteChunkIds(n.slug));

  // R2 vault (notes + index).
  const vaultObjects = await deps.vault.deleteNamespaceObjects(tenantId, namespaceId);

  // Vectorize (episodes + note chunks). deleteByIds is id-based, namespace-agnostic.
  const ids = [...episodeVectorIds, ...noteVectorIds];
  let vectors = 0;
  let vectorsSkipped = false;
  if (deps.vectorize !== undefined) {
    if (ids.length > 0) {
      await deps.vectorize.deleteByIds(ids);
      vectors = ids.length;
    }
  } else {
    vectorsSkipped = ids.length > 0;
  }

  // KV hot-path keys for this namespace. No-op when unbound or empty.
  const kvKeys = deps.kv !== undefined ? await deps.kv.purgeNamespace(tenantId, namespaceId) : 0;

  // D1 cascade — the erasure itself. This is the user's LGPD right; it must not be
  // rolled back or masked by a downstream failure.
  await deps.db.deleteNamespace(tenantId, namespaceId);

  // Audit is best-effort AFTER the cascade: the data is already gone, so a failing
  // audit write must NOT re-throw (that would 500 a request whose erasure succeeded,
  // misleading the caller). We would rather lose an audit row than the deletion.
  try {
    await deps.audit.record(tenantId, actor, "delete", `namespace:${namespaceId}`, now);
  } catch {
    // swallow: erasure completed; audit is a secondary, non-blocking concern.
  }

  return { vaultObjects, vectors, vectorsSkipped, kvKeys };
}

export interface DeleteMemoryDeps {
  db: Db;
  /** Absent when the Vectorize binding is unavailable — the vector delete is then skipped + reported. */
  vectorize: DeleteVectorize | undefined;
  audit: Audit;
}

export interface DeleteMemoryResult {
  deleted: boolean;
  id: string;
  /** true when the row had a vector but the Vectorize binding was absent (delete not applied to the index). */
  vectorSkipped: boolean;
}

/**
 * LGPD right-to-erasure at RECORD grain. Deletes one memory across
 * Vectorize + D1 + an audit row — the finer-grained analog of deleteNamespace, for a data
 * subject who wants a single record gone rather than a whole namespace. The namespace is
 * resolved with the DEVICE confidential claim, so a confidential-denied / cross-tenant /
 * unknown id all resolve to a uniform NotFound (no existence oracle). Vector-then-D1, so no
 * orphan vector is left behind; audit is best-effort AFTER the erasure (a failing audit must
 * not 500 a completed deletion).
 */
export async function deleteMemory(
  deps: DeleteMemoryDeps,
  opts: { tenantId: string; actor: string; namespace: string; id: string; allowConfidential: boolean },
  now: number,
): Promise<DeleteMemoryResult> {
  const { id: namespaceId } = await resolveMemoryNamespace(deps.db, opts.tenantId, opts.namespace, opts.allowConfidential);
  const row = await deps.db.getMemoryById(namespaceId, opts.id);
  if (row === null) throw new NotFound("memory not found"); // unknown / cross-tenant / confidential-denied → uniform 404

  let vectorSkipped = false;
  if (row.vector_id !== null) {
    if (deps.vectorize !== undefined) await deps.vectorize.deleteByIds([row.vector_id]);
    else vectorSkipped = true;
  }
  await deps.db.deleteMemoryById(namespaceId, opts.id);

  try {
    await deps.audit.record(opts.tenantId, opts.actor, "delete", `memory:${opts.id}`, now);
  } catch {
    // swallow: erasure completed; audit is a secondary, non-blocking concern (same rule as deleteNamespace).
  }

  return { deleted: true, id: opts.id, vectorSkipped };
}

/** A memory/note is purge-eligible once it outlives the namespace retention window. */
export function isExpired(createdAt: number, retentionDays: number | null | undefined, now: number): boolean {
  if (retentionDays === null || retentionDays === undefined || retentionDays <= 0) return false;
  return now - createdAt > retentionDays * MS_PER_DAY;
}
