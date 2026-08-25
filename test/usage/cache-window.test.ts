import { describe, expect, it } from "vitest";
import type { UsageEventRow } from "../../src/db/client";
import { CACHE_WINDOW_MS, outOfWindowTurns } from "../../src/usage/aggregate";

function at(ms: number): UsageEventRow {
  return { id: "u", tenant_id: "t1", session_id: "s", turn: null, tokens_fresh: 1, tokens_cache_read: 0, tokens_cache_write: 0, provider: "anthropic", model: null, cost_usd: null, created_at: ms };
}

describe("outOfWindowTurns", () => {
  it("counts gaps that exceed the 5-min cache window", () => {
    const rows = [at(0), at(60_000), at(120_000), at(120_000 + CACHE_WINDOW_MS + 1), at(120_000 + CACHE_WINDOW_MS + 2)];
    // one gap (#3 -> #4) exceeds the window; the others are within it
    expect(outOfWindowTurns(rows)).toBe(1);
  });

  it("zero when every turn is within the window", () => {
    expect(outOfWindowTurns([at(0), at(1000), at(2000)])).toBe(0);
  });

  it("orders by timestamp before measuring gaps", () => {
    // given out of order; sorted = [0, 10000, 400000] -> the 10000->400000 gap (390s) exceeds the window
    expect(outOfWindowTurns([at(0), at(400_000), at(10_000)])).toBe(1);
  });

  it("empty / single -> 0", () => {
    expect(outOfWindowTurns([])).toBe(0);
    expect(outOfWindowTurns([at(0)])).toBe(0);
  });
});
