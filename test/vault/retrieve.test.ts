import { beforeEach, describe, expect, it } from "vitest";
import { chunkBody, noteVectorNamespace, type VaultVectorize, VaultRetriever } from "../../src/vault/retrieve";
import { NoteGraph, type NoteMirror } from "../../src/vault/graph";
import { type Note, VaultStore } from "../../src/vault/store";
import { fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { testEnv } from "../helpers/env";

/** Vectorize fake with deleteByIds; honors the native namespace filter. */
function fakeVaultVectorize() {
  const store = new Map<string, VectorizeVector>();
  const vectorize: VaultVectorize = {
    upsert(vectors) {
      for (const v of vectors) store.set(v.id, v);
      return Promise.resolve({ count: vectors.length });
    },
    query(_vector, options) {
      const ns = options?.namespace;
      const topK = options?.topK ?? 5;
      const matches = [...store.values()]
        .filter((v) => v.namespace === ns)
        .slice(0, topK)
        .map((v, i) => ({ id: v.id, score: 1 - i * 0.05, namespace: v.namespace }));
      return Promise.resolve({ matches, count: matches.length } as VectorizeMatches);
    },
    deleteByIds(ids) {
      for (const id of ids) store.delete(id);
      return Promise.resolve({ count: ids.length });
    },
  };
  return { vectorize, store };
}

function note(slug: string, body: string): Note {
  return { slug, frontmatter: { id: `n1:${slug}`, type: "fact", created_at: 1, updated_at: 1, links: [] }, body };
}
function mirror(slug: string): NoteMirror {
  return { id: `n1:${slug}`, slug, type: "fact", r2Key: `t1/n1/notes/${slug}.md`, createdAt: 1, updatedAt: 1 };
}

async function clearVault(): Promise<void> {
  const res = await testEnv.VAULT.list();
  if (res.objects.length > 0) await testEnv.VAULT.delete(res.objects.map((o) => o.key));
}

describe("chunkBody / namespace", () => {
  it("splits on blank lines and drops empties", () => {
    expect(chunkBody("a\n\nb")).toStrictEqual(["a", "b"]);
    expect(chunkBody("")).toStrictEqual([]);
  });
  it("derives an isolated note: namespace", () => {
    expect(noteVectorNamespace("n1")).toBe("note:n1");
  });
});

describe("VaultRetriever", () => {
  let vault: VaultStore;
  let graph: NoteGraph;
  let fv: ReturnType<typeof fakeVaultVectorize>;
  let retriever: VaultRetriever;

  beforeEach(async () => {
    await resetDb();
    await clearVault();
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "agent-a");
    await seedNamespace("n2", "t1", "agent-b");
    vault = new VaultStore(testEnv.VAULT);
    graph = new NoteGraph(db());
    fv = fakeVaultVectorize();
    retriever = new VaultRetriever({ vault, graph, ai: fakeAi(), vectorize: fv.vectorize });
  });

  it("returns hydrated notes, deduped by slug, namespace-isolated", async () => {
    await vault.putNote("t1", "n1", note("ana", "Ana is a client.\n\nAna likes [[pix]]."));
    await vault.putNote("t1", "n1", note("pix", "PIX is instant."));
    await vault.putNote("t1", "n2", note("other", "different namespace"));
    await retriever.index("n1", "ana", "Ana is a client.\n\nAna likes [[pix]]."); // 2 chunks
    await retriever.index("n1", "pix", "PIX is instant.");
    await retriever.index("n2", "other", "different namespace");

    const hits = await retriever.search({ tenantId: "t1", namespaceId: "n1", query: "client" });
    const slugs = hits.map((h) => h.slug);
    expect(slugs).toStrictEqual(["ana", "pix"]); // deduped (ana had 2 chunks), other ns excluded
    expect(hits.find((h) => h.slug === "ana")?.note?.body).toContain("Ana is a client");
  });

  it("expandBacklinks surfaces notes that link to a hit", async () => {
    await vault.putNote("t1", "n1", note("a", "the target"));
    await graph.indexNote("n1", mirror("a"), "the target");
    await graph.indexNote("n1", mirror("b"), "see [[a]]");
    await retriever.index("n1", "a", "the target");

    const hits = await retriever.search({ tenantId: "t1", namespaceId: "n1", query: "q", expandBacklinks: true });
    expect(hits.find((h) => h.slug === "a")?.related).toStrictEqual(["b"]);
  });

  it("re-index leaves no stale chunk vectors when a note shrinks", async () => {
    await retriever.index("n1", "ana", "para one [[x]]\n\npara two here");
    expect(fv.store.has("ana#1")).toBe(true);
    await retriever.index("n1", "ana", "now just one short paragraph");
    expect(fv.store.has("ana#1")).toBe(false);
    expect(fv.store.has("ana#0")).toBe(true);
  });

  it("chunks land in the note: namespace (isolation at the vector layer)", async () => {
    await retriever.index("n1", "ana", "hello");
    expect(fv.store.get("ana#0")?.namespace).toBe("note:n1");
  });
});
