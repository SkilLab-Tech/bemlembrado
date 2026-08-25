import { type AbuseConfig, assertMemoryQuota } from "../abuse/guards";
import { selectConsolidationCandidate } from "../council/candidates";
import { summarizeConsolidation } from "../council/summarize";
import type { Db, MemoryRow } from "../db/client";
import type { KvStore } from "../db/kv";
import type { ChatProvider, InferenceClient } from "../inference/client";
import type { Logger } from "../obs/log";
import { type AiLike, embed } from "./embed";
import { buildMetadataJson } from "./metadata";
import { resolveMemoryNamespace } from "./namespace-guard";
import { type VectorizeLike, VectorStore } from "./vector-index";

/**
 * Write-time consolidation (F5 #105-107). OFF BY DEFAULT and semantic-only. When
 * enabled and an incoming write is CONTESTED against an existing note (candidate
 * selection #105), the note is merged in place (summarizer #106) instead of storing
 * a near-duplicate. When absent/disabled the add path below is byte-for-byte the
 * original: no namespace scan, no model call, no cost.
 */
export interface ConsolidationDeps {
  enabled: boolean;
  client: InferenceClient;
  /** Hot-path store for the scoped cache-bust after a consolidation. Optional. */
  kv?: KvStore;
  /** Summarizer provider (default workers-ai). */
  provider?: ChatProvider;
  /** Candidate-selection overlap threshold (default 0.2). */
  threshold?: number;
  /** Cap the existing memories scanned (default 50). */
  maxCandidates?: number;
  logger?: Logger;
}

/** Volume-abuse quota. Absent = disabled (default): no count query. */
export interface AbuseGuard {
  enabled: boolean;
  config: AbuseConfig;
}

export interface AddMemoryDeps {
  db: Db;
  ai: AiLike;
  vectorize: VectorizeLike;
  /** Optional write-time consolidation. Absent = disabled (default). */
  consolidation?: ConsolidationDeps;
  /** Optional storage-abuse quota. Absent = disabled (default). */
  abuse?: AbuseGuard;
}

export interface AddMemoryInput {
  tenantId: string;
  /** Namespace label (resolved + tenant-checked before any store). */
  namespace: string;
  /** Device-derived LGPD claim (never request input): may this credential touch a confidential namespace. */
  allowConfidential: boolean;
  text: string;
  kind?: "semantic" | "episodic";
  metadata?: Record<string, unknown>;
  /** Idempotency key (UNIQUE per namespace; see #38). */
  dedupeKey?: string;
  /** Injected timestamp (caller passes Date.now()). */
  now: number;
  /** Optional explicit id (defaults to a uuid). */
  id?: string;
}

export interface AddMemoryResult {
  id: string;
  /** True when the write was merged into an existing note instead of inserted. */
  consolidated?: boolean;
}

/**
 * add_memory (FR-3/FR-4): resolve the tenant-owned namespace, embed the text,
 * upsert the namespaced vector to Vectorize, then insert the source-of-truth row
 * in D1. vector_id == row id so right-to-delete can cascade to both stores.
 * Order matters: namespace resolution (400/404) happens before any write.
 */
export async function addMemory(deps: AddMemoryDeps, input: AddMemoryInput): Promise<AddMemoryResult> {
  const { id: namespaceId } = await resolveMemoryNamespace(deps.db, input.tenantId, input.namespace, input.allowConfidential);

  // Idempotency: a repeated dedupeKey returns the existing memory, no new write.
  if (input.dedupeKey !== undefined) {
    const existing = await deps.db.getMemoryByDedupeKey(namespaceId, input.dedupeKey);
    if (existing !== null) {
      return { id: existing.id };
    }
  }

  const kind = input.kind ?? "semantic";

  // Write-time consolidation: flag-gated + semantic-only. Episodic rows are an
  // append-only log and are never merged. Off by default → skip entirely (no cost).
  const consolidation = deps.consolidation;
  if (consolidation?.enabled === true && kind === "semantic") {
    const merged = await tryConsolidate(deps, consolidation, namespaceId, input);
    if (merged !== null) return merged;
  }

  // Storage-abuse quota: only genuine NEW inserts are gated — a dedupe hit
  // returned above and a consolidation merge above add no row. Off by default.
  if (deps.abuse?.enabled === true) {
    assertMemoryQuota(await deps.db.countMemoriesByNamespace(namespaceId), deps.abuse.config);
  }

  const vector = await embed(deps.ai, input.text);
  const id = input.id ?? crypto.randomUUID();

  // D1-first (mig 0021): write the row with vector_ok=0 BEFORE the vector, then confirm
  // it after the upsert. A crash never leaves an orphan VECTOR with no D1 row (which would
  // surface as a null-hydration search hit); the worst residual is a vector_ok=0 row with
  // no vector, which is simply absent from search (nothing to hydrate).
  await deps.db.insertMemory({
    id,
    namespace_id: namespaceId,
    kind,
    text: input.text,
    vector_id: id,
    metadata_json: buildMetadataJson(input.metadata),
    created_at: input.now,
    ttl: null,
    dedupe_key: input.dedupeKey ?? null,
    vector_ok: 0,
  });

  await new VectorStore(deps.vectorize).upsert({ id, namespaceId, values: vector });
  await deps.db.setMemoryVectorOk(namespaceId, id);

  return { id };
}

/**
 * If the incoming write is contested against an existing semantic note, merge it in
 * place: re-embed the consolidated body, re-upsert the target's vector (same id ⇒
 * same vector_id, so delete-cascade still holds), rewrite the D1 text, and bust the
 * namespace's cached summary. Returns the target id, or null when nothing is contested
 * (caller then takes the normal insert path).
 */
async function tryConsolidate(
  deps: AddMemoryDeps,
  consolidation: ConsolidationDeps,
  namespaceId: string,
  input: AddMemoryInput,
): Promise<AddMemoryResult | null> {
  const existing = await deps.db.listMemoriesByNamespace(namespaceId);
  const candidates = existing
    .filter((m): m is MemoryRow & { text: string } => m.kind === "semantic" && typeof m.text === "string" && m.id !== input.id)
    .map((m) => ({ id: m.id, text: m.text }));

  const selection = selectConsolidationCandidate(input.text, candidates, {
    ...(consolidation.threshold !== undefined ? { threshold: consolidation.threshold } : {}),
    ...(consolidation.maxCandidates !== undefined ? { maxCandidates: consolidation.maxCandidates } : {}),
  });
  if (!selection.contested || selection.targetId === null || selection.existing === null) return null;

  const { body } = await summarizeConsolidation(
    {
      client: consolidation.client,
      ...(consolidation.provider !== undefined ? { provider: consolidation.provider } : {}),
      ...(consolidation.logger !== undefined ? { logger: consolidation.logger } : {}),
    },
    { topic: input.namespace, existing: selection.existing, incoming: input.text },
  );

  const vector = await embed(deps.ai, body);
  await new VectorStore(deps.vectorize).upsert({ id: selection.targetId, namespaceId, values: vector });
  await deps.db.updateMemoryText(namespaceId, selection.targetId, body, input.now);

  // Scoped hot-path invalidation (KV bust) — the namespace's cached summary is now
  // stale. Convention-following key (["ns", nsId, "summary"]); harmless no-op if none.
  if (consolidation.kv !== undefined) {
    await consolidation.kv.delete(input.tenantId, ["ns", namespaceId, "summary"]);
  }

  consolidation.logger?.log("info", "memory consolidated", { namespace: input.namespace, targetId: selection.targetId, score: selection.score });
  return { id: selection.targetId, consolidated: true };
}
