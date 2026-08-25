import { describe, expect, it } from "vitest";
import { clampMemories, DEFAULT_CONTEXT_CHAR_BUDGET } from "../../src/context/budget";

describe("clampMemories", () => {
  it("keeps memories in rank order until the char budget is hit, drops the rest", () => {
    const texts = ["a".repeat(100), "b".repeat(100), "c".repeat(100)];
    const { kept, dropped } = clampMemories(texts, { charBudget: 250 });
    expect(kept).toHaveLength(2); // 100 + 100 <= 250, third (300) exceeds
    expect(dropped).toBe(1);
  });

  it("respects the item cap", () => {
    const texts = Array.from({ length: 30 }, (_, i) => `m${String(i)}`);
    const { kept, dropped } = clampMemories(texts, { maxItems: 5 });
    expect(kept).toHaveLength(5);
    expect(dropped).toBe(25);
  });

  it("keeps everything when under budget", () => {
    const { kept, dropped } = clampMemories(["x", "y"]);
    expect(kept).toStrictEqual(["x", "y"]);
    expect(dropped).toBe(0);
  });

  it("has sane defaults", () => {
    const big = Array.from({ length: 100 }, () => "z".repeat(500));
    const { kept } = clampMemories(big);
    const totalChars = kept.reduce((n, t) => n + t.length, 0);
    expect(totalChars).toBeLessThanOrEqual(DEFAULT_CONTEXT_CHAR_BUDGET);
  });
});
