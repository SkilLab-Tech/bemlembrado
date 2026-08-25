import type { Env } from "../env";
import { QuotaExceeded } from "../http/errors";

/**
 * Abuse guards. Distinct from the token-bucket rate-limiter (which caps
 * request *frequency*): these cap resource *volume* so one tenant cannot exhaust
 * storage. Pure + config-driven; wired into add_memory ONLY when ABUSE_GUARDS_ENABLED
 * === "true" (default off ⇒ no count query, no hot-path cost).
 *
 * BEST-EFFORT under concurrency (like the rate-limiter): enforcement is count-then-act
 * (read the current count, then insert), which is NOT atomic across D1 statements. Two
 * simultaneous writes can both observe count == cap-1 and both proceed, overshooting the
 * cap by the concurrency factor. These are runaway-abuse ceilings, not exact billing
 * limits, so a bounded overshoot is acceptable; an exact cap would need a D1
 * conditional-insert (INSERT … SELECT … WHERE (SELECT COUNT(*)…) < cap) or a serializing
 * Durable Object — deferred until a hard limit is actually required.
 */

export interface AbuseConfig {
  /** Max memories per namespace before writes are refused. */
  readonly maxMemoriesPerNamespace: number;
  /** Max namespaces per tenant (guard available for the creation path). */
  readonly maxNamespacesPerTenant: number;
  /**
   * Max DEFAULT-inference (Workers-AI) turns per billing cycle. The load-bearing
   * margin guard (TC-1): default inference is the cost we pay, and it dwarfs storage,
   * so a flat-priced tenant left uncapped can go negative. BYOK turns (the tenant's own
   * Anthropic/Maritaca key) cost us ~nothing and are NOT counted against this cap.
   */
  readonly maxTurnsPerCycle: number;
}

/** Generous open-tier defaults — a guard against runaway abuse, not a billing limit. */
export const DEFAULT_ABUSE_CONFIG: AbuseConfig = {
  maxMemoriesPerNamespace: 50_000,
  maxNamespacesPerTenant: 1_000,
  // Runaway backstop only — well above the top paid plan's cap, so plan-gating is the
  // binding limit whenever it's on; abuse-guards-alone just stops an unbounded free run.
  maxTurnsPerCycle: 100_000,
};

function positiveIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve the config from env overrides, falling back to the open-tier defaults. */
export function parseAbuseConfig(env: Pick<Env, "MAX_MEMORIES_PER_NAMESPACE" | "MAX_NAMESPACES_PER_TENANT" | "MAX_TURNS_PER_CYCLE">): AbuseConfig {
  return {
    maxMemoriesPerNamespace: positiveIntOr(env.MAX_MEMORIES_PER_NAMESPACE, DEFAULT_ABUSE_CONFIG.maxMemoriesPerNamespace),
    maxNamespacesPerTenant: positiveIntOr(env.MAX_NAMESPACES_PER_TENANT, DEFAULT_ABUSE_CONFIG.maxNamespacesPerTenant),
    maxTurnsPerCycle: positiveIntOr(env.MAX_TURNS_PER_CYCLE, DEFAULT_ABUSE_CONFIG.maxTurnsPerCycle),
  };
}

/**
 * Start (UTC ms) of the calendar-month billing cycle containing `now`. The turn cap is
 * counted from this anchor, so a tenant's default-inference budget resets on the 1st.
 */
export function cycleStartUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * Refuse another default-inference turn once the tenant is at its per-cycle cap (403).
 * The message points at BYOK (uncapped) and upgrading — a soft, actionable ceiling, not
 * a dead end. BYOK turns never reach here (the caller skips the check for them).
 */
export function assertTurnQuota(currentCount: number, config: AbuseConfig): void {
  if (currentCount >= config.maxTurnsPerCycle) {
    throw new QuotaExceeded(
      `monthly turn quota exceeded (max ${String(config.maxTurnsPerCycle)} default-inference turns) — bring your own Anthropic/Maritaca key (BYOK) for uncapped turns, or upgrade your plan`,
    );
  }
}

/** Refuse a new memory write once the namespace is at its cap (403 quota_exceeded). */
export function assertMemoryQuota(currentCount: number, config: AbuseConfig): void {
  if (currentCount >= config.maxMemoriesPerNamespace) {
    throw new QuotaExceeded(`namespace memory quota exceeded (max ${String(config.maxMemoriesPerNamespace)})`);
  }
}

/** Refuse a new namespace once the tenant is at its cap (403 quota_exceeded). */
export function assertNamespaceQuota(currentCount: number, config: AbuseConfig): void {
  if (currentCount >= config.maxNamespacesPerTenant) {
    throw new QuotaExceeded(`tenant namespace quota exceeded (max ${String(config.maxNamespacesPerTenant)})`);
  }
}
