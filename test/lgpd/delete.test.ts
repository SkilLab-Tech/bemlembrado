import { beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "../../src/auth/api-key";
import { Db } from "../../src/db/client";
import { KvStore } from "../../src/db/kv";
import { createApp } from "../../src/http/app";
import { NotFound } from "../../src/http/errors";
import { Audit } from "../../src/lgpd/audit";
import { type DeleteVectorize, deleteNamespace, isExpired } from "../../src/lgpd/delete";
import { NoteGraph } from "../../src/vault/graph";
import { type Note, VaultStore } from "../../src/vault/store";
import { appEnv, testEnv } from "../helpers/env";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";

function note(slug: string, body: string): Note {
  return { slug, frontmatter: { id: `n1:${slug}`, type: "fact", created_at: 1, updated_at: 1, links: [] }, body };
}
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
async function clearVault(): Promise<void> {
  const res = await testEnv.VAULT.list();
  if (res.objects.length > 0) await testEnv.VAULT.delete(res.objects.map((o) => o.key));
}

describe("isExpired (retention TTL)", () => {
  it("keeps forever when retention is null/0/negative", () => {
    expect(isExpired(0, null, 1e12)).toBe(false);
    expect(isExpired(0, 0, 1e12)).toBe(false);
  });
  it("expires once older than retentionDays", () => {
    const now = 100 * 86_400_000;
    expect(isExpired(0, 30, now)).toBe(true);
    expect(isExpired(80 * 86_400_000, 30, now)).toBe(false);
  });
});

describe("deleteNamespace (right-to-erasure cascade)", () => {
  let vault: VaultStore;
  let graph: NoteGraph;

  beforeEach(async () => {
    await resetDb();
    await clearVault();
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("n1", "t1", "agent-a");
    await seedNamespace("n2", "t1", "agent-b");
    vault = new VaultStore(testEnv.VAULT);
    graph = new NoteGraph(db());
    // memory row with a vector id + a vault note (+ graph mirror)
    await db().insertMemory({ id: "m1", namespace_id: "n1", kind: "semantic", text: "x", vector_id: "vec-m1", metadata_json: null, created_at: 1, ttl: null });
    await vault.putNote("t1", "n1", note("ana", "Ana [[ana-plan]]"));
    await graph.indexNote("n1", { id: "n1:ana", slug: "ana", type: "fact", r2Key: "k", createdAt: 1, updatedAt: 1 }, "Ana [[ana-plan]]");
  });

  it("cascades R2 + Vectorize + D1 + graph, writes an audit row, verified by re-query", async () => {
    const fv = fakeDeleteVectorize();
    const res = await deleteNamespace({ db: db(), vault, vectorize: fv.vectorize, audit: new Audit(db()) }, "t1", "n1", 500);

    expect(res.vaultObjects).toBeGreaterThanOrEqual(1);
    expect(fv.deleted).toContain("vec-m1"); // episode vector
    expect(fv.deleted).toContain("ana#0"); // note chunk vector

    // Verify nothing remains for n1:
    expect(await db().getNamespaceById("t1", "n1")).toBeNull();
    expect(await db().listMemoriesByNamespace("n1")).toStrictEqual([]);
    expect(await db().listNotesByNamespace("n1")).toStrictEqual([]);
    expect(await graph.backlinks("n1", "ana-plan")).toStrictEqual([]);
    expect(await vault.getNote("t1", "n1", "ana")).toBeNull();
    expect(await vault.listNotes("t1", "n1")).toStrictEqual([]);

    // Audit row persists (tenant-scoped).
    expect((await new Audit(db()).list("t1")).some((r) => r.action === "delete")).toBe(true);
  });

  it("purges the namespace's KV hot-path keys, sparing siblings + tenant-level keys", async () => {
    const kv = new KvStore(testEnv.KV);
    // clean slate for the prefixes under assertion (KV persists across pool tests)
    await kv.purgeNamespace("t1", "n1");
    await kv.purgeNamespace("t1", "n2");
    await kv.put("t1", ["ns", "n1", "summary", "s1"], "cached-1");
    await kv.put("t1", ["ns", "n1", "route", "sess-1"], "do-a");
    await kv.put("t1", ["ns", "n2", "summary", "s1"], "keep-sibling"); // different namespace
    await kv.put("t1", ["rl", "bucket"], "keep-ratelimit"); // tenant-level, not namespace-scoped

    const res = await deleteNamespace({ db: db(), vault, vectorize: fakeDeleteVectorize().vectorize, kv, audit: new Audit(db()) }, "t1", "n1", 500);

    expect(res.kvKeys).toBe(2);
    expect(await kv.get("t1", ["ns", "n1", "summary", "s1"])).toBeNull();
    expect(await kv.get("t1", ["ns", "n1", "route", "sess-1"])).toBeNull();
    // sibling namespace + non-namespace tenant key untouched
    expect(await kv.get("t1", ["ns", "n2", "summary", "s1"])).toBe("keep-sibling");
    expect(await kv.get("t1", ["rl", "bucket"])).toBe("keep-ratelimit");
  });

  it("does not touch sibling namespaces", async () => {
    await vault.putNote("t1", "n2", note("keep", "stays"));
    await deleteNamespace({ db: db(), vault, vectorize: fakeDeleteVectorize().vectorize, audit: new Audit(db()) }, "t1", "n1", 500);
    expect(await db().getNamespaceById("t1", "n2")).not.toBeNull();
    expect(await vault.getNote("t1", "n2", "keep")).not.toBeNull();
  });

  it("rejects deleting another tenant's namespace (NotFound, no oracle)", async () => {
    await expect(
      deleteNamespace({ db: db(), vault, vectorize: fakeDeleteVectorize().vectorize, audit: new Audit(db()) }, "t2", "n1", 500),
    ).rejects.toBeInstanceOf(NotFound);
  });

  it("attributes the audit row to the supplied actor (key fingerprint), not just the tenant", async () => {
    await deleteNamespace({ db: db(), vault, vectorize: fakeDeleteVectorize().vectorize, audit: new Audit(db()) }, "t1", "n1", 500, "key:abc123");
    const del = (await new Audit(db()).list("t1")).find((r) => r.action === "delete");
    expect(del?.actor).toBe("key:abc123");
  });

  it("completes the erasure even if the audit write fails (best-effort — never re-throws)", async () => {
    // Data is already gone before the audit write; a failing audit must NOT 500 a successful erasure.
    const brokenAudit = {
      record(): Promise<void> {
        return Promise.reject(new Error("audit D1 down"));
      },
    } as unknown as Audit;
    // Resolves (does not reject) despite the audit failure.
    const res = await deleteNamespace({ db: db(), vault, vectorize: fakeDeleteVectorize().vectorize, audit: brokenAudit }, "t1", "n1", 500);
    expect(typeof res.vectorsSkipped).toBe("boolean");
    expect(await db().getNamespaceById("t1", "n1")).toBeNull(); // erasure still happened
  });
});

describe("DELETE /v1/namespaces/:id route", () => {
  const RAW = "bl_deletekey";
  beforeEach(async () => {
    await resetDb();
    await clearVault();
    const hash = await hashApiKey(RAW, "test-pepper");
    await new Db(testEnv.DB).insertTenant({ id: "t1", name: "T1", plan: "open", api_key_hash: hash, created_at: 1 });
    await seedNamespace("n1", "t1", "agent-a");
    await new VaultStore(testEnv.VAULT).putNote("t1", "n1", note("ana", "x"));
    // mirror the note in D1 so the cascade has note-chunk vector ids to skip
    await new NoteGraph(new Db(testEnv.DB)).indexNote("n1", { id: "n1:ana", slug: "ana", type: "fact", r2Key: "k", createdAt: 1, updatedAt: 1 }, "x");
  });

  it("401 without a key", async () => {
    const res = await createApp().request("/v1/namespaces/n1", { method: "DELETE" }, appEnv);
    expect(res.status).toBe(401);
  });

  it("200 + cascades for the owner (VECTORIZE absent in test -> vectorsSkipped reported)", async () => {
    const res = await createApp().request("/v1/namespaces/n1", { method: "DELETE", headers: { authorization: `Bearer ${RAW}` } }, appEnv);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ deleted: { vectorsSkipped: true } });
    expect(await new VaultStore(testEnv.VAULT).getNote("t1", "n1", "ana")).toBeNull();
    expect(await new Db(testEnv.DB).getNamespaceById("t1", "n1")).toBeNull();
  });

  it("audits WHO erased with the API-key fingerprint, not the tenant id", async () => {
    await createApp().request("/v1/namespaces/n1", { method: "DELETE", headers: { authorization: `Bearer ${RAW}` } }, appEnv);
    const del = (await new Audit(new Db(testEnv.DB)).list("t1")).find((r) => r.action === "delete");
    expect(del?.actor).toMatch(/^[0-9a-f]{12}$/); // keyId = api_key_hash.slice(0,12)
    expect(del?.actor).not.toBe("t1");
  });
});
