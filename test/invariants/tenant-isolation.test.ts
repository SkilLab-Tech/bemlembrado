import { beforeEach, describe, expect, it } from "vitest";
import { resolveNamespace } from "../../src/auth/namespace";
import { appendMessage } from "../../src/session/append";
import { type SessionDO, sessionStub } from "../../src/session/session-do";
import { NoteGraph, type NoteMirror } from "../../src/vault/graph";
import { noteVectorNamespace } from "../../src/vault/retrieve";
import { type Note, VaultStore } from "../../src/vault/store";
import { db, resetDb, seedMemory, seedNamespace, seedTenant } from "../helpers/fixtures";
import { testEnv } from "../helpers/env";

const SESSIONS = testEnv.SESSION as unknown as DurableObjectNamespace<SessionDO>;

/**
 * P0 invariant #2 — tenant isolation, proven LIVE across EVERY store: the D1 data
 * layer, the R2 vault, the note: vector namespace, and the link graph. The Db
 * client + namespace resolver + tenant-prefixed R2 keys make cross-tenant access
 * impossible. CI gate: P0_TENANT_ISO=required (#30, extended for the vault in #53).
 */
describe("P0 invariant #2 — tenant isolation (data layer)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("a tenant's query never returns another tenant's data", async () => {
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("n1", "t1", "shared");
    await seedNamespace("n2", "t2", "shared");
    await seedMemory("m2", "n2", "tenant-2 secret");

    expect((await resolveNamespace(db(), "t1", "shared", false)).id).toBe("n1");
    expect(await db().listMemoriesByNamespace("n1")).toHaveLength(0);
    expect(await db().getNamespaceById("t1", "n2")).toBeNull();
  });

  it("a cross-tenant namespace label resolves to 404, not the other tenant's data", async () => {
    await seedTenant("t2");
    await seedNamespace("n2", "t2", "only-t2");
    await expect(resolveNamespace(db(), "t1", "only-t2", false)).rejects.toThrow();
  });

  it("a confidential namespace is invisible ACROSS tenants under ANY claim (P4 × tenant isolation)", async () => {
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("nc", "t2", "cofre");
    await db().setNamespaceConfidential("t2", "nc");
    // t1 with the strongest possible claim still cannot resolve t2's confidential namespace.
    await expect(resolveNamespace(db(), "t1", "cofre", true)).rejects.toThrow();
    // t2's own NON-confidential claim is denied too — the two gates compose, never cancel.
    await expect(resolveNamespace(db(), "t2", "cofre", false)).rejects.toThrow();
    // only t2 WITH the claim resolves it.
    expect((await resolveNamespace(db(), "t2", "cofre", true)).id).toBe("nc");
  });
});

function note(slug: string, body: string): Note {
  return { slug, frontmatter: { id: slug, type: "fact", created_at: 1, updated_at: 1, links: [] }, body };
}
function mirror(slug: string, id: string): NoteMirror {
  return { id, slug, type: "fact", r2Key: "k", createdAt: 1, updatedAt: 1 };
}

describe("P0 invariant #2 — tenant isolation (vault: R2 + note graph + vector namespace)", () => {
  let vault: VaultStore;
  let graph: NoteGraph;

  beforeEach(async () => {
    await resetDb();
    const res = await testEnv.VAULT.list();
    if (res.objects.length > 0) await testEnv.VAULT.delete(res.objects.map((o) => o.key));
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("n1", "t1", "shared");
    await seedNamespace("n2", "t2", "shared");
    vault = new VaultStore(testEnv.VAULT);
    graph = new NoteGraph(db());
  });

  it("R2 vault notes are tenant-keyed: one tenant cannot read or list another's notes", async () => {
    await vault.putNote("t1", "n1", note("secret", "tenant-1 only"));
    await vault.putNote("t2", "n2", note("secret", "tenant-2 only"));

    // Same slug, same label, different tenants -> fully separate objects.
    expect((await vault.getNote("t1", "n1", "secret"))?.body).toBe("tenant-1 only");
    expect((await vault.getNote("t2", "n2", "secret"))?.body).toBe("tenant-2 only");
    // A tenant probing another tenant's namespace id finds nothing (key carries tenant).
    expect(await vault.getNote("t1", "n2", "secret")).toBeNull();
    expect(await vault.listNotes("t1", "n2")).toStrictEqual([]);
  });

  it("the note: vector namespace is distinct per namespace id", () => {
    expect(noteVectorNamespace("n1")).not.toBe(noteVectorNamespace("n2"));
  });

  it("the link graph is namespace-isolated", async () => {
    await graph.indexNote("n1", mirror("a", "n1:a"), "links [[shared-target]]");
    await graph.indexNote("n2", mirror("a", "n2:a"), "links [[shared-target]]");
    expect(await graph.backlinks("n1", "shared-target")).toStrictEqual(["a"]);
    expect((await graph.orphanLinks("n1")).length).toBe(1); // only n1's edge, never n2's
  });
});

describe("P0 invariant #2 — tenant isolation (sessions + working memory)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("n1", "t1", "agent-a");
    await seedNamespace("nx", "t2", "agent-a");
  });

  it("a session id is not a cross-tenant oracle: T2 cannot read T1's session, messages, or working memory", async () => {
    // T1 writes a session "s" (+ message + working memory) under its namespace n1.
    await appendMessage({ db: db(), sessions: SESSIONS }, { sessionId: "s", namespaceId: "n1", role: "user", content: "t1-secret", ts: 1, id: "m1" });

    // Owner (T1) sees it; T2 (different tenant, same label/session id) sees nothing.
    expect(await db().getSessionForTenant("t1", "s", false)).not.toBeNull();
    expect(await db().getSessionForTenant("t2", "s", false)).toBeNull(); // uniform null, no oracle
    expect((await db().listMessagesForSession("n1", "s")).length).toBe(1);
    expect(await db().listMessagesForSession("nx", "s")).toStrictEqual([]); // structurally scoped

    // Working memory: T2's composite DO key addresses a DIFFERENT, empty DO.
    expect((await sessionStub(SESSIONS, "n1", "s").getWorkingMemory()).length).toBe(1);
    expect(await sessionStub(SESSIONS, "nx", "s").getWorkingMemory()).toStrictEqual([]);
  });
});
