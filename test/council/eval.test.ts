import { describe, expect, it } from "vitest";
import { type CouncilModel } from "../../src/council/consolidate";
import { GOLDEN_CASES, runCouncilEval, scoreOutput } from "../../src/council/eval";

/**
 * Simulated models: the council CONSOLIDATES (retains existing + incoming) while
 * single-pass keeps only the incoming write. This models the real failure mode
 * (naive overwrite drops still-valid facts). Real-model numbers come post-F3.
 */
function mergeModel(id: string): CouncilModel {
  return {
    id,
    complete: (prompt: string) => {
      if (prompt.includes("JSON array of labels")) return Promise.resolve('["A","B"]');
      if (prompt.includes("### Rank 1")) {
        // chairman: echo the top-ranked candidate body.
        const top = /### Rank 1 \([A-Z]\)\n([\s\S]*?)(?:\n\n###|$)/.exec(prompt)?.[1]?.trim() ?? "";
        return Promise.resolve(top);
      }
      // member first-opinion: merge the prompt's Existing + New sections.
      const existing = /## Existing note\n([\s\S]*?)\n\n/.exec(prompt)?.[1]?.trim() ?? "";
      const incoming = /<<<\n([\s\S]*?)\n>>>/.exec(prompt)?.[1]?.trim() ?? "";
      const merged = existing !== "" && existing !== "(none)" ? `${existing} ${incoming}` : incoming;
      return Promise.resolve(merged);
    },
  };
}

describe("scoreOutput", () => {
  it("scores the fraction of expected tokens present", () => {
    expect(scoreOutput("has pro-plan and email", ["pro-plan", "email"])).toBe(1);
    expect(scoreOutput("only email", ["pro-plan", "email"])).toBe(0.5);
  });
});

describe("runCouncilEval (golden set)", () => {
  it("has at least 5 golden cases", () => {
    expect(GOLDEN_CASES.length).toBeGreaterThanOrEqual(5);
  });

  it("council shows a measurable quality delta over single-pass (simulated models)", async () => {
    const report = await runCouncilEval({ members: [mergeModel("m1"), mergeModel("m2")], chairman: mergeModel("chair") });
    expect(report.cases.length).toBe(GOLDEN_CASES.length);
    // Council never scores worse, and beats single-pass on the retention cases.
    for (const c of report.cases) expect(c.council).toBeGreaterThanOrEqual(c.singlePass);
    expect(report.delta).toBeGreaterThan(0);
    expect(report.verdict).toContain("council +");
  });
});
