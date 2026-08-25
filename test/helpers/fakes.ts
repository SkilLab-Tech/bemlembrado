import type { AiLike } from "../../src/memory/embed";
import type { VectorizeLike } from "../../src/memory/vector-index";

/** In-memory Vectorize fake honoring the native namespace filter; captures upserts. */
export function captureVectorize() {
  const store: VectorizeVector[] = [];
  const vectorize: VectorizeLike = {
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
  return { vectorize, store };
}

/** Deterministic embedding fake. */
export function fakeAi(vector: number[] = [0.1, 0.2, 0.3]): AiLike {
  return { run: () => Promise.resolve({ data: [vector] }) };
}
