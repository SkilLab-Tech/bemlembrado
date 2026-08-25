import type { Db } from "../db/client";
import type { NormalizedUsage } from "../inference/usage";
import { createLogger } from "../obs/log";

/**
 * Usage recording (turn-batch). One USAGE_EVENT row per turn carrying the token
 * split from `normalizeUsage`. Best-effort: a failed write never breaks the turn
 * the caller already completed (telemetry must not 500 a successful response).
 *
 * cost_usd is computed ONLY when explicit per-model rates are supplied — we do not
 * hardcode (and risk staling) provider prices. The headline metric is the token
 * SAVINGS ratio (cacheRead vs fresh), which needs no price.
 */

/** USD per 1M tokens. Cache-read is billed ~0.1x and cache-write ~1.25x of the input rate. */
export interface TokenRates {
  perMTokInput: number;
  perMTokOutput: number;
}

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

/** Estimate USD cost from a normalized usage + explicit rates. null when no rates given. */
export function estimateCostUsd(usage: NormalizedUsage, rates?: TokenRates): number | null {
  if (rates === undefined) return null;
  const perTokIn = rates.perMTokInput / 1_000_000;
  const perTokOut = rates.perMTokOutput / 1_000_000;
  // `fresh` lumps input+output; bill it at the (higher) output rate as a conservative ceiling.
  const fresh = usage.fresh * perTokOut;
  const read = usage.cacheRead * perTokIn * CACHE_READ_MULT;
  const write = usage.cacheWrite * perTokIn * CACHE_WRITE_MULT;
  return Math.round((fresh + read + write) * 1_000_000) / 1_000_000;
}

export interface RecordUsageInput {
  tenantId: string;
  sessionId?: string;
  turn?: number;
  usage: NormalizedUsage;
  rates?: TokenRates;
}

/** Record a turn's usage. Best-effort — swallows its own errors (logs a warning). */
export async function recordUsage(db: Db, input: RecordUsageInput, now: number): Promise<void> {
  try {
    await db.insertUsageEvent({
      id: crypto.randomUUID(),
      tenant_id: input.tenantId,
      session_id: input.sessionId ?? null,
      turn: input.turn ?? null,
      tokens_fresh: input.usage.fresh,
      tokens_cache_read: input.usage.cacheRead,
      tokens_cache_write: input.usage.cacheWrite,
      provider: input.usage.provider,
      model: input.usage.model,
      cost_usd: estimateCostUsd(input.usage, input.rates),
      created_at: now,
    });
  } catch (err) {
    createLogger().log("warn", "usage record failed (best-effort; turn unaffected)", {
      provider: input.usage.provider,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
