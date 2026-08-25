import { beforeEach, describe, expect, it } from "vitest";
import type { NormalizedUsage } from "../../src/inference/usage";
import { summarizeUsage } from "../../src/usage/aggregate";
import { recordUsage } from "../../src/usage/record";
import { db, resetDb, seedTenant } from "../helpers/fixtures";

/**
 * Savings proof (turn-batch, roadmap #97). Replays a long session with Anthropic-shaped
 * cache usage through the REAL record -> store -> aggregate path and asserts the
 * headline savings number. The LIVE Anthropic run is gated on the key; this proves
 * the measurement pipeline produces the right number given cache-reporting usage.
 *
 * Model: turn 1 is cold (writes the prefix to cache); turns 2..30 are warm (read the
 * cached prefix). Cached input is billed ~0.1x, so a high cache-read share is a large
 * cost reduction (well past the >=1.5x target).
 */
describe("savings replay (30 turns, Anthropic-shaped cache)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
  });

  it("record -> store -> summarize yields a high cache-read share over a long session", async () => {
    const PREFIX = 5000; // cached prefix tokens
    const FRESH_PER_TURN = 120; // new user msg + reply each turn

    for (let turn = 1; turn <= 30; turn++) {
      const usage: NormalizedUsage =
        turn === 1
          ? { provider: "anthropic", model: "claude-haiku-4-5-20251001", fresh: FRESH_PER_TURN, cacheRead: 0, cacheWrite: PREFIX, cacheReported: true }
          : { provider: "anthropic", model: "claude-haiku-4-5-20251001", fresh: FRESH_PER_TURN, cacheRead: PREFIX, cacheWrite: 0, cacheReported: true };
      await recordUsage(db(), { tenantId: "t1", sessionId: "long", turn, usage }, turn);
    }

    const summary = summarizeUsage(await db().listUsageEventsByTenant("t1"));
    expect(summary.turns).toBe(30);
    expect(summary.tokensCacheRead).toBe(PREFIX * 29);
    expect(summary.tokensCacheWrite).toBe(PREFIX);
    expect(summary.savingsRatio).not.toBeNull();
    // 145000 cache-read / (145000 + 3600 fresh) ~= 0.976
    expect(summary.savingsRatio ?? 0).toBeGreaterThan(0.6);

    // Cost framing: cached reads billed 0.1x vs full input. With rates, the blended
    // input cost is a fraction of the no-cache baseline (>1.5x cheaper).
    const cachedCost = summary.tokensCacheRead * 0.1 + summary.tokensCacheWrite * 1.25 + summary.tokensFresh;
    const noCacheBaseline = (summary.tokensCacheRead + summary.tokensCacheWrite + summary.tokensFresh) * 1.0;
    expect(noCacheBaseline / cachedCost).toBeGreaterThan(1.5);
  });
});
