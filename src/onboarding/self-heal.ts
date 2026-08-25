import { assertNamespaceQuota, type AbuseConfig } from "../abuse/guards";
import type { Db, NamespaceRow } from "../db/client";
import type { Env } from "../env";

/**
 * "It just works" self-heal (PR #47 / ux-B2). The first call on a fresh tenant
 * succeeds with no provisioning step: namespaces are auto-created on demand, and
 * inference gracefully falls back to Workers AI when no premium provider key is set.
 */

export class SelfHealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfHealError";
  }
}

/**
 * Resolve-or-create a tenant's namespace (idempotent + race-safe). The id is
 * derived deterministically from (tenant, label) — both UNIQUE — so concurrent
 * first-calls converge on the same row.
 *
 * When `opts.quota` is supplied (abuse guards on), a NEW namespace is refused once
 * the tenant is at its per-tenant cap. The check runs only on the create
 * branch — resolving an existing namespace never counts or throws. This is the sole
 * namespace-creation primitive, so gating it here covers every current + future
 * caller (self-host seed, LGPD import; a public create endpoint would reuse it).
 */
export async function ensureNamespace(
  db: Db,
  tenantId: string,
  label: string,
  now: number,
  opts?: { quota?: AbuseConfig },
): Promise<NamespaceRow> {
  if (tenantId.length === 0 || label.length === 0) {
    throw new SelfHealError("tenantId and label are required");
  }
  const existing = await db.getNamespace(tenantId, label);
  if (existing !== null) return existing;

  if (opts?.quota !== undefined) {
    assertNamespaceQuota(await db.countNamespacesByTenant(tenantId), opts.quota);
  }
  await db.insertNamespaceIfAbsent({ id: `${tenantId}:${label}`, tenant_id: tenantId, label, created_at: now });
  const created = await db.getNamespace(tenantId, label);
  if (created === null) {
    throw new SelfHealError(`failed to ensure namespace ${label}`);
  }
  return created;
}

export type InferenceProvider = "anthropic" | "workers-ai";

/**
 * Choose the inference provider: premium Anthropic when a key is present, else
 * the always-available Workers AI default — so a fresh tenant never hits a wall.
 * (Embeddings always use Workers AI bge-m3; this governs the chat/completion path.)
 */
export function selectInferenceProvider(env: Env): InferenceProvider {
  return typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0 ? "anthropic" : "workers-ai";
}
