import { z } from "zod";
import type { Db, MemoryKind } from "../db/client";
import { BadRequest, NotFound } from "../http/errors";
import { assembleWorkingMemoryBlock, type WorkingMemoryBlock } from "../context/assemble";
import { type AuditPrincipal, recordAudit } from "../lgpd/audit";
import { type AbuseGuard, addMemory, type ConsolidationDeps } from "../memory/add";
import { type AiLike } from "../memory/embed";
import { resolveMemoryNamespace } from "../memory/namespace-guard";
import { searchMemoryResult, type SearchResult } from "../memory/search";
import { MAX_TOP_K, type VectorizeLike } from "../memory/vector-index";
import { type SessionDO, sessionStub, type WorkingMessage } from "../session/session-do";
import { namespaceHidden } from "../auth/namespace";
import { ensureNamespace } from "../onboarding/self-heal";

/**
 * Shared tool-core. The SINGLE place that turns an untrusted request into
 * a tenant-scoped memory op — REST (PR6/7) and MCP (PR9) both call these, so tenant
 * isolation, input bounds, and audit live here once, not per transport.
 *
 * Store unification (defect the F4 verifier flagged): add_memory and search_memory
 * use the SAME episodic store — D1 `memory` + Vectorize namespace `{namespaceId}`.
 * The vault/curator note path (Vectorize ns `note:{ns}`) is a DIFFERENT store and is
 * deliberately NOT wired here for the MVP, so a store written by add is the store
 * read by search. Wiring search to the vault retriever would return empty.
 */

/**
 * Caller identity threaded from auth. `confidential` is the DEVICE-DERIVED LGPD claim
 * (from the credential, never from request input); required so the compiler proves every
 * construction site decided it. Intersection (not a change to AuditPrincipal) keeps the
 * audit-actor type free of authorization state — recordAudit still only reads keyId/tenantId.
 */
export type Principal = AuditPrincipal & { readonly confidential: boolean };

export interface ToolCoreDeps {
  db: Db;
  ai: AiLike;
  vectorize: VectorizeLike;
  sessions: DurableObjectNamespace<SessionDO>;
  /** Injected clock (no Date.now() in core — keeps services deterministic in tests). */
  now: () => number;
  /** Optional write-time consolidation. Absent = disabled (default). */
  consolidation?: ConsolidationDeps;
  /** Optional storage-abuse quota. Absent = disabled (default). */
  abuse?: AbuseGuard;
}

// --- boundary bounds (payload limits enforced before any store touch) ---
const MAX_NAMESPACE = 200;
const MAX_TEXT = 10_000;
const MAX_QUERY = 1_000;
const MAX_SESSION_ID = 200;
const MAX_DEDUPE_KEY = 200;
const MAX_METADATA_BYTES = 5 * 1024;

const AddInput = z.object({
  namespace: z.string().min(1).max(MAX_NAMESPACE),
  text: z.string().min(1).max(MAX_TEXT),
  kind: z.enum(["semantic", "episodic"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  dedupeKey: z.string().min(1).max(MAX_DEDUPE_KEY).optional(),
});

const SearchInput = z.object({
  namespace: z.string().min(1).max(MAX_NAMESPACE),
  query: z.string().min(1).max(MAX_QUERY),
  topK: z.number().int().min(1).max(MAX_TOP_K).optional(),
});

const ContextInput = z.object({
  sessionId: z.string().min(1).max(MAX_SESSION_ID),
  allowMidConvSystem: z.boolean().optional(),
});

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new BadRequest(detail.length > 0 ? detail : "invalid input");
  }
  return result.data;
}

/** 5KiB boundary cap on serialized metadata (stricter than the 10KiB Vectorize cap downstream). */
function assertMetadataBound(metadata: Record<string, unknown> | undefined): void {
  if (metadata === undefined) return;
  const bytes = new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
  if (bytes > MAX_METADATA_BYTES) {
    throw new BadRequest(`metadata ${String(bytes)} bytes exceeds the ${String(MAX_METADATA_BYTES)} byte limit`);
  }
}

/**
 * add_memory: validate bounds, store on the episodic store (tenant-owned namespace
 * resolved + checked inside addMemory), then audit the write at the success boundary.
 */
export async function addMemoryService(deps: ToolCoreDeps, principal: Principal, raw: unknown): Promise<{ id: string; consolidated?: boolean }> {
  const input = parse(AddInput, raw);
  assertMetadataBound(input.metadata);
  const now = deps.now();
  const result = await addMemory(
    {
      db: deps.db,
      ai: deps.ai,
      vectorize: deps.vectorize,
      ...(deps.consolidation !== undefined ? { consolidation: deps.consolidation } : {}),
      ...(deps.abuse !== undefined ? { abuse: deps.abuse } : {}),
    },
    {
      tenantId: principal.tenantId,
      namespace: input.namespace,
      allowConfidential: principal.confidential,
      text: input.text,
      now,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
    },
  );
  await recordAudit(deps.db, principal, "write", { kind: "memory", namespace: input.namespace, memoryId: result.id }, now);
  return result;
}

