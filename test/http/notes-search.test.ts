import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { createApp } from "../../src/http/app";
import { fakeAi } from "../helpers/fakes";
import { NoteGraph } from "../../src/vault/graph";
import { VaultRetriever, type VaultVectorize } from "../../src/vault/retrieve";
import { type Note, VaultStore } from "../../src/vault/store";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { appEnv, testEnv } from "../helpers/env";

/** In-memory Vectorize honoring namespace + deleteByIds (VaultRetriever needs delete). */
function vaultVectorize(): { vectorize: VaultVectorize } {
  const store: VectorizeVector[] = [];
  const vectorize: VaultVectorize = {
    upsert(vs) {
      store.push(...vs);
      return Promise.resolve({ count: vs.length });
    },
    query(_v, opts) {
      const ns = opts?.namespace;
      const topK = opts?.topK ?? 5;
      const matches = store.filter((v) => v.namespace === ns).slice(0, topK).map((v) => ({ id: v.id, score: 0.9, namespace: v.namespace }));
      return Promise.resolve({ matches, count: matches.length } as VectorizeMatches);
    },
    deleteByIds(ids) {
      const set = new Set(ids);
      for (let i = store.length - 1; i >= 0; i--) {
        const v = store[i];
        if (v !== undefined && set.has(v.id)) store.splice(i, 1);
      }
      return Promise.resolve({ count: ids.length });
    },
  };
  return { vectorize };
}

function note(slug: string, body: string): Note {
  return { slug, frontmatter: { id: `n1:${slug}`, type: "fact", created_at: 1, updated_at: 2, links: [] }, body };
}

async function clearVault(): Promise<void> {
  const res = await testEnv.VAULT.list();
  if (res.objects.length > 0) await testEnv.VAULT.delete(res.objects.map((o) => o.key));
}

describe("REST POST /v1/notes/search", () => {
  let vv: { vectorize: VaultVectorize };
  beforeEach(async () => {
    await resetDb();
    await clearVault();
    await seedTenant("dev");
    await seedNamespace("n1", "dev", "agent-a");
    vv = vaultVectorize();
    // Curate-equivalent setup: write the note to R2 + index its chunks in note:n1.
    const vault = new VaultStore(testEnv.VAULT);
    await vault.putNote("dev", "n1", note("sky-fact", "the sky is blue"));
    await new VaultRetriever({ vault, graph: new NoteGraph(db()), ai: fakeAi(), vectorize: vv.vectorize }).index("n1", "sky-fact", "the sky is blue");
  });

  function env(): Env {
    return { ...appEnv, DEV_AUTHLESS: "true", ENVIRONMENT: "dev", AI: fakeAi() as unknown as Ai, VECTORIZE: vv.vectorize as unknown as VectorizeIndex };
  }
  async function search(bodyObj: unknown, e: Env): Promise<Response> {
    return createApp().request("/v1/notes/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyObj) }, e);
  }

  it("401 without a key", async () => {
    expect((await search({ namespace: "agent-a", query: "sky" }, appEnv)).status).toBe(401);
  });

  it("finds the indexed note in the vault note namespace (separate from episodic)", async () => {
    const res = await search({ namespace: "agent-a", query: "sky" }, env());
    expect(res.status).toBe(200);
    const raw: unknown = await res.json();
    const body = raw as { hits: { slug: string; body: string | null }[] };
    expect(body.hits.map((h) => h.slug)).toContain("sky-fact");
    expect(body.hits.find((h) => h.slug === "sky-fact")?.body).toBe("the sky is blue");
  });

  it("400 on an invalid body", async () => {
    expect((await search({ namespace: "agent-a" }, env())).status).toBe(400);
  });
});
