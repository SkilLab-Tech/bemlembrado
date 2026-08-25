import type { UsageEventRow } from "../db/client";

/**
 * Usage aggregation + the savings metric (turn-batch, roadmap #95). The product
 * thesis ("cut your token bill") is measurable only when a provider reports cache
 * accounting (Anthropic). So `savingsRatio` is HONEST-NULL when no turn ever
 * reported cache tokens — we never invent a savings number from providers that
 * don't expose one (Workers AI / Maritaca).
 */

export interface UsageSummary {
  turns: number;
  tokensFresh: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  /**
   * Share of (fresh + cache-read) tokens served from cache: cacheRead / (cacheRead + fresh).
   * null when no turn reported cache accounting. Note: `fresh` lumps input+output, so
   * this is a conservative (under-stated) view of input-cache reuse.
   */
  savingsRatio: number | null;
  costUsd: number | null;
}

/** Anthropic ephemeral prompt-cache TTL. A turn gap past this evicts the cached prefix. */
export const CACHE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Count turns whose gap from the previous turn exceeds the cache window — the
 * cached prefix had likely expired, so that turn re-paid the cache-write instead of
 * reading. Explains a lower-than-expected savings ratio. Expects ONE session's rows.
 */
export function outOfWindowTurns(rows: readonly UsageEventRow[], windowMs = CACHE_WINDOW_MS): number {
  let count = 0;
  let prev: number | null = null;
  for (const r of [...rows].sort((a, b) => a.created_at - b.created_at)) {
    if (prev !== null && r.created_at - prev > windowMs) count++;
    prev = r.created_at;
  }
  return count;
}

export function summarizeUsage(rows: readonly UsageEventRow[]): UsageSummary {
  let tokensFresh = 0;
  let tokensCacheRead = 0;
  let tokensCacheWrite = 0;
  let costUsd: number | null = null;
  let anyCacheReported = false;

  for (const r of rows) {
    tokensFresh += r.tokens_fresh ?? 0;
    tokensCacheRead += r.tokens_cache_read ?? 0;
    tokensCacheWrite += r.tokens_cache_write ?? 0;
    if ((r.tokens_cache_read ?? 0) > 0 || (r.tokens_cache_write ?? 0) > 0) anyCacheReported = true;
    if (r.cost_usd !== null) costUsd = (costUsd ?? 0) + r.cost_usd;
  }

  const denom = tokensCacheRead + tokensFresh;
  return {
    turns: rows.length,
    tokensFresh,
    tokensCacheRead,
    tokensCacheWrite,
    savingsRatio: anyCacheReported && denom > 0 ? tokensCacheRead / denom : null,
    costUsd,
  };
}
