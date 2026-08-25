import type { Db } from "../db/client";
import { type AiLike, embed } from "./embed";
import { resolveMemoryNamespace } from "./namespace-guard";
import { MAX_TOP_K, type VectorizeLike, VectorStore } from "./vector-index";

export interface SearchMemoryDeps {
  db: Db;
  ai: AiLike;
  vectorize: VectorizeLike;
}

export interface SearchMemoryInput {
  tenantId: string;
  namespace: string;
  /** Device-derived LGPD claim (never request input): may this credential read a confidential namespace. */
  allowConfidential: boolean;
  query: string;
  topK?: number;
}

export interface SearchHit {
  id: string;
  score: number;
  text: string | null;
}

/**
 * A search result with an HONEST account of budget effects — so a caller can always tell
 * WHY it got fewer hits than it asked for, instead of silent thinning reading as "no memory".
 */
export interface SearchResult {
  hits: SearchHit[];
  /** topK the caller requested (pre-clamp). returned < requested ⇒ capped at 50 or fewer memories exist. */
  requested: number;
  /** hits actually returned (== hits.length). */
  returned: number;
  /** Vectorize hits dropped because their D1 row was missing (legacy pre-mig-0021 orphans). >0 ⇒ thinning occurred. */
  dropped: number;
  /** Whether the resolved namespace is confidential (mig 0022) — so the caller can mark the read audit. */
  namespaceConfidential: boolean;
}

const DEFAULT_TOP_K = 10;

/**
 * search_memory (FR-3): resolve the tenant-owned namespace, embed the query, query Vectorize
 * within that namespace (topK clamped to <=50), hydrate text from D1 preserving rank order,
 * and report the budget effects (requested/returned/dropped). Hydration is namespace-scoped —
 * a defense-in-depth re-check so a stray cross-namespace vector id can never surface (INVARIANT #2).
 */
export async function searchMemoryResult(deps: SearchMemoryDeps, input: SearchMemoryInput): Promise<SearchResult> {
  const { id: namespaceId, confidential: namespaceConfidential } = await resolveMemoryNamespace(deps.db, input.tenantId, input.namespace, input.allowConfidential);
  const requested = input.topK ?? DEFAULT_TOP_K;
  const topK = Math.min(requested, MAX_TOP_K); // clamp for the query; requested is reported so the cap is never silent

  const vector = await embed(deps.ai, input.query);
  const found = await new VectorStore(deps.vectorize).query(vector, namespaceId, topK);

  const rows = await Promise.all(found.map((hit) => deps.db.getMemoryById(namespaceId, hit.id)));
  // Drop orphan hits — a vector whose D1 row is missing (a pre-mig-0021 crash between the
  // Vectorize upsert and the D1 insert). Returning a null-text hit consumed a topK slot and
  // read as a real memory. Post-0021 the write is D1-first, so no new orphans are created.
  // NB: an episodic row legitimately has text=null — keep it; drop only a MISSING row.
  const hits: SearchHit[] = [];
  found.forEach((hit, i) => {
    const row = rows[i];
    if (row == null) return;
    hits.push({ id: hit.id, score: hit.score, text: row.text });
  });
  return { hits, requested, returned: hits.length, dropped: found.length - hits.length, namespaceConfidential };
}

/** Bare-hits form for internal callers (context assembly) that only need the ranked hits. */
export async function searchMemory(deps: SearchMemoryDeps, input: SearchMemoryInput): Promise<SearchHit[]> {
  return (await searchMemoryResult(deps, input)).hits;
}
