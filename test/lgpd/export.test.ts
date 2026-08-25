import { beforeEach, describe, expect, it } from "vitest";
import { Audit } from "../../src/lgpd/audit";
import { exportVault, importVault, readVaultExport } from "../../src/lgpd/export";
import { NoteGraph } from "../../src/vault/graph";
import { type Note, VaultStore } from "../../src/vault/store";
import { ensureNamespace } from "../../src/onboarding/self-heal";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { testEnv } from "../helpers/env";

function note(slug: string, body: string, links: string[] = []): Note {
  return { slug, frontmatter: { id: `id-${slug}`, type: "fact", created_at: 1, updated_at: 1, links }, body };
}

async function clearVault(): Promise<void> {
  const res = await testEnv.VAULT.list();
  if (res.objects.length > 0) await testEnv.VAULT.delete(res.objects.map((o) => o.key));
}

describe("vault export / import (LGPD portability)", () => {
  let vault: VaultStore;
  let graph: NoteGraph;
  let audit: Audit;

  beforeEach(async () => {
    await resetDb();
    await clearVault();
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("n1", "t1", "agent-a");
    vault = new VaultStore(testEnv.VAULT);
    graph = new NoteGraph(db());
    audit = new Audit(db());
    await vault.putNote("t1", "n1", note("ana", "Ana is a client. See [[ana-plan]].", ["ana-plan"]));
    await vault.putNote("t1", "n1", note("ana-plan", "Ana is on the pro plan."));
    await vault.putIndex("t1", "n1", "# Memory index\n\n- [[ana]] (fact)\n");
  });

  it("exports a valid zip with a manifest listing the notes", async () => {
    const bytes = await exportVault({ db: db(), vault, audit }, "t1", 500);
    // valid zip = local file header signature PK\x03\x04
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);

    const parsed = readVaultExport(bytes);
    expect(parsed.manifest.tenant).toBe("t1");
    expect(parsed.manifest.namespaces[0]?.notes.sort()).toStrictEqual(["ana", "ana-plan"]);
    expect(parsed.files.get("agent-a/notes/ana.md")).toContain("Ana is a client.");
    expect(parsed.files.has("agent-a/index.md")).toBe(true);
  });

  it("writes an export audit row", async () => {
    await exportVault({ db: db(), vault, audit }, "t1", 500);
    const rows = await audit.list("t1");
    expect(rows.some((r) => r.action === "export" && r.target === "vault")).toBe(true);
  });

  it("reimport round-trips into another tenant losslessly", async () => {
    const bytes = await exportVault({ db: db(), vault, audit }, "t1", 500);
    const imported = await importVault(
      { db: db(), vault, graph, ensureNamespaceId: async (t, label, now) => (await ensureNamespace(db(), t, label, now)).id },
      "t2",
      bytes,
      900,
    );
    expect(imported).toBe(2);

    const t2ns = (await db().getNamespace("t2", "agent-a"))?.id ?? "";
    const ana = await vault.getNote("t2", t2ns, "ana");
    expect(ana?.body).toBe("Ana is a client. See [[ana-plan]].");
    expect(ana?.frontmatter.links).toStrictEqual(["ana-plan"]);
    // graph mirror rebuilt in the target tenant
    expect(await graph.backlinks(t2ns, "ana-plan")).toStrictEqual(["ana"]);
  });
});
