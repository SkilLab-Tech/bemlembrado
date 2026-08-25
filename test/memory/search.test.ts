import { beforeEach, describe, expect, it } from "vitest";
import { NotFound } from "../../src/http/errors";
import type { VectorizeLike } from "../../src/memory/vector-index";
import { addMemory } from "../../src/memory/add";
import { searchMemory, searchMemoryResult } from "../../src/memory/search";
import { fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";

/** Vectorize fake that records the queried topK and ranks matches by insertion order. */
function recordingVectorize() {
  const store: VectorizeVector[] = [];
  let lastTopK = -1;
  const vectorize: VectorizeLike = {
    upsert(vectors) {
      store.push(...vectors);
      return Promise.resolve({ count: vectors.length });
    },
    query(_vector, options) {
      lastTopK = options?.topK ?? -1;
      const ns = options?.namespace;
      const matches = store
        .filter((v) => v.namespace === ns)
        .slice(0, options?.topK ?? 5)
        .map((v, i) => ({ id: v.id, score: 1 - i * 0.1, namespace: v.namespace }));
      return Promise.resolve({ matches, count: matches.length } as VectorizeMatches);
    },
  };
  return { vectorize, lastTopK: () => lastTopK };
}

describe("searchMemory", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("n1", "t1", "agent-a");
    await seedNamespace("n2", "t1", "agent-b");
  });

  it("returns hits hydrated with D1 text, preserving Vectorize rank order", async () => {
    const { vectorize } = recordingVectorize();
    const deps = { db: db(), ai: fakeAi(), vectorize };
    await addMemory(deps, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "first", now: 1, id: "m1" });
    await addMemory(deps, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "second", now: 2, id: "m2" });
    const hits = await searchMemory(deps, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", query: "q" });
    expect(hits.map((h) => h.id)).toStrictEqual(["m1", "m2"]);
    expect(hits[0]?.text).toBe("first");
    expect((hits[0]?.score ?? 0) >= (hits[1]?.score ?? 0)).toBe(true);
  });

  it("drops orphan hits — a vector with no D1 row never surfaces as a null-text hit (mig 0021)", async () => {
    const { vectorize } = recordingVectorize();
    const deps = { db: db(), ai: fakeAi(), vectorize };
    await addMemory(deps, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "real", now: 1, id: "m1" });
    // Simulate a pre-0021 orphan: a vector in the index whose D1 row was never written.
    await vectorize.upsert([{ id: "orphan", namespace: "n1", values: [0.1, 0.2, 0.3] }]);
    const hits = await searchMemory(deps, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", query: "q" });
    expect(hits.map((h) => h.id)).toStrictEqual(["m1"]); // orphan dropped — no slot-consuming null hit
  });

  it("searchMemoryResult reports honest counts — a dropped orphan shows as dropped>0, not silence (B2)", async () => {
    const { vectorize } = recordingVectorize();
    const deps = { db: db(), ai: fakeAi(), vectorize };
    await addMemory(deps, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "real", now: 1, id: "m1" });
    await vectorize.upsert([{ id: "orphan", namespace: "n1", values: [0.1, 0.2, 0.3] }]);
    const res = await searchMemoryResult(deps, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", query: "q", topK: 5 });
    expect(res.requested).toBe(5);
    expect(res.returned).toBe(1); // == hits.length
    expect(res.dropped).toBe(1); // the orphan was dropped — thinning is visible, not silent
    expect(res.hits.map((h) => h.id)).toStrictEqual(["m1"]);
  });

  it("returns only the queried namespace's memories (isolation)", async () => {
    const { vectorize } = recordingVectorize();
    const deps = { db: db(), ai: fakeAi(), vectorize };
    await addMemory(deps, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "in-a", now: 1, id: "a1" });
    await addMemory(deps, { allowConfidential: false, tenantId: "t1", namespace: "agent-b", text: "in-b", now: 1, id: "b1" });
    const hits = await searchMemory(deps, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", query: "q" });
    expect(hits.map((h) => h.id)).toStrictEqual(["a1"]);
  });

  it("clamps topK to the 50 maximum", async () => {
    const rec = recordingVectorize();
    const deps = { db: db(), ai: fakeAi(), vectorize: rec.vectorize };
    await searchMemory(deps, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", query: "q", topK: 100 });
    expect(rec.lastTopK()).toBe(50);
  });

  it("uses a default topK when none is given", async () => {
    const rec = recordingVectorize();
    const deps = { db: db(), ai: fakeAi(), vectorize: rec.vectorize };
    await searchMemory(deps, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", query: "q" });
    expect(rec.lastTopK()).toBe(10);
  });

  it("hydration is namespace-scoped (empty when nothing stored)", async () => {
    const { vectorize } = recordingVectorize();
    const deps = { db: db(), ai: fakeAi(), vectorize };
    expect(await searchMemory(deps, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", query: "q" })).toStrictEqual([]);
  });

  it("rejects a cross-tenant namespace with NotFound", async () => {
    const { vectorize } = recordingVectorize();
    const deps = { db: db(), ai: fakeAi(), vectorize };
    await expect(searchMemory(deps, { allowConfidential: false, tenantId: "t2", namespace: "agent-a", query: "q" })).rejects.toBeInstanceOf(NotFound);
  });
});
