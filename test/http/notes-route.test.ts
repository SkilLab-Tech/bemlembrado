import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { createApp } from "../../src/http/app";
import { type Note, VaultStore } from "../../src/vault/store";
import { NoteGraph, type NoteMirror } from "../../src/vault/graph";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { appEnv, testEnv } from "../helpers/env";

function devEnv(): Env {
  // dev-authless; note reads need no AI/Vectorize.
  return { ...appEnv, DEV_AUTHLESS: "true", ENVIRONMENT: "dev" };
}

function note(slug: string, body: string): Note {
  return { slug, frontmatter: { id: `n1:${slug}`, type: "fact", created_at: 1, updated_at: 2, links: [] }, body };
}
function mirror(slug: string): NoteMirror {
  return { id: `n1:${slug}`, slug, type: "fact", r2Key: `t1/n1/notes/${slug}.md`, createdAt: 1, updatedAt: 2 };
}

async function clearVault(): Promise<void> {
  const res = await testEnv.VAULT.list();
  if (res.objects.length > 0) await testEnv.VAULT.delete(res.objects.map((o) => o.key));
}

describe("REST /v1/notes", () => {
  beforeEach(async () => {
    await resetDb();
    await clearVault();
    await seedTenant("dev");
    await seedNamespace("n1", "dev", "agent-a");
    const vault = new VaultStore(testEnv.VAULT);
    const graph = new NoteGraph(db());
    await vault.putNote("dev", "n1", note("sky-fact", "The sky is blue."));
    await graph.indexNote("n1", mirror("sky-fact"), "The sky is blue.");
  });

  it("401 without a key", async () => {
    expect((await createApp().request("/v1/notes?namespace=agent-a", {}, appEnv)).status).toBe(401);
  });

  it("lists note metadata for the namespace", async () => {
    const res = await createApp().request("/v1/notes?namespace=agent-a", {}, devEnv());
    expect(res.status).toBe(200);
    const raw: unknown = await res.json();
    const body = raw as { notes: { slug: string; type: string }[] };
    expect(body.notes).toStrictEqual([{ slug: "sky-fact", type: "fact", updated_at: 2 }]);
  });

  it("reads one note's markdown body from R2", async () => {
    const res = await createApp().request("/v1/notes/sky-fact?namespace=agent-a", {}, devEnv());
    expect(res.status).toBe(200);
    const raw: unknown = await res.json();
    expect((raw as Note).body).toBe("The sky is blue.");
  });

  it("400 without a namespace; 404 for an unknown slug", async () => {
    expect((await createApp().request("/v1/notes", {}, devEnv())).status).toBe(400);
    expect((await createApp().request("/v1/notes/missing?namespace=agent-a", {}, devEnv())).status).toBe(404);
  });
});
