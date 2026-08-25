import { beforeEach, describe, expect, it } from "vitest";
import type { VectorizeLike } from "../../src/memory/vector-index";
import { addMemory } from "../../src/memory/add";
import { fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";

const noMatches = { matches: [], count: 0 } as VectorizeMatches;

describe("addMemory write order (mig 0021 — D1-first)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "agent-a");
  });

  it("writes the D1 row (vector_ok=0) BEFORE the vector, so a failed upsert leaves NO orphan vector", async () => {
    const failing: VectorizeLike = {
      upsert: () => Promise.reject(new Error("vectorize down")),
      query: () => Promise.resolve(noMatches),
    };
    const deps = { db: db(), ai: fakeAi(), vectorize: failing };
    await expect(
      addMemory(deps, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "x", now: 1, id: "m1" }),
    ).rejects.toThrow();
    // The D1 row exists but is unconfirmed (vector_ok=0). No orphan VECTOR was ever written,
    // and the row is invisible to search — there is no vector to produce a hit to hydrate.
    const row = await db().getMemoryById("n1", "m1");
    expect(row).not.toBeNull();
    expect(row?.vector_ok).toBe(0);
  });

  it("confirms vector_ok=1 after a successful upsert", async () => {
    const ok: VectorizeLike = {
      upsert: (v) => Promise.resolve({ count: v.length }),
      query: () => Promise.resolve(noMatches),
    };
    const deps = { db: db(), ai: fakeAi(), vectorize: ok };
    await addMemory(deps, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "x", now: 1, id: "m1" });
    const row = await db().getMemoryById("n1", "m1");
    expect(row?.vector_ok).toBe(1);
  });
});