/**
 * search_memory: validate bounds, query the SAME episodic store add wrote, then audit (query
 * hashed). Returns the honest {hits, requested, returned, dropped} so a caller can tell when
 * the answer was budget-bounded (capped topK / dropped orphans) rather than "no memory exists".
 */
export async function searchMemoryService(deps: ToolCoreDeps, principal: Principal, raw: unknown): Promise<SearchResult> {
  const input = parse(SearchInput, raw);
  const now = deps.now();
  const result = await searchMemoryResult(
    { db: deps.db, ai: deps.ai, vectorize: deps.vectorize },
    {
      tenantId: principal.tenantId,
      namespace: input.namespace,
      allowConfidential: principal.confidential,
      query: input.query,
      ...(input.topK !== undefined ? { topK: input.topK } : {}),
    },
  );
  await recordAudit(deps.db, principal, "read", { kind: "query", namespace: input.namespace, query: input.query }, now, result.namespaceConfidential);
  return result;
}

const NamespaceInput = z.object({
  namespace: z.string().min(1).max(MAX_NAMESPACE).refine((s) => s.trim().length > 0, "namespace must not be blank"),
  confidential: z.boolean().optional(),
});

/**
 * create_namespace: the on-demand namespace-creation surface for BOTH REST and MCP — the
 * MCP connector previously had no way to provision a namespace, so add_memory 404'd for
 * fresh clients. Idempotent (re-creating a label returns created:false, never a dup). A
 * confidential namespace stays a uniform 404 to a non-confidential credential on the create
 * path too (namespaceHidden), so a hidden label is not an existence/id oracle. Reuses
 * deps.abuse.config as the per-plan namespace quota so REST and MCP gate identically.
 */
export async function createNamespaceService(
  deps: Pick<ToolCoreDeps, "db" | "now" | "abuse">,
  principal: Principal,
  raw: unknown,
): Promise<{ id: string; label: string; created: boolean; confidential: boolean }> {
  const { namespace, confidential } = parse(NamespaceInput, raw);
  const label = namespace.trim();
  const existing = await deps.db.getNamespace(principal.tenantId, label);
  if (namespaceHidden(existing, principal.confidential)) throw new NotFound("namespace not found");
  const existed = existing !== null;
  const ns = await ensureNamespace(deps.db, principal.tenantId, label, deps.now(), deps.abuse !== undefined ? { quota: deps.abuse.config } : {});
  // LGPD (controller-posture, decision 2026-08): a namespace holding sensitive/imported data must
  // not be BORN world-readable (mig 0020 defaults confidential=0 — the create-then-flip window
  // could otherwise expose freshly-created data). `confidential: true` raises a NEWLY created namespace to the
  // confidential ACL tier at birth; reading it then requires the device claim (namespaceHidden).
  // Applied on CREATION ONLY and monotonic (0->1): we deliberately do NOT flip an already-existing
  // visible namespace here — that would let a delegated writer hide a tenant's data from its own
  // other credentials. Raising an existing namespace is a separate, claim-gated op if ever needed.
  const born = !existed && confidential === true;
  if (born) await deps.db.setNamespaceConfidential(principal.tenantId, ns.id);
  const isConfidential = born || (existing?.confidential ?? 0) === 1;
  return { id: ns.id, label: ns.label, created: !existed, confidential: isConfidential };
}

/**
 * list_namespaces: the tenant's namespaces. A namespace LABEL is itself personal data, so the
 * list obeys the same default-EXCLUDE as content — a non-confidential credential never sees a
 * confidential row. The confidential flag is safe to echo (only ever false for a visible row).
 */
export async function listNamespacesService(
  deps: Pick<ToolCoreDeps, "db">,
  principal: Principal,
): Promise<{ namespaces: { id: string; label: string; created_at: number; confidential: boolean }[] }> {
  const rows = await deps.db.listNamespacesByTenant(principal.tenantId);
  const visible = principal.confidential ? rows : rows.filter((n) => (n.confidential ?? 0) === 0);
  return { namespaces: visible.map((n) => ({ id: n.id, label: n.label, created_at: n.created_at, confidential: (n.confidential ?? 0) === 1 })) };
}

const MAX_PAGE_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_DECISION_TITLE = 300;
const MAX_REFS = 20;
const MAX_REF_LEN = 500;

const PageInput = z.object({
  namespace: z.string().min(1).max(MAX_NAMESPACE),
  limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
});

export interface PageMemory {
  id: string;
  kind: MemoryKind;
  text: string | null;
  createdAt: number;
}

