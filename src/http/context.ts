import type { Context } from "hono";
import type { AppEnv } from "./app";
import { Db } from "../db/client";
import { KvStore } from "../db/kv";
import { Internal } from "./errors";
import { parseAbuseConfig } from "../abuse/guards";
import { resolveQuotaGuard } from "../billing/plan-gating";
import { buildInferenceDeps } from "../inference/client";
import type { AbuseGuard, ConsolidationDeps } from "../memory/add";
import type { Principal, SessionContextDeps, ToolCoreDeps } from "../core/services";

/**
 * Bridge the Hono request context to the transport-agnostic tool-core.
 * The auth middleware is the ONLY source of tenant identity; these helpers read
 * what it set (tenant, key fingerprint, request id) — no handler re-parses a key.
 */

/** Principal from the authenticated context. keyId/requestId are attached when present. */
export function principalOf(c: Context<AppEnv>): Principal {
  const tenant = c.var.tenant;
  if (tenant === undefined) {
    throw new Internal("auth context missing");
  }
  const keyId = c.var.keyId;
  const requestId = c.var.requestId;
  return {
    tenantId: tenant.id,
    confidential: c.var.confidentialAccess ?? false, // device-derived LGPD claim; fail-closed
    ...(keyId !== undefined ? { keyId } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

/** Tool-core deps from env bindings. 500s (not 400) if AI/Vectorize are unconfigured — a server-side problem, never the caller's. */
export function toolCoreDepsFrom(c: Context<AppEnv>): ToolCoreDeps {
  const ai = c.env.AI;
  if (ai === undefined) {
    throw new Internal("AI binding is not configured");
  }
  const vectorize = c.env.VECTORIZE;
  if (vectorize === undefined) {
    throw new Internal("VECTORIZE binding is not configured");
  }
  const consolidation = consolidationDepsFrom(c);
  const abuse = abuseGuardFrom(c);
  return {
    db: new Db(c.env.DB),
    ai,
    vectorize,
    sessions: c.env.SESSION,
    now: () => Date.now(),
    ...(consolidation !== undefined ? { consolidation } : {}),
    ...(abuse !== undefined ? { abuse } : {}),
  };
}

/**
 * Volume-quota deps — the effective cap for a write. Built from plan entitlements
 * (when PLAN_GATING_ENABLED) composed with the env abuse ceiling (when
 * ABUSE_GUARDS_ENABLED); the most restrictive wins. Undefined when BOTH are off —
 * the zero-cost default (no count query on the hot path). Unchanged default behaviour.
 */
function abuseGuardFrom(c: Context<AppEnv>): AbuseGuard | undefined {
  const config = resolveQuotaGuard({
    planGatingEnabled: c.env.PLAN_GATING_ENABLED === "true",
    abuseEnabled: c.env.ABUSE_GUARDS_ENABLED === "true",
    plan: c.var.tenant?.plan,
    abuseConfig: parseAbuseConfig(c.env),
  });
  return config !== undefined ? { enabled: true, config } : undefined;
}

/**
 * Write-time consolidation deps — built ONLY when CONSOLIDATION_ENABLED === "true"
 * (default off ⇒ undefined ⇒ add_memory takes its unchanged, cost-free path). Uses
 * the Workers AI chat client + the KV hot-path store for the post-merge cache bust.
 */
function consolidationDepsFrom(c: Context<AppEnv>): ConsolidationDeps | undefined {
  if (c.env.CONSOLIDATION_ENABLED !== "true") return undefined;
  const { chat } = buildInferenceDeps(c.env);
  return { enabled: true, client: chat, kv: new KvStore(c.env.KV) };
}

/** Deps for a session-context read — D1 + the SessionDO only (no AI/Vectorize needed). */
export function sessionContextDepsFrom(c: Context<AppEnv>): SessionContextDeps {
  return {
    db: new Db(c.env.DB),
    sessions: c.env.SESSION,
    now: () => Date.now(),
  };
}

/** Deps for a namespace op (create/list) — D1 + the resolved per-plan quota; no AI/Vectorize. */
export function namespaceDepsFrom(c: Context<AppEnv>): Pick<ToolCoreDeps, "db" | "now" | "abuse"> {
  const abuse = abuseGuardFrom(c);
  return { db: new Db(c.env.DB), now: () => Date.now(), ...(abuse !== undefined ? { abuse } : {}) };
}
