import { describe, expect, it } from "vitest";
import {
  type CouncilModel,
  consolidate,
  DEFAULT_COUNCIL_CONFIG,
  parseRanking,
} from "../../src/council/consolidate";
import { type Note, parseNote, serializeNote } from "../../src/vault/store";
import { createLogger } from "../../src/obs/log";

function member(id: string, opinion: string, ranking: string): CouncilModel {
  return {
    id,
    complete: (prompt: string) => Promise.resolve(prompt.includes("JSON array of labels") ? ranking : opinion),
  };
}
const chairman: CouncilModel = { id: "chair", complete: () => Promise.resolve("  Ana is on the pro plan (upgraded).  ") };

const input = { topic: "ana", existing: "Ana is on the free plan.", incoming: "Ana upgraded to pro.", contested: true };

describe("parseRanking", () => {
  it("extracts known labels in order, ignoring noise", () => {
    expect(parseRanking('["B","A","C"]', ["A", "B", "C"])).toStrictEqual(["B", "A", "C"]);
    expect(parseRanking("best is B then A", ["A", "B"])).toStrictEqual(["B", "A"]);
    expect(parseRanking("zzz none", ["A", "B"])).toStrictEqual([]); // no A/B letters present
  });
});

describe("consolidate (council gate)", () => {
  it("is single-pass when the flag is OFF — no model calls, no spend (default)", async () => {
    const res = await consolidate(
      { config: DEFAULT_COUNCIL_CONFIG, members: [member("m1", "x", "[]")], chairman },
      input,
    );
    expect(res.consolidatedBy).toBe("single-pass");
    expect(res.cost.calls).toBe(0);
    expect(res.body).toBe("Ana upgraded to pro.");
  });

  it("is single-pass when not contested, even with the flag ON", async () => {
    const res = await consolidate(
      { config: { enabled: true }, members: [member("m1", "x", "[]")], chairman },
      { ...input, contested: false },
    );
    expect(res.consolidatedBy).toBe("single-pass");
    expect(res.cost.calls).toBe(0);
  });

  it("runs the 3-stage council when ON + contested; chairman writes the note; cost logged", async () => {
    const lines: string[] = [];
    const res = await consolidate(
      {
        config: { enabled: true },
        members: [member("m1", "Ana is on the pro plan.", '["A","B"]'), member("m2", "Ana upgraded to pro.", '["A","B"]')],
        chairman,
        logger: createLogger((l) => lines.push(l)),
        costPerCallUsd: 0.01,
      },
      input,
    );
    expect(res.consolidatedBy).toBe("council");
    expect(res.body).toBe("Ana is on the pro plan (upgraded)."); // trimmed chairman output
    expect(res.cost.calls).toBe(2 * 2 + 1); // N opinions + N rankings + chairman
    expect(res.cost.estUsd).toBeCloseTo(0.05);
    expect(lines.some((l) => l.includes("council run"))).toBe(true);
  });

  it("falls back to single-pass with zero members", async () => {
    const res = await consolidate({ config: { enabled: true }, members: [], chairman }, input);
    expect(res.consolidatedBy).toBe("single-pass");
  });
});

describe("consolidated_by provenance tag", () => {
  it("round-trips through the note frontmatter codec", () => {
    const n: Note = {
      slug: "ana",
      frontmatter: { id: "n1:ana", type: "fact", created_at: 1, updated_at: 2, links: ["ana-plan"], consolidated_by: "council" },
      body: "Ana is on the pro plan. See [[ana-plan]].",
    };
    expect(parseNote("ana", serializeNote(n))).toStrictEqual(n);
  });
});
