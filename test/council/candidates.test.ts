import { describe, expect, it } from "vitest";
import { type CandidateMemory, jaccard, selectConsolidationCandidate, tokenize } from "../../src/council/candidates";

describe("tokenize", () => {
  it("lowercases, strips accents, drops stopwords + short tokens", () => {
    const tokens = tokenize("Ana prefere PIX para São Paulo");
    expect(tokens.has("ana")).toBe(true);
    expect(tokens.has("prefere")).toBe(true);
    expect(tokens.has("pix")).toBe(true);
    expect(tokens.has("sao")).toBe(true); // accent stripped
    expect(tokens.has("paulo")).toBe(true);
    expect(tokens.has("para")).toBe(false); // stopword
  });

  it("returns an empty set for punctuation-only text", () => {
    expect(tokenize("!!! ... ??").size).toBe(0);
  });
});

describe("jaccard", () => {
  it("is 1 for identical sets and 0 for disjoint", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  it("is empty-safe", () => {
    expect(jaccard(new Set(), new Set(["a"]))).toBe(0);
    expect(jaccard(new Set(["a"]), new Set())).toBe(0);
  });

  it("computes intersection over union", () => {
    // {a,b,c} vs {b,c,d}: ∩=2, ∪=4 → 0.5
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBe(0.5);
  });
});

describe("selectConsolidationCandidate", () => {
  const mem = (id: string, text: string): CandidateMemory => ({ id, text });

  it("flags a near-duplicate write as contested and picks it", () => {
    const target = mem("m1", "Ana is on the pro-plan subscription tier");
    const sel = selectConsolidationCandidate("Ana subscription is the pro-plan tier", [target]);
    expect(sel.contested).toBe(true);
    expect(sel.targetId).toBe("m1");
    expect(sel.existing).toBe(target.text);
    expect(sel.score).toBeGreaterThanOrEqual(0.2);
  });

  it("does not flag an unrelated write", () => {
    const existing = [mem("m1", "Ana lives in São Paulo near the office")];
    const sel = selectConsolidationCandidate("Bruno deadline project ships Friday", existing);
    expect(sel.contested).toBe(false);
    expect(sel.targetId).toBeNull();
    expect(sel.existing).toBeNull();
    expect(sel.score).toBe(0);
  });

  it("returns not-contested for an empty namespace", () => {
    expect(selectConsolidationCandidate("anything at all", []).contested).toBe(false);
  });

  it("returns not-contested when incoming has no meaningful tokens", () => {
    const existing = [mem("m1", "Ana prefers email contact for billing")];
    expect(selectConsolidationCandidate("!!! ...", existing).contested).toBe(false);
  });

  it("picks the highest-overlap candidate among several", () => {
    const existing = [
      mem("m1", "Bruno enjoys hiking on weekends"),
      mem("m2", "Ana prefers PIX payment for the pro-plan billing"),
      mem("m3", "Weather in Rio is warm today"),
    ];
    const sel = selectConsolidationCandidate("Ana pro-plan billing prefers PIX payment", existing);
    expect(sel.targetId).toBe("m2");
  });

  it("resolves ties to the earliest candidate (deterministic)", () => {
    const existing = [mem("a", "shared alpha beta gamma"), mem("b", "shared alpha beta gamma")];
    const sel = selectConsolidationCandidate("shared alpha beta gamma", existing);
    expect(sel.targetId).toBe("a");
  });

  it("respects maxCandidates (ignores memories past the cap)", () => {
    const existing = [
      mem("recent", "totally unrelated content here"),
      mem("old", "Ana pro-plan billing prefers PIX payment"),
    ];
    const sel = selectConsolidationCandidate("Ana pro-plan billing prefers PIX payment", existing, {
      maxCandidates: 1,
    });
    expect(sel.contested).toBe(false); // "old" is past the cap
  });

  it("honors a custom threshold", () => {
    const existing = [mem("m1", "Ana pro-plan tier active now")];
    // moderate overlap: contested under a low threshold, not under a high one
    const low = selectConsolidationCandidate("Ana tier upgraded", existing, { threshold: 0.05 });
    const high = selectConsolidationCandidate("Ana tier upgraded", existing, { threshold: 0.9 });
    expect(low.contested).toBe(true);
    expect(high.contested).toBe(false);
  });
});
