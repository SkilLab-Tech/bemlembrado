import { describe, expect, it } from "vitest";
import type { UsageEventRow } from "../../src/db/client";
import { summarizeUsage } from "../../src/usage/aggregate";

function row(p: Partial<UsageEventRow>): UsageEventRow {
  return {
    id: "u",
    tenant_id: "t1",
    session_id: null,
    turn: null,
    tokens_fresh: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    provider: "anthropic",
    model: null,
    cost_usd: null,
    created_at: 1,
    ...p,
  };
}

describe("summarizeUsage", () => {
  it("sums the token splits and computes the savings ratio when cache is reported", () => {
    const s = summarizeUsage([
      row({ tokens_fresh: 100, tokens_cache_write: 2000 }), // turn 1: cold (writes cache)
      row({ tokens_fresh: 100, tokens_cache_read: 2000 }), // turn 2: warm (reads cache)
    ]);
    expect(s.turns).toBe(2);
    expect(s.tokensFresh).toBe(200);
    expect(s.tokensCacheRead).toBe(2000);
    expect(s.tokensCacheWrite).toBe(2000);
    expect(s.savingsRatio).toBeCloseTo(2000 / (2000 + 200), 6);
  });

  it("savingsRatio is honest-null when NO turn reported cache (Workers AI / Maritaca)", () => {
    const s = summarizeUsage([row({ provider: "workers-ai", tokens_fresh: 70 }), row({ provider: "workers-ai", tokens_fresh: 50 })]);
    expect(s.tokensFresh).toBe(120);
    expect(s.savingsRatio).toBeNull();
  });

  it("sums cost only across rows that have it", () => {
    expect(summarizeUsage([row({ cost_usd: 0.01 }), row({ cost_usd: null }), row({ cost_usd: 0.02 })]).costUsd).toBeCloseTo(0.03, 6);
    expect(summarizeUsage([row({ cost_usd: null })]).costUsd).toBeNull();
  });

  it("empty -> zeros + null ratio", () => {
    expect(summarizeUsage([])).toStrictEqual({ turns: 0, tokensFresh: 0, tokensCacheRead: 0, tokensCacheWrite: 0, savingsRatio: null, costUsd: null });
  });
});