/**
 * get_page (P5): a namespace-scoped LIST of its own memories, newest first —
 * distinct from search_memory's semantic ranking ("give me this page's contents",
 * not "find the closest match"). Reuses listMemoriesByNamespace, the SAME
 * DESC-ordered query write-time consolidation already scans, and gates through
 * resolveMemoryNamespace — the SAME tenant + confidential check add/search use,
 * so a confidential or cross-tenant namespace is a uniform 404 here too.
 * ponytail: fetches the whole namespace then slices to `limit` in-process
 * (no SQL LIMIT) — matches the existing unbounded-then-filter pattern in
 * tryConsolidate; add a LIMIT clause if a namespace grows into the thousands.
 */
export async function getPageService(
  deps: Pick<ToolCoreDeps, "db" | "now">,
  principal: Principal,
  raw: unknown,
): Promise<{ namespace: string; memories: PageMemory[] }> {
  const input = parse(PageInput, raw);
  const { id: namespaceId, confidential } = await resolveMemoryNamespace(deps.db, principal.tenantId, input.namespace, principal.confidential);
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  // Bound the read in SQL (LIMIT), not in-process: a large namespace must not be fully
  // loaded into the Worker just to return one page. `limit` is zod-capped at MAX_PAGE_LIMIT.
  const rows = await deps.db.listMemoriesByNamespace(namespaceId, limit);
  await recordAudit(deps.db, principal, "read", { kind: "namespace", namespace: input.namespace }, deps.now(), confidential);
  return {
    namespace: input.namespace,
    memories: rows.map((m) => ({ id: m.id, kind: m.kind, text: m.text, createdAt: m.created_at })),
  };
}

const DecisionInput = z.object({
  namespace: z.string().min(1).max(MAX_NAMESPACE),
  title: z.string().min(1).max(MAX_DECISION_TITLE),
  body: z.string().min(1).max(MAX_TEXT),
  refs: z.array(z.string().min(1).max(MAX_REF_LEN)).max(MAX_REFS).optional(),
});

/**
 * log_decision (P5): a thin compose-then-delegate onto add_memory — NO new store,
 * NO new column, NO duplicated bound-check/write/audit logic. Formats
 * `# title\n\nbody` (+ a "Refs:" footer when present) and tags it
 * `metadata.type: "decision"` using add_memory's existing metadata field, so a
 * later read can filter on it without a schema change. kind stays "semantic" —
 * a decision is a durable fact, and letting it participate in write-time
 * consolidation (when enabled) means a correction naturally merges into the
 * prior entry instead of duplicating it.
 */
export async function logDecisionService(deps: ToolCoreDeps, principal: Principal, raw: unknown): Promise<{ id: string; consolidated?: boolean }> {
  const input = parse(DecisionInput, raw);
  const refsFooter = input.refs !== undefined && input.refs.length > 0 ? `\n\nRefs: ${input.refs.join(", ")}` : "";
  const text = `# ${input.title}\n\n${input.body}${refsFooter}`;
  return addMemoryService(deps, principal, {
    namespace: input.namespace,
    text,
    kind: "semantic",
    metadata: { type: "decision", title: input.title, ...(input.refs !== undefined ? { refs: input.refs } : {}) },
  });
}

export interface SessionContextResult {
  sessionId: string;
  messages: WorkingMessage[];
  /** Context Block for the caller to emit AFTER the cache breakpoint (P0 #1). */
  block: WorkingMemoryBlock;
}

/** A session-context read touches only D1 + the SessionDO — never embeddings/Vectorize. */
export interface SessionContextDeps {
  db: Db;
  sessions: DurableObjectNamespace<SessionDO>;
  now: () => number;
}

/**
 * get_session_context: resolve the session TENANT-SCOPED (uniform 404, no oracle),
 * read working memory from the tenant-keyed SessionDO, and assemble the trailing
 * Context Block (placement tool_result | mid_conv_system — NEVER system).
 */
export async function getSessionContextService(
  deps: SessionContextDeps,
  principal: Principal,
  raw: unknown,
): Promise<SessionContextResult> {
  const input = parse(ContextInput, raw);
  const now = deps.now();
  const session = await deps.db.getSessionForTenant(principal.tenantId, input.sessionId, principal.confidential);
  if (session === null) {
    throw new NotFound("session not found");
  }
  const messages = await sessionStub(deps.sessions, session.namespace_id, input.sessionId).getWorkingMemory();
  const block = assembleWorkingMemoryBlock(messages, { allowMidConvSystem: input.allowMidConvSystem ?? false });
  await recordAudit(deps.db, principal, "read", { kind: "session", sessionId: input.sessionId }, now, session.ns_confidential === 1);
  return { sessionId: input.sessionId, messages, block };
}
