import { describe, expect, it } from "vitest";
import {
  GOLDEN_RETRIEVAL_CASES,
  precisionAtK,
  recall,
  reciprocalRank,
  type Retriever,
  runRetrievalEval,
} from "../../src/eval/retrieval";

describe("IR metrics", () => {
  it("precisionAtK counts relevant in the top-k over k", () => {
    expect(precisionAtK(["a", "b", "c"], ["a", "c"], 3)).toBeCloseTo(2 / 3);
    expect(precisionAtK(["a", "b"], ["a"], 1)).toBe(1); // only top-1 considered
    expect(precisionAtK(["x", "y"], ["a"], 2)).toBe(0);
    expect(precisionAtK(["a"], ["a"], 0)).toBe(0); // k=0 guard
  });

  it("recall counts relevant found anywhere in the ranking", () => {
    expect(recall(["a", "b", "c"], ["a", "c"])).toBe(1);
    expect(recall(["a", "b"], ["a", "z"])).toBe(0.5);
    expect(recall([], [])).toBe(1); // no relevant → trivially satisfied
  });

  it("reciprocalRank is 1/(rank of first relevant)", () => {
    expect(reciprocalRank(["a", "b"], ["a"])).toBe(1);
    expect(reciprocalRank(["x", "a"], ["a"])).toBe(0.5);
    expect(reciprocalRank(["x", "y"], ["a"])).toBe(0);
  });
});

describe("golden set", () => {
  it("has at least 5 cases, each with a corpus and ground truth", () => {
    expect(GOLDEN_RETRIEVAL_CASES.length).toBeGreaterThanOrEqual(5);
    for (const c of GOLDEN_RETRIEVAL_CASES) {
      expect(c.corpus.length).toBeGreaterThan(0);
      expect(c.relevantIds.length).toBeGreaterThan(0);
      // ground-truth ids must exist in the corpus
      const ids = new Set(c.corpus.map((m) => m.id));
      for (const rid of c.relevantIds) expect(ids.has(rid)).toBe(true);
    }
  });
});

describe("runRetrievalEval", () => {
  it("scores a perfect retriever at 1.0 across MRR + recall", async () => {
    // Perfect retriever: returns exactly the relevant ids, best first.
    const perfect: Retriever = (ns, _q, _k) => {
      const c = GOLDEN_RETRIEVAL_CASES.find((x) => x.namespace === ns);
      return Promise.resolve(c ? [...c.relevantIds] : []);
    };
    const report = await runRetrievalEval(perfect);
    expect(report.mrr).toBe(1);
    expect(report.meanRecall).toBe(1);
    expect(report.cases).toHaveLength(GOLDEN_RETRIEVAL_CASES.length);
  });

  it("scores an empty retriever at 0 (mrr + precision)", async () => {
    const empty: Retriever = () => Promise.resolve([]);
    const report = await runRetrievalEval(empty);
    expect(report.mrr).toBe(0);
    expect(report.meanPrecisionAtK).toBe(0);
  });

  it("honors a custom k", async () => {
    const one: Retriever = (ns) => {
      const c = GOLDEN_RETRIEVAL_CASES.find((x) => x.namespace === ns);
      const first = c?.corpus[0];
      return Promise.resolve(first ? [first.id] : []);
    };
    const report = await runRetrievalEval(one, GOLDEN_RETRIEVAL_CASES, 3);
    expect(report.k).toBe(3);
  });

  it("precision@k penalizes an indiscriminate retriever where recall/MRR do not (selectivity)", async () => {
    const selectivity = GOLDEN_RETRIEVAL_CASES.filter((c) => c.id === "selectivity-quota");
    expect(selectivity).toHaveLength(1); // the golden set carries a selectivity case
    // Returns the whole corpus, relevant id first: recalls the fact and ranks it #1,
    // but drags in 6 near-misses. Only precision@k exposes the lack of discrimination.
    const dumps: Retriever = (ns) => {
      const c = GOLDEN_RETRIEVAL_CASES.find((x) => x.namespace === ns);
      if (!c) return Promise.resolve([]);
      const relevant = c.relevantIds;
      const rest = c.corpus.map((m) => m.id).filter((id) => !relevant.includes(id));
      return Promise.resolve([...relevant, ...rest]);
    };
    const report = await runRetrievalEval(dumps, selectivity, 5);
    const score = report.cases[0];
    expect(score?.recall).toBe(1); // fact retrieved
    expect(score?.reciprocalRank).toBe(1); // and ranked first
    expect(score?.precisionAtK).toBeCloseTo(1 / 5); // 1 relevant of 5 → discrimination is poor
  });
});
