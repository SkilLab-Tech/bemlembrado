import { z } from "zod";
import { BadRequest } from "../http/errors";
import { recordAudit } from "../lgpd/audit";
import { type ChatMessage, type ChatProvider, type ChatTurn, chatTurnWithFallback, type InferenceClient } from "../inference/client";
import { type NormalizedUsage, normalizeUsage } from "../inference/usage";
import type { SearchHit } from "../memory/search";
import { appendMessage } from "../session/append";
import { recordUsage, type TokenRates } from "../usage/record";
import type { Principal, ToolCoreDeps } from "./services";
import { type AssembledTurn, assembleTurn, type AssembleTurnInput } from "./turn";

/**
 * runTurn (turn-batch) — one cache-aware inference turn end to end:
 * assemble (retrieve memory + history) -> chat -> normalize usage -> persist the
 * user + assistant messages -> record usage. The provider messages keep the stable
 * prefix (system + history + latest user) ahead of the retrieved Context Block, so
 * the cacheable prefix is byte-identical across turns (P0 #1).
 */

export interface TurnDeps extends ToolCoreDeps {
  chat: InferenceClient;
}

export interface RunTurnInput extends AssembleTurnInput {
  /** The chat provider for the actual LLM call (Anthropic cache path: turn-PR7). */
  chatProvider: ChatProvider;
  rates?: TokenRates;
}

export interface RunTurnResult {
  sessionId: string;
  /** Resolved tenant-owned namespace (for post-turn curation). */
  namespaceId: string;
  reply: string;
  usage: NormalizedUsage;
  provenance: SearchHit[];
}

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

const TurnRequest = z.object({
  sessionId: z.string().min(1).max(200),
  namespace: z.string().min(1).max(200),
  message: z.string().min(1).max(8000),
  systemPrompt: z.string().min(1).max(8000).optional(),
  provider: z.enum(["anthropic", "workers-ai", "maritaca"]).optional(),
  allowMidConvSystem: z.boolean().optional(),
  topK: z.number().int().min(1).max(50).optional(),
  /** Drives chat-provider routing (pt-* + key -> Maritaca). */
  lang: z.string().max(20).optional(),
});

export type ValidatedTurnRequest = z.infer<typeof TurnRequest>;

/** Validate a /v1/turn body at the boundary. Throws BadRequest (400) on violation. */
export function parseTurnRequest(raw: unknown): ValidatedTurnRequest {
  const result = TurnRequest.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new BadRequest(detail.length > 0 ? detail : "invalid turn request");
  }
  return result.data;
}

/** Resolve a validated request + chat provider into runTurn input (fills the system-prompt default). */
export function toRunTurnInput(req: ValidatedTurnRequest, chatProvider: ChatProvider): RunTurnInput {
  return {
    sessionId: req.sessionId,
    namespace: req.namespace,
    message: req.message,
    systemPrompt: req.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    chatProvider,
    ...(req.provider !== undefined ? { provider: req.provider } : {}),
    ...(req.allowMidConvSystem !== undefined ? { allowMidConvSystem: req.allowMidConvSystem } : {}),
    ...(req.topK !== undefined ? { topK: req.topK } : {}),
  };
}

/**
 * Build provider messages: system + working history + latest user (the stable
 * prefix), THEN the retrieved Context Block as a trailing message — never in the
 * system prompt (P0 #1), so system+history stay cacheable across turns.
 */
export function buildChatMessages(assembled: AssembledTurn, systemPrompt: string, message: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  for (const m of assembled.working) {
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: "user", content: message });
  if (assembled.parts.contextBlock.length > 0) {
    messages.push({ role: "user", content: assembled.parts.contextBlock });
  }
  return messages;
}

export async function runTurn(deps: TurnDeps, principal: Principal, input: RunTurnInput): Promise<RunTurnResult> {
  const now = deps.now();
  const assembled = await assembleTurn(deps, principal, input);
  // LGPD sensitive-read trail (mig 0022): /v1/turn reads memory content AND the session's working
  // history — the biggest previously-unaudited confidential-read path. One namespace-scoped row
  // covers both. Best-effort (never throws), sourced from the resolve choke point via assembleTurn.
  await recordAudit(deps.db, principal, "read", { kind: "namespace", namespace: input.namespace }, now, assembled.namespaceConfidential);

  // Structured turn: the provider places the cache breakpoint; the Context Block
  // stays after it (P0 #1). Anthropic caches the prefix; OpenAI-style providers
  // flatten with the context trailing.
  const turn: ChatTurn = {
    system: input.systemPrompt,
    history: assembled.working.map((m) => ({ role: m.role, content: m.content })),
    user: input.message,
    ...(assembled.parts.contextBlock.length > 0 ? { context: assembled.parts.contextBlock } : {}),
  };
  const { result, provider } = await chatTurnWithFallback(deps.chat, input.chatProvider, turn);
  const usage = normalizeUsage(provider, result.usageRaw, result.model);

  // Persist the exchange (D1 source of truth + DO working memory). Only after a
  // successful completion — a failed chat leaves no half-turn.
  await appendMessage(deps, { sessionId: input.sessionId, namespaceId: assembled.namespaceId, role: "user", content: input.message, ts: now });
  await appendMessage(deps, { sessionId: input.sessionId, namespaceId: assembled.namespaceId, role: "assistant", content: result.text, ts: now + 1 });

  await recordUsage(
    deps.db,
    {
      tenantId: principal.tenantId,
      sessionId: input.sessionId,
      turn: Math.floor(assembled.working.length / 2) + 1,
      usage,
      ...(input.rates !== undefined ? { rates: input.rates } : {}),
    },
    now,
  );

  return { sessionId: input.sessionId, namespaceId: assembled.namespaceId, reply: result.text, usage, provenance: assembled.memories };
}
