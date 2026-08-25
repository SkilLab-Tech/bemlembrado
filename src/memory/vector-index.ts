/**
 * Typed Vectorize wrapper. Tenant/agent isolation rides Vectorize's NATIVE
 * namespace (INVARIANT #2): namespace is a REQUIRED arg on every upsert/query.
 * Constitution caps asserted in code, not just docs: dims <= 1536, topK <= 50.
 *
 * Injected as `VectorizeLike` (the two methods we use) so unit tests pass a fake
 * — Vectorize has no local Miniflare simulation. Provision at bge-m3's
 * 1024 dims (index dims are EXACT-match; MAX_DIMS=1536 below is only the cap on which
 * models you may pick, not the index size):
 *   wrangler vectorize create bemlembrado-mem --dimensions=1024 --metric=cosine
 */

/** Canonical Vectorize index name (must match wrangler.jsonc + provisioning runbook). */
export const VECTORIZE_INDEX_NAME = "bemlembrado-mem";

export const MAX_TOP_K = 50;
export const MAX_DIMS = 1536;

export class VectorIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorIndexError";
  }
}

/** Minimal structural subset of VectorizeIndex (what this wrapper depends on). */
export interface VectorizeLike {
  upsert(vectors: VectorizeVector[]): Promise<unknown>;
  query(vector: number[], options?: VectorizeQueryOptions): Promise<VectorizeMatches>;
}

export interface StoreVectorInput {
  id: string;
  namespaceId: string;
  values: number[];
  metadata?: Record<string, VectorizeVectorMetadata>;
}

export interface VectorHit {
  id: string;
  score: number;
}

export class VectorStore {
  constructor(private readonly index: VectorizeLike) {}

  async upsert(input: StoreVectorInput): Promise<void> {
    if (input.namespaceId.length === 0) {
      throw new VectorIndexError("namespace_id is required");
    }
    if (input.values.length > MAX_DIMS) {
      throw new VectorIndexError(`embedding dims ${String(input.values.length)} exceed ${String(MAX_DIMS)}`);
    }
    await this.index.upsert([
      {
        id: input.id,
        values: input.values,
        namespace: input.namespaceId,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    ]);
  }

  async query(values: number[], namespaceId: string, topK: number): Promise<VectorHit[]> {
    if (namespaceId.length === 0) {
      throw new VectorIndexError("namespace_id is required");
    }
    if (topK > MAX_TOP_K) {
      throw new VectorIndexError(`topK ${String(topK)} exceeds ${String(MAX_TOP_K)}`);
    }
    const result = await this.index.query(values, { topK, namespace: namespaceId });
    return result.matches.map((m) => ({ id: m.id, score: m.score }));
  }
}
