import { clampMemories, type ContextBudget } from "../context/budget";
import { buildRequest, type RequestParts } from "../context/contract";
import type { Provider } from "../inference/providers";
import { resolveMemoryNamespace } from "../memory/namespace-guard";
import { type SearchHit, searchMemory } from "../memory/search";
import { sessionStub, type WorkingMessage } from "../session/session-do";
import type { Principal, ToolCoreDeps } from "./services";

/**
 * Turn assembly (turn-batch) — the cache-aware request build. Loads the session's
 * working-memory history and the relevant retrieved memories, then `buildRequest`
 * splits them: the static prefix (system + history + latest user) is byte-identical
 * across turns BECAUSE memories are excluded by construction (P0 #1); the retrieved
 * Context Block rides after the breakpoint. Tenant-scoped via the resolved namespace.
 */

export interface AssembleTurnInput {
  sessionId: string;
  namespace: string;
  /** Trusted operator system prompt (part of the cached prefix). */
  systemPrompt: string;
  /** Latest user message (the cache breakpoint). */
  message: string;
  provider?: Provider;
  allowMidConvSystem?: boolean;
  topK?: number;
  /** Caps the retrieved Context Block (chars/items). Never trims history (cache-safe). */
  budget?: ContextBudget;
}

export interface AssembledTurn {
  namespaceId: string;
  /** Whether the resolved namespace is confidential (mig 0022) — so runTurn can mark the read audit. */
  namespaceConfidential: boolean;
  parts: RequestParts;
  /** Retrieved memories (provenance for the response). */
  memories: SearchHit[];
  /** Working-memory history lines used in the prefix. */
  history: string[];
  /** Structured working memory (for building the provider chat messages). */
  working: WorkingMessage[];
}

export async function assembleTurn(deps: ToolCoreDeps, principal: Principal, input: AssembleTurnInput): Promise<AssembledTurn> {
  const { id: namespaceId, confidential: namespaceConfidential } = await resolveMemoryNamespace(deps.db, principal.tenantId, input.namespace, principal.confidential);

  const working = await sessionStub(deps.sessions, namespaceId, input.sessionId).getWorkingMemory();
  const history = working.map((m) => `${m.role}: ${m.content}`);

  const hits = await searchMemory(
    { db: deps.db, ai: deps.ai, vectorize: deps.vectorize },
    {
      tenantId: principal.tenantId,
      namespace: input.namespace,
      allowConfidential: principal.confidential,
      query: input.message,
      ...(input.topK !== undefined ? { topK: input.topK } : {}),
    },
  );
  const { kept: memories } = clampMemories(
    hits.map((h) => h.text).filter((t): t is string => t !== null),
    input.budget ?? {},
  );

  const parts = buildRequest(
    { systemPrompt: input.systemPrompt, history, latestUser: input.message, memories },
    {
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      allowMidConvSystem: input.allowMidConvSystem === true,
    },
  );

  return { namespaceId, namespaceConfidential, parts, memories: hits, history, working };
}
