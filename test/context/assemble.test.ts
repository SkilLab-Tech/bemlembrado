import { beforeEach, describe, expect, it } from "vitest";
import { assembleContextBlock, getVaultContext, type RetrievedNote } from "../../src/context/assemble";
import { VaultRetriever, type VaultVectorize } from "../../src/vault/retrieve";
import { NoteGraph } from "../../src/vault/graph";
import { type Note, VaultStore } from "../../src/vault/store";
import { fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { testEnv } from "../helpers/env";

const SYSTEM_PROMPT = "You are an assistant. SECRET-OPERATOR-RULES.";

describe("assembleContextBlock (P0 #1: post-breakpoint placement)", () => {
  const notes: RetrievedNote[] = [
    { slug: "ana", body: "Ana is a client.", score: 0.91 },
    { slug: "pix", body: "  PIX is instant.  ", score: 0.8 },
  ];

  it("builds a fenced markdown block with per-note provenance", () => {
    const block = assembleContextBlock(notes);
    expect(block.text).toContain("<retrieved-memory>");
    expect(block.text).toContain("## [[ana]] (score 0.91)");
    expect(block.text).toContain("Ana is a client.");
    expect(block.text).toContain("PIX is instant."); // trimmed
    expect(block.provenance).toStrictEqual([
      { slug: "ana", score: 0.91 },
      { slug: "pix", score: 0.8 },
    ]);
  });

  it("defaults to tool_result placement; NEVER a system message", () => {
    expect(assembleContextBlock(notes).placement).toBe("tool_result");
    // Even with the Opus-4.8 opt-in, placement is the mid-conv system role — still
    // after the breakpoint — never the static system prompt.
    const opus = assembleContextBlock(notes, { allowMidConvSystem: true });
    expect(opus.placement).toBe("mid_conv_system");
    expect(["tool_result", "mid_conv_system"]).toContain(opus.placement);
    // "system" is not even a representable placement (type), and never produced (runtime).
    expect(opus.placement as string).not.toBe("system");
  });

  it("the block is a pure function of the notes — the system prompt can never leak in", () => {
    // The assembler takes ONLY notes; there is no parameter through which the
    // static prefix / system prompt could enter the retrieved block.
    const block = assembleContextBlock(notes);
    expect(block.text).not.toContain(SYSTEM_PROMPT);
    expect(block.text).not.toContain("SECRET-OPERATOR-RULES");
  });

  it("empty retrieval yields a safe, non-empty sentinel block (still tool_result)", () => {
    const block = assembleContextBlock([]);
    expect(block.text).toContain("(no relevant memories)");
    expect(block.placement).toBe("tool_result");
    expect(block.provenance).toStrictEqual([]);
  });
});

function note(slug: string, body: string): Note {
  return { slug, frontmatter: { id: `n1:${slug}`, type: "fact", created_at: 1, updated_at: 1, links: [] }, body };
}
function fakeVaultVectorize(): VaultVectorize {
  const store = new Map<string, VectorizeVector>();
  return {
    upsert(vectors) {
      for (const v of vectors) store.set(v.id, v);
      return Promise.resolve({ count: vectors.length });
    },
    query(_vector, options) {
      const matches = [...store.values()]
        .filter((v) => v.namespace === options?.namespace)
        .slice(0, options?.topK ?? 5)
        .map((v, i) => ({ id: v.id, score: 1 - i * 0.05, namespace: v.namespace }));
      return Promise.resolve({ matches, count: matches.length } as VectorizeMatches);
    },
    deleteByIds(ids) {
      return Promise.resolve({ count: ids.length });
    },
  };
}

describe("getVaultContext (vault-backed get_session_context)", () => {
  beforeEach(async () => {
    await resetDb();
    const res = await testEnv.VAULT.list();
    if (res.objects.length > 0) await testEnv.VAULT.delete(res.objects.map((o) => o.key));
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "agent-a");
  });

  it("retrieves notes and assembles a post-breakpoint block with provenance", async () => {
    const vault = new VaultStore(testEnv.VAULT);
    const retriever = new VaultRetriever({ vault, graph: new NoteGraph(db()), ai: fakeAi(), vectorize: fakeVaultVectorize() });
    await vault.putNote("t1", "n1", note("ana", "Ana is a client."));
    await retriever.index("n1", "ana", "Ana is a client.");

    const block = await getVaultContext(retriever, { tenantId: "t1", namespaceId: "n1", query: "who is ana" });
    expect(block.placement).toBe("tool_result");
    expect(block.text).toContain("Ana is a client.");
    expect(block.provenance.map((p) => p.slug)).toStrictEqual(["ana"]);
  });
});
