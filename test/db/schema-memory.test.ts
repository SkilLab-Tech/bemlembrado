import { beforeEach, describe, expect, it } from "vitest";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";

async function insertMem(id: string, namespaceId: string, dedupeKey: string | null) {
  await db().insertMemory({
    id,
    namespace_id: namespaceId,
    kind: "semantic",
    text: "x",
    vector_id: null,
    metadata_json: null,
    created_at: 1,
    ttl: null,
    dedupe_key: dedupeKey,
  });
}

describe("mig 0007 — MEMORY.dedupe_key", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "a");
    await seedNamespace("n2", "t1", "b");
  });

  it("persists a dedupe_key on a memory row", async () => {
    await insertMem("m1", "n1", "k1");
    const rows = await db().listMemoriesByNamespace("n1");
    expect(rows[0]?.dedupe_key).toBe("k1");
  });

  it("enforces UNIQUE(namespace_id, dedupe_key) for non-null keys", async () => {
    await insertMem("m1", "n1", "dup");
    await expect(insertMem("m2", "n1", "dup")).rejects.toThrow();
  });

  it("allows the same dedupe_key in a different namespace", async () => {
    await insertMem("m1", "n1", "dup");
    await expect(insertMem("m2", "n2", "dup")).resolves.toBeUndefined();
  });

  it("allows multiple NULL dedupe_key rows (partial index)", async () => {
    await insertMem("m1", "n1", null);
    await expect(insertMem("m2", "n1", null)).resolves.toBeUndefined();
  });
});
