import type { AbuseConfig } from "../abuse/guards";
import { PLAN_CATALOG, PLAN_IDS, type PlanId } from "./catalog";

/**
 * Server-side plan-gating engine (F6-04/05 / #129-130). Resolves a tenant's plan to
 * its entitlements and composes them with the abuse safety ceiling. Enforcement reuses
 * the existing `assertMemoryQuota`/`assertNamespaceQuota` (an AbuseConfig-shaped cap),
 * so plan-gating is just "which cap applies" — no second enforcement path.
 *
 * FAIL-SAFE: an unknown/absent plan resolves to the most restrictive tier (open), never
 * to unlimited. A tenant is never granted more than its plan by a typo or missing row.
 */

export function isPlanId(value: string | null | undefined): value is PlanId {
  return value !== null && value !== undefined && (PLAN_IDS as readonly string[]).includes(value);
}

/** The entitlement caps for a plan; unknown/absent → open (most restrictive). */
export function entitlementsFor(plan: string | null | undefined): AbuseConfig {
  return PLAN_CATALOG[isPlanId(plan) ? plan : "open"].entitlements;
}

/** Per-field minimum across configs — the most restrictive cap wins. Throws on empty. */
export function effectiveQuota(configs: readonly AbuseConfig[]): AbuseConfig {
  if (configs.length === 0) {
    throw new Error("effectiveQuota requires at least one config");
  }
  return {
    maxMemoriesPerNamespace: Math.min(...configs.map((c) => c.maxMemoriesPerNamespace)),
    maxNamespacesPerTenant: Math.min(...configs.map((c) => c.maxNamespacesPerTenant)),
    maxTurnsPerCycle: Math.min(...configs.map((c) => c.maxTurnsPerCycle)),
  };
}

/**
 * Resolve the effective volume-quota for a request, composing plan entitlements (when
 * plan-gating is on) with the env abuse ceiling (when abuse guards are on). Returns
 * undefined when NEITHER is enabled — the zero-cost default, no count query on the hot
 * path. When both are on, the more restrictive of the two wins per field.
 */
export function resolveQuotaGuard(opts: {
  planGatingEnabled: boolean;
  abuseEnabled: boolean;
  plan: string | null | undefined;
  abuseConfig: AbuseConfig;
}): AbuseConfig | undefined {
  const configs: AbuseConfig[] = [];
  if (opts.planGatingEnabled) configs.push(entitlementsFor(opts.plan));
  if (opts.abuseEnabled) configs.push(opts.abuseConfig);
  return configs.length === 0 ? undefined : effectiveQuota(configs);
}
