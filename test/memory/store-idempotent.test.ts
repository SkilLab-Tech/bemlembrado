import { beforeEach, describe, expect, it } from "vitest";
import { addMemory } from "../../src/memory/add";
import { captureVectorize, fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";

async function add(dedupeKey: string | undefined, vectorize = captureVectorize().vectorize) {
  return addMemory(
    { db: db(), ai: fakeAi(), vectorize },
    { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "x", now: 1, ...(dedupeKey !== undefined ? { dedupeKey } : {}) },
  );
}

describe("addMemory idempotency", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "agent-a");
  });

  it("returns the same id for a repeated dedupeKey and stores only one row", async () => {
    const first = await add("k1");
    const second = await add("k1");
    expect(second.id).toBe(first.id);
    expect(await db().listMemoriesByNamespace("n1")).toHaveLength(1);
  });

  it("does not re-upsert the vector for a repeated dedupeKey", async () => {
    const { vectorize, store } = captureVectorize();
    await add("k1", vectorize);
    await add("k1", vectorize);
    expect(store).toHaveLength(1);
  });

  it("creates distinct rows for different dedupeKeys", async () => {
    await add("k1");
    await add("k2");
    expect(await db().listMemoriesByNamespace("n1")).toHaveLength(2);
  });

  it("without a dedupeKey, every call inserts", async () => {
    await add(undefined);
    await add(undefined);
    expect(await db().listMemoriesByNamespace("n1")).toHaveLength(2);
  });
});
