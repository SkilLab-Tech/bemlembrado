import { beforeEach, describe, expect, it } from "vitest";
import { Db } from "../../src/db/client";
import type { NormalizedUsage } from "../../src/inference/usage";
import { estimateCostUsd, recordUsage } from "../../src/usage/record";
import { db, resetDb, seedTenant } from "../helpers/fixtures";

const ANTH: NormalizedUsage = { provider: "anthropic", model: "claude-opus-4-8", fresh: 140, cacheRead: 8000, cacheWrite: 2000, cacheReported: true };
const WAI: NormalizedUsage = { provider: "workers-ai", model: "llama", fresh: 70, cacheRead: 0, cacheWrite: 0, cacheReported: false };

describe("estimateCostUsd", () => {
  it("returns null without rates (we never fabricate provider prices)", () => {
    expect(estimateCostUsd(ANTH)).toBeNull();
  });

  it("bills cache-read at 0.1x and cache-write at 1.25x of the input rate", () => {
    // input $1/MTok, output $2/MTok: fresh 140*2e-6 + read 8000*0.1e-6 + write 2000*1.25e-6
    const c = estimateCostUsd(ANTH, { perMTokInput: 1, perMTokOutput: 2});
    expect(c).toBeCloseTo(140 * 2e-6 + 8000 * 0.1e-6 + 2000 * 1.25e-6, 9);
  });
});

describe("recordUsage", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
  });

  it("writes one USAGE_EVENT row with the token split", async () => {
    await recordUsage(db(), { tenantId: "t1", sessionId: "s1", turn: 1, usage: ANTH }, 100);
    const rows = await db().listUsageEventsByTenant("t1");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      tokens_fresh: 140,
      tokens_cache_read: 8000,
      tokens_cache_write: 2000,
      provider: "anthropic",
      cost_usd: null,
    });
  });

  it("is best-effort: a failing insert never throws", async () => {
    const brokenDb = new Db({ prepare() { throw new Error("d1 down"); } } as unknown as D1Database);
    await expect(recordUsage(brokenDb, { tenantId: "t1", usage: WAI }, 1)).resolves.toBeUndefined();
    expect((await db().listUsageEventsByTenant("t1")).length).toBe(0);
  });
});
