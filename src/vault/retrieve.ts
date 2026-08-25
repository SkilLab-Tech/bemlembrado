import { type AiLike, embed } from "../memory/embed";
import type { NoteGraph } from "./graph";
import type { Note, VaultStore } from "./store";

/**
 * Vault-backed retrieval (PR #44 / vault-A4). Note chunks are embedded and indexed
 * in Vectorize under a DERIVED namespace `note:{namespaceId}` — kept separate from
 * episode vectors yet still tenant/namespace-isolated (the prefix derives from the
 * already-resolved namespace_id, so INVARIANT #2 holds). Search collapses chunk
 * hits back to notes, hydrates markdown from R2, and can expand via the backlink
 * graph. Workers AI / Vectorize are dependency-injected (no local sim).
 */

const CHUNK_CAP = 8;
const CHUNK_SIZE = 280;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;

export const VAULT_VECTOR_NS_PREFIX = "note:";

export function noteVectorNamespace(namespaceId: string): string {
  return `${VAULT_VECTOR_NS_PREFIX}${namespaceId}`;
}

/** Split a note body into a bounded set of chunks (atomic notes usually yield 1). */
export function chunkBody(body: string): string[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  const paras = trimmed.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
  const source = paras.length > 0 ? paras : [trimmed];
  const chunks: string[] = [];
  for (const p of source) {
    if (p.length <= CHUNK_SIZE) {
      chunks.push(p);
    } else {
      for (let i = 0; i < p.length; i += CHUNK_SIZE) chunks.push(p.slice(i, i + CHUNK_SIZE));
    }
    if (chunks.length >= CHUNK_CAP) break;
  }
  return chunks.slice(0, CHUNK_CAP);
}

/** Structural subset of Vectorize used here (adds deleteByIds for stale-chunk cleanup). */
export interface VaultVectorize {
  upsert(vectors: VectorizeVector[]): Promise<unknown>;
  query(vector: number[], options?: VectorizeQueryOptions): Promise<VectorizeMatches>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

export interface VaultRetrieverDeps {
  vault: VaultStore;
  graph: NoteGraph;
  ai: AiLike;
  vectorize: VaultVectorize;
}

export interface VaultSearchInput {
  tenantId: string;
  namespaceId: string;
  query: string;
  topK?: number;
  expandBacklinks?: boolean;
}

export interface VaultHit {
  slug: string;
  score: number;
  note: Note | null;
  /** Slugs surfaced via backlink expansion (empty unless expandBacklinks). */
  related: string[];
}

function chunkId(slug: string, i: number): string {
  return `${slug}#${String(i)}`;
}

/** The bounded set of chunk vector ids a slug may occupy (for re-index + delete). */
export function noteChunkIds(slug: string): string[] {
  return Array.from({ length: CHUNK_CAP }, (_, i) => chunkId(slug, i));
}

function slugOf(vectorId: string): string {
  const hash = vectorId.indexOf("#");
  return hash === -1 ? vectorId : vectorId.slice(0, hash);
}

export class VaultRetriever {
  constructor(private readonly deps: VaultRetrieverDeps) {}

  /** Index (or re-index) a note's chunks. Idempotent: clears prior chunks first. */
  async index(namespaceId: string, slug: string, body: string): Promise<void> {
    const ns = noteVectorNamespace(namespaceId);
    // Clear the bounded set of prior chunk ids so an update leaves no stale chunks.
    await this.deps.vectorize.deleteByIds(noteChunkIds(slug));
    const chunks = chunkBody(body);
    if (chunks.length === 0) return;
    const vectors: VectorizeVector[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk === undefined) continue;
      vectors.push({ id: chunkId(slug, i), values: await embed(this.deps.ai, chunk), namespace: ns, metadata: { slug } });
    }
    await this.deps.vectorize.upsert(vectors);
  }

  async search(input: VaultSearchInput): Promise<VaultHit[]> {
    const topK = Math.min(input.topK ?? DEFAULT_TOP_K, MAX_TOP_K);
    const vector = await embed(this.deps.ai, input.query);
    // Over-fetch chunks so several chunks of one note still collapse to topK notes.
    const result = await this.deps.vectorize.query(vector, {
      topK: Math.min(topK * 2, MAX_TOP_K),
      namespace: noteVectorNamespace(input.namespaceId),
    });

    const bestBySlug = new Map<string, number>();
    for (const match of result.matches) {
      const slug = slugOf(match.id);
      const prev = bestBySlug.get(slug);
      if (prev === undefined || match.score > prev) bestBySlug.set(slug, match.score);
    }
    const ranked = [...bestBySlug.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);

    const hits: VaultHit[] = [];
    for (const [slug, score] of ranked) {
      const note = await this.deps.vault.getNote(input.tenantId, input.namespaceId, slug);
      const related = input.expandBacklinks === true ? await this.deps.graph.backlinks(input.namespaceId, slug) : [];
      hits.push({ slug, score, note, related });
    }
    return hits;
  }
}
