import type { Db } from "../db/client";
import { BadRequest, NotFound } from "../http/errors";

/**
 * Namespace boundary (INVARIANT #2 capstone). Every data operation must carry a
 * namespace, and that namespace must be proven tenant-owned before it reaches
 * D1/Vectorize/KV. A cross-tenant or unknown namespace returns 404 — identical
 * to a truly-missing one — so there is no existence oracle (no 403/404 split).
 */

/** Throw BadRequest when the namespace label is absent/empty. */
export function requireNamespace(label: string | undefined | null): string {
  if (label === undefined || label === null || label.length === 0) {
    throw new BadRequest("namespace is required");
  }
  return label;
}

/**
 * The confidential ACL predicate, in ONE place so every namespace-addressed path (read,
 * create-collision, delete) denies IDENTICALLY — the uniform-404 that blocks the existence
 * oracle. A row is "hidden" when it is confidential and the credential lacks the device-derived
 * claim. `null` is NOT hidden: absence is the caller's concern (a create can proceed on a free
 * label; a read/delete throws its own NotFound), and only a real-but-masked row is an oracle risk.
 */
export function namespaceHidden(ns: { confidential?: number } | null, allowConfidential: boolean): boolean {
  return ns !== null && (ns.confidential ?? 0) === 1 && !allowConfidential;
}

/**
 * Resolve a tenant-owned namespace label to its id, or 404 (never leaks existence).
 *
 * `allowConfidential` is the DEVICE-DERIVED claim (`principal.confidential`, ultimately
 * `oauth_token.confidential` resolved in apiKeyAuth) — it is NEVER a request parameter and
 * no tool/REST input carries an `include_confidential`-style field. A confidential namespace
 * seen by an unauthorized credential throws the SAME NotFound as a nonexistent one: no
 * 403/404 split, so the ACL cannot be used as an existence oracle.
 *
 * The parameter is REQUIRED on purpose (no default): TS strict then enumerates every caller,
 * so a new read path cannot silently skip the LGPD gate.
 */
export async function resolveNamespace(
  db: Db,
  tenantId: string,
  label: string,
  allowConfidential: boolean,
): Promise<{ id: string; confidential: boolean }> {
  const ns = await db.getNamespace(tenantId, label);
  if (ns === null || namespaceHidden(ns, allowConfidential)) {
    throw new NotFound("namespace not found"); // missing AND confidential-denied throw identically — no oracle
  }
  // Surface the actual namespace tier so the ONE resolve choke point is where the LGPD read-audit
  // sources its `confidential` flag (mig 0022) — no read path can mark it inconsistently.
  return { id: ns.id, confidential: (ns.confidential ?? 0) === 1 };
}
