import type { AuditAction, AuditEventRow, Db } from "../db/client";
import { createLogger } from "../obs/log";

/**
 * LGPD audit trail. One row per memory op
 * (read|write|export|delete), tenant-scoped + queryable by time range.
 *
 * Recorded at the TOOL-CORE SUCCESS BOUNDARY via `recordAudit` — after the op
 * actually succeeds, not in HTTP middleware. This avoids the failure modes of the
 * removed `auditAction` middleware, which ran after `next()` and so (a) recorded
 * on 4xx/5xx, (b) silently missed when the handler threw, and (c) wrote the raw
 * request target. Free-text (a search query) is HASHED, never stored raw (LGPD).
 */

export class Audit {
  constructor(private readonly db: Db) {}

  async record(
    tenantId: string,
    actor: string,
    action: AuditAction,
    target: string | null,
    now: number,
    requestId?: string,
    confidential = false,
  ): Promise<void> {
    await this.db.insertAuditEvent({
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      actor,
      action,
      target,
      request_id: requestId ?? null,
      created_at: now,
      confidential: confidential ? 1 : 0,
    });
  }

  list(tenantId: string, opts: { since?: number; until?: number } = {}): Promise<AuditEventRow[]> {
    return this.db.listAuditEventsByTenant(tenantId, opts);
  }
}

/**
 * Non-reversible, stable digest for audit targets. Used so a search query (which
 * can contain personal data) is never persisted in cleartext — only its hash is
 * stored, enough to correlate repeated queries without retaining the content.
 */
export async function hashForAudit(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * The thing acted upon. A discriminated union so the only way to audit a search
 * is the `query` kind — which hashes internally. There is no code path that puts
 * a raw query into the audit log.
 */
export type AuditTargetSpec =
  | { kind: "memory"; namespace: string; memoryId: string }
  | { kind: "query"; namespace: string; query: string }
  | { kind: "namespace"; namespace: string }
  | { kind: "session"; sessionId: string }
  | { kind: "resource"; name: string };

async function resolveTarget(spec: AuditTargetSpec): Promise<string> {
  switch (spec.kind) {
    case "memory":
      return `mem:${spec.namespace}#${spec.memoryId}`;
    case "query":
      return `query:${spec.namespace}#${await hashForAudit(spec.query)}`;
    case "namespace":
      return `namespace:${spec.namespace}`;
    case "session":
      return `session:${spec.sessionId}`;
    case "resource":
      return spec.name;
  }
}

/** Who/what an audited op is attributed to. `keyId` (API-key fingerprint, wired in the REST/MCP layer) is the actor; it falls back to the tenant id. */
export interface AuditPrincipal {
  tenantId: string;
  keyId?: string;
  requestId?: string;
}

/**
 * Success-boundary audit recorder. Call AFTER a tool-core op succeeds.
 * - exactly-once: writes a single row per call.
 * - best-effort: NEVER throws. A failed audit must not turn a succeeded op into a
 *   500 or trigger a rollback — it logs a warning and returns.
 * - LGPD-safe: the target is built from a typed spec; queries are hashed.
 */
export async function recordAudit(
  db: Db,
  principal: AuditPrincipal,
  action: AuditAction,
  target: AuditTargetSpec | null,
  now: number,
  confidential = false,
): Promise<void> {
  try {
    const resolved = target === null ? null : await resolveTarget(target);
    const actor = principal.keyId ?? principal.tenantId;
    await new Audit(db).record(principal.tenantId, actor, action, resolved, now, principal.requestId, confidential);
  } catch (err) {
    createLogger().log("warn", "audit record failed (best-effort; op unaffected)", {
      action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
