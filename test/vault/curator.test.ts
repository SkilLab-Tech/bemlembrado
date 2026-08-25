import { beforeEach, describe, expect, it } from "vitest";
import { type ChatLike, curate, type CuratorDeps, CuratorError, parseDecision } from "../../src/vault/curator";
import { NoteGraph } from "../../src/vault/graph";
import { VaultStore } from "../../src/vault/store";
import { createLogger } from "../../src/obs/log";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { testEnv } from "../helpers/env";

/** Chat model fake: returns the scripted responses in order (ignores the prompt). */
function scriptedChat(...responses: string[]): ChatLike {
  let i = 0;
  return { complete: () => Promise.resolve(responses[i++] ?? "{}") };
}

async function clearVault(): Promise<void> {
  const res = await testEnv.VAULT.list();
  if (res.objects.length > 0) await testEnv.VAULT.delete(res.objects.map((o) => o.key));
}

function mkDeps(chat: ChatLike): CuratorDeps {
  return { vault: new VaultStore(testEnv.VAULT), graph: new NoteGraph(db()), db: db(), chat };
}

describe("parseDecision", () => {
  it("extracts the JSON object even with surrounding prose / code fences", () => {
    const d = parseDecision('Sure!\n```json\n{"action":"create","slug":"pix","type":"fact","body":"x"}\n```');
    expect(d.slug).toBe("pix");
  });
  it("rejects output with no JSON", () => {
    expect(() => parseDecision("no json here")).toThrow(CuratorError);
  });
  it("rejects schema violations (bad slug)", () => {
    expect(() => parseDecision('{"action":"create","slug":"Bad Slug","type":"fact","body":"x"}')).toThrow(CuratorError);
  });
});

describe("curate (LLM-Wiki curator)", () => {
  beforeEach(async () => {
    await resetDb();
    await clearVault();
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "agent-a");
    await seedNamespace("n2", "t1", "agent-b");
  });

  it("creates a note in R2 + D1 graph + index on a fresh fact", async () => {
    const deps = mkDeps(scriptedChat('{"action":"create","slug":"pix-pref","type":"preference","body":"User prefers [[pix]]."}'));
    const res = await curate(deps, { tenantId: "t1", namespaceId: "n1", episode: { id: "e1", text: "I like PIX" }, now: 10 });

    expect(res.decision.action).toBe("create");
    const stored = await new VaultStore(testEnv.VAULT).getNote("t1", "n1", "pix-pref");
    expect(stored?.frontmatter.source_episode).toBe("e1");
    expect(stored?.frontmatter.links).toStrictEqual(["pix"]);
    expect(await db().getNoteBySlug("n1", "pix-pref")).not.toBeNull();
    expect(await new VaultStore(testEnv.VAULT).getIndex("t1", "n1")).toContain("[[pix-pref]]");
  });

  it("3 related facts produce <=3 notes with cross-[[links]] + updated index (AC)", async () => {
    const deps = mkDeps(
      scriptedChat(
        '{"action":"create","slug":"ana","type":"entity","body":"Ana is a client. See [[ana-plan]]."}',
        '{"action":"create","slug":"ana-plan","type":"fact","body":"Ana is on the [[pro-plan]]. From [[ana]]."}',
        '{"action":"update","slug":"ana","type":"entity","body":"Ana is a client on [[ana-plan]]. Prefers email."}',
      ),
    );
    await curate(deps, { tenantId: "t1", namespaceId: "n1", episode: { id: "e1", text: "Ana is a client" }, now: 1 });
    await curate(deps, { tenantId: "t1", namespaceId: "n1", episode: { id: "e2", text: "Ana is on pro plan" }, now: 2 });
    await curate(deps, { tenantId: "t1", namespaceId: "n1", episode: { id: "e3", text: "Ana prefers email" }, now: 3 });

    const notes = await db().listNotesByNamespace("n1");
    expect(notes.map((n) => n.slug)).toStrictEqual(["ana", "ana-plan"]); // update didn't duplicate -> 2 (<=3)
    expect(await new NoteGraph(db()).backlinks("n1", "ana-plan")).toStrictEqual(["ana"]);
    expect(await new VaultStore(testEnv.VAULT).getIndex("t1", "n1")).toContain("[[ana-plan]]");
  });

  it("update reuses id + created_at and bumps updated_at", async () => {
    const deps = mkDeps(
      scriptedChat('{"action":"create","slug":"ana","type":"entity","body":"v1"}', '{"action":"update","slug":"ana","type":"entity","body":"v2"}'),
    );
    await curate(deps, { tenantId: "t1", namespaceId: "n1", episode: { id: "e1", text: "x" }, now: 1 });
    const r2 = await curate(deps, { tenantId: "t1", namespaceId: "n1", episode: { id: "e2", text: "y" }, now: 5 });
    expect(r2.note.frontmatter.created_at).toBe(1);
    expect(r2.note.frontmatter.updated_at).toBe(5);
    expect((await db().getNoteBySlug("n1", "ana"))?.created_at).toBe(1);
  });

  it("rejects bad model output, logs it, and persists NOTHING (KFM-004)", async () => {
    const lines: string[] = [];
    const deps: CuratorDeps = { ...mkDeps(scriptedChat("the model rambled with no json")), logger: createLogger((l) => lines.push(l)) };
    await expect(
      curate(deps, { tenantId: "t1", namespaceId: "n1", episode: { id: "e1", text: "x" }, now: 1 }),
    ).rejects.toBeInstanceOf(CuratorError);
    expect(await db().listNotesByNamespace("n1")).toStrictEqual([]);
    expect(await new VaultStore(testEnv.VAULT).getNote("t1", "n1", "anything")).toBeNull();
    expect(lines.some((l) => l.includes("curator output rejected"))).toBe(true);
  });

  it("is namespace-isolated: notes land only in the target namespace", async () => {
    const deps = mkDeps(scriptedChat('{"action":"create","slug":"only-n1","type":"fact","body":"x"}'));
    await curate(deps, { tenantId: "t1", namespaceId: "n1", episode: { id: "e1", text: "x" }, now: 1 });
    expect((await db().listNotesByNamespace("n1")).length).toBe(1);
    expect(await db().listNotesByNamespace("n2")).toStrictEqual([]);
  });
});
