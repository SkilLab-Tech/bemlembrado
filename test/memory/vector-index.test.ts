import { describe, expect, it } from "vitest";
import { type VectorizeLike, VectorIndexError, VectorStore } from "../../src/memory/vector-index";

/** In-memory fake honoring Vectorize's native namespace filter. */
function fakeVectorize(): VectorizeLike {
  const store: VectorizeVector[] = [];
  return {
    upsert(vectors) {
      store.push(...vectors);
      return Promise.resolve({ count: vectors.length });
    },
    query(_vector, options) {
      const ns = options?.namespace;
      const topK = options?.topK ?? 5;
      const matches = store
        .filter((v) => v.namespace === ns)
        .slice(0, topK)
        .map((v) => ({ id: v.id, score: 0.9, namespace: v.namespace }));
      return Promise.resolve({ matches, count: matches.length } as VectorizeMatches);
    },
  };
}

describe("VectorStore", () => {
  it("upserts then queries within the same namespace", async () => {
    const vs = new VectorStore(fakeVectorize());
    await vs.upsert({ id: "v1", namespaceId: "t1:a", values: [0.1, 0.2] });
    const hits = await vs.query([0.1, 0.2], "t1:a", 10);
    expect(hits.map((h) => h.id)).toStrictEqual(["v1"]);
  });

  it("never returns another namespace's vectors (isolation)", async () => {
    const vs = new VectorStore(fakeVectorize());
    await vs.upsert({ id: "v1", namespaceId: "t1:a", values: [0.1] });
    expect(await vs.query([0.1], "t2:b", 10)).toStrictEqual([]);
  });

  it("rejects an upsert with too many dimensions", async () => {
    const vs = new VectorStore(fakeVectorize());
    const tooBig = Array.from({ length: 1537 }, () => 0);
    await expect(vs.upsert({ id: "v1", namespaceId: "t1:a", values: tooBig })).rejects.toBeInstanceOf(VectorIndexError);
  });

  it("rejects a query with topK > 50", async () => {
    const vs = new VectorStore(fakeVectorize());
    await expect(vs.query([0.1], "t1:a", 51)).rejects.toBeInstanceOf(VectorIndexError);
  });

  it("rejects an upsert with an empty namespace", async () => {
    const vs = new VectorStore(fakeVectorize());
    await expect(vs.upsert({ id: "v1", namespaceId: "", values: [0.1] })).rejects.toBeInstanceOf(VectorIndexError);
  });

  it("rejects a query with an empty namespace", async () => {
    const vs = new VectorStore(fakeVectorize());
    await expect(vs.query([0.1], "", 10)).rejects.toBeInstanceOf(VectorIndexError);
  });
});
