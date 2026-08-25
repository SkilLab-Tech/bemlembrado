import { beforeEach, describe, expect, it } from "vitest";
import { addMemory } from "../../src/memory/add";
import { NotFound } from "../../src/http/errors";
import { captureVectorize, fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";

async function seedNs() {
  await seedTenant("t1");
  await seedNamespace("n1", "t1", "agent-a");
}

describe("addMemory", () => {
  beforeEach(async () => {
    await resetDb();
    await seedNs();
  });

  it("returns an id", async () => {
    const { vectorize } = captureVectorize();
    const res = await addMemory({ db: db(), ai: fakeAi(), vectorize }, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "the user prefers PIX", now: 1 });
    expect(res.id).toBeTypeOf("string");
  });

  it("writes the D1 row in the resolved namespace", async () => {
    const { vectorize } = captureVectorize();
    const { id } = await addMemory({ db: db(), ai: fakeAi(), vectorize }, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "hello", now: 5 });
    const rows = await db().listMemoriesByNamespace("n1");
    expect(rows.map((r) => r.id)).toStrictEqual([id]);
    expect(rows[0]?.text).toBe("hello");
  });

  it("upserts a namespaced vector to Vectorize", async () => {
    const { vectorize, store } = captureVectorize();
    const { id } = await addMemory({ db: db(), ai: fakeAi([0.7, 0.8]), vectorize }, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "x", now: 1 });
    expect(store).toHaveLength(1);
    expect(store[0]?.id).toBe(id);
    expect(store[0]?.namespace).toBe("n1");
    expect(store[0]?.values).toStrictEqual([0.7, 0.8]);
  });

  it("links vector_id to the row id (for delete cascade)", async () => {
    const { vectorize } = captureVectorize();
    const { id } = await addMemory({ db: db(), ai: fakeAi(), vectorize }, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "x", now: 1 });
    const rows = await db().listMemoriesByNamespace("n1");
    expect(rows[0]?.vector_id).toBe(id);
  });

  it("rejects a cross-tenant namespace before writing", async () => {
    const { vectorize, store } = captureVectorize();
    await expect(
      addMemory({ db: db(), ai: fakeAi(), vectorize }, { allowConfidential: false, tenantId: "t2", namespace: "agent-a", text: "x", now: 1 }),
    ).rejects.toBeInstanceOf(NotFound);
    expect(store).toHaveLength(0);
  });

  it("stores metadata as JSON", async () => {
    const { vectorize } = captureVectorize();
    await addMemory({ db: db(), ai: fakeAi(), vectorize }, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "x", metadata: { source: "chat" }, now: 1 });
    const rows = await db().listMemoriesByNamespace("n1");
    expect(JSON.parse(rows[0]?.metadata_json ?? "{}")).toStrictEqual({ source: "chat" });
  });
});
