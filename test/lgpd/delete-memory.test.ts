import { beforeEach, describe, expect, it } from "vitest";
import { NotFound } from "../../src/http/errors";
import { Audit } from "../../src/lgpd/audit";
import { type DeleteVectorize, deleteMemory } from "../../src/lgpd/delete";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";

function fakeDeleteVectorize() {
  const deleted: string[] = [];
  const vectorize: DeleteVectorize = {
    deleteByIds(ids) {
      deleted.push(...ids);
      return Promise.resolve({ count: ids.length });
    },
  };
  return { vectorize, deleted };
}

const opts = (over: Partial<Parameters<typeof deleteMemory>[1]> = {}) => ({
  tenantId: "t1",
  actor: "key-abc",
  namespace: "agent-a",
  id: "m1",
  allowConfidential: false,
  ...over,
});

describe("deleteMemory (record-grain right-to-erasure)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("n1", "t1", "agent-a");
    await seedNamespace("n2", "t2", "agent-a");
    await db().insertMemory({ id: "m1", namespace_id: "n1", kind: "semantic", text: "x", vector_id: "vec-m1", metadata_json: null, created_at: 1, ttl: null });
  });

  it("erases the D1 row and the vector, and audits the deletion", async () => {
    const { vectorize, deleted } = fakeDeleteVectorize();
    const res = await deleteMemory({ db: db(), vectorize, audit: new Audit(db()) }, opts(), 100);
    expect(res).toStrictEqual({ deleted: true, id: "m1", vectorSkipped: false });
    expect(deleted).toStrictEqual(["vec-m1"]); // vector removed from the index
    expect(await db().getMemoryById("n1", "m1")).toBeNull(); // D1 row gone
  });

  it("404s for an unknown id (no existence oracle)", async () => {
    const { vectorize, deleted } = fakeDeleteVectorize();
    await expect(deleteMemory({ db: db(), vectorize, audit: new Audit(db()) }, opts({ id: "nope" }), 100)).rejects.toThrow(NotFound);
    expect(deleted).toStrictEqual([]); // nothing touched
  });

  it("404s for a cross-tenant memory (t1 cannot erase t2's row)", async () => {
    await db().insertMemory({ id: "m2", namespace_id: "n2", kind: "semantic", text: "y", vector_id: "vec-m2", metadata_json: null, created_at: 1, ttl: null });
    const { vectorize } = fakeDeleteVectorize();
    // t1 resolves its OWN agent-a (n1); m2 lives in t2's n2, so it is not found under n1.
    await expect(deleteMemory({ db: db(), vectorize, audit: new Audit(db()) }, opts({ id: "m2" }), 100)).rejects.toThrow(NotFound);
    expect(await db().getMemoryById("n2", "m2")).not.toBeNull(); // t2's row untouched
  });

  it("404s when the namespace is confidential and the caller lacks the device claim", async () => {
    await db().setNamespaceConfidential("t1", "n1");
    const { vectorize } = fakeDeleteVectorize();
    await expect(deleteMemory({ db: db(), vectorize, audit: new Audit(db()) }, opts({ allowConfidential: false }), 100)).rejects.toThrow(NotFound);
    // with the claim, the same call succeeds
    const res = await deleteMemory({ db: db(), vectorize, audit: new Audit(db()) }, opts({ allowConfidential: true }), 100);
    expect(res.deleted).toBe(true);
  });

  it("reports vectorSkipped when the Vectorize binding is absent (still erases D1)", async () => {
    const res = await deleteMemory({ db: db(), vectorize: undefined, audit: new Audit(db()) }, opts(), 100);
    expect(res.vectorSkipped).toBe(true);
    expect(await db().getMemoryById("n1", "m1")).toBeNull();
  });
});
