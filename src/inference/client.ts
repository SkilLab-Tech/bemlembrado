import type { CouncilModel } from "../council/consolidate";
import type { Env } from "../env";
import type { AiLike } from "../memory/embed";
import type { ChatLike } from "../vault/curator";

/**
 * Inference client (PR #63 / F3-08) — real chat completion across providers.
 *
 * - Workers AI via the `env.AI` binding (free default/fallback, multilingual),
 *   optionally routed through an AI Gateway for caching/observability.
 * - Maritaca via its OpenAI-compatible HTTP API (pt-BR specialist, our #1 ICP).
 * Anthropic premium (with explicit cache_control) is wired in #64.
 *
 * Both backends are dependency-injected (no local Miniflare sim for Workers AI),
 * so unit tests fake them; the live binding/key arrive at the worker boundary.
 */

/**
 * Workers AI default/fallback chat model. `@cf/meta/llama-3.1-8b-instruct` was
 * DEPRECATED by Cloudflare on 2026-05-30 (live error 5028), which surfaced as the
 * /v1/turn 500. Replaced with GLM-4.7-flash: current + non-deprecated, cheap/fast
 * (the free default tier), 128k context, and strong pt-BR — our #1 ICP. Override
 * per request via the `provider` route (Anthropic/Maritaca) when a tenant opts in.
 */
export const WORKERS_AI_CHAT_MODEL = "@cf/zai-org/glm-4.7-flash";
export const MARITACA_MODEL = "sabiazinho-3";
const MARITACA_URL = "https://chat.maritaca.ai/api/chat/completions";
/** Cheap Claude that supports prompt caching — the default for the cache-aware turn. */
export const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export type ChatProvider = "workers-ai" | "maritaca" | "anthropic";

export class InferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferenceError";
  }
}

/** Structural subset of the Workers AI binding used for chat. */
export interface AiChatBinding {
  run(
    model: string,
    inputs: { messages: { role: string; content: string }[] },
    options?: { gateway?: { id: string } },
  ): Promise<{ response?: string; choices?: { message?: { content?: string } }[]; usage?: unknown }>;
}

/** A provider-agnostic chat message. The Context Block is carried as its own message. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/** Chat result carrying the raw provider usage (normalized by normalizeUsage downstream). */
export interface ChatResult {
  text: string;
  usageRaw: unknown;
  model: string;
}

/**
 * A structured turn for the cache-aware path. Separating the stable prefix
 * (system + history + user) from the retrieved `context` lets each provider place
 * the cache breakpoint correctly: Anthropic puts cache_control on the user block
 * and leaves the context block AFTER it uncached, so the prefix caches across turns
 * while swapped memories never invalidate it (P0 #1).
 */
export interface ChatTurn {
  system: string;
  history: ChatMessage[];
  user: string;
  context?: string;
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface InferenceDeps {
  ai?: AiChatBinding;
  maritacaKey?: string;
  anthropicKey?: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** AI Gateway id for the Workers AI path (optional). */
  gatewayId?: string;
}

export class InferenceClient {
  constructor(private readonly deps: InferenceDeps) {}

  complete(provider: ChatProvider, prompt: string): Promise<string> {
    return provider === "maritaca" ? this.maritaca(prompt) : this.workersAi(prompt);
  }

  /**
   * Flat messages chat (OpenAI-style providers). Anthropic has no flat path — its
   * cache breakpoint needs structure, so route Anthropic through chatTurn().
   */
  chat(provider: ChatProvider, messages: ChatMessage[]): Promise<ChatResult> {
    return provider === "maritaca" ? this.maritacaChat(messages) : this.workersAiChat(messages);
  }

  /**
   * Cache-aware structured turn. Anthropic places the cache breakpoint on the user
   * block and leaves the retrieved context AFTER it (uncached); the OpenAI-style
   * providers flatten to [system, ...history, user, context?] (context trailing).
   */
  chatTurn(provider: ChatProvider, turn: ChatTurn): Promise<ChatResult> {
    if (provider === "anthropic") return this.anthropicTurn(turn);
    return this.chat(provider, flatten(turn));
  }

  private async anthropicTurn(turn: ChatTurn): Promise<ChatResult> {
    if (this.deps.anthropicKey === undefined || this.deps.anthropicKey.length === 0) {
      throw new InferenceError("Anthropic key unavailable");
    }
    const doFetch = this.deps.fetchImpl ?? fetch;
    // Final user message: the question carries the cache_control breakpoint; the
    // retrieved context block follows it WITHOUT a marker, so it is never cached.
    const userBlocks: AnthropicTextBlock[] = [{ type: "text", text: turn.user, cache_control: { type: "ephemeral" } }];
    if (turn.context !== undefined && turn.context.length > 0) {
      userBlocks.push({ type: "text", text: turn.context });
    }
    const messages = [
      ...turn.history.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
      { role: "user", content: userBlocks },
    ];
    let res: Response;
    try {
      res = await doFetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.deps.anthropicKey, "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 1024, system: turn.system, messages }),
      });
    } catch (err) {
      throw new InferenceError(`Anthropic request failed: ${errMessage(err)}`);
    }
    if (!res.ok) throw new InferenceError(`Anthropic HTTP ${String(res.status)}`);
    const raw: unknown = await res.json();
    const data = raw as { content?: { text?: string }[]; usage?: unknown };
    return { text: (data.content ?? []).map((b) => b.text ?? "").join(""), usageRaw: data.usage, model: ANTHROPIC_MODEL };
  }

  private async workersAiChat(messages: ChatMessage[]): Promise<ChatResult> {
    if (this.deps.ai === undefined) throw new InferenceError("Workers AI binding unavailable");
    const options = this.deps.gatewayId !== undefined ? { gateway: { id: this.deps.gatewayId } } : undefined;
    // Wrap the binding call: a raw throw from env.AI.run (bad input shape, model
    // error, quota) must surface as an InferenceError so chatTurnWithFallback can
    // engage and the cause is captured rather than swallowed into an opaque 500.
    let res;
    try {
      res = await this.deps.ai.run(WORKERS_AI_CHAT_MODEL, { messages: messages.map((m) => ({ role: m.role, content: m.content })) }, options);
    } catch (err) {
      throw new InferenceError(`Workers AI chat failed: ${errMessage(err)}`);
    }
    return { text: res.response ?? res.choices?.[0]?.message?.content ?? "", usageRaw: res.usage, model: WORKERS_AI_CHAT_MODEL };
  }

  private async maritacaChat(messages: ChatMessage[]): Promise<ChatResult> {
    if (this.deps.maritacaKey === undefined || this.deps.maritacaKey.length === 0) {
      throw new InferenceError("Maritaca key unavailable");
    }
    const doFetch = this.deps.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(MARITACA_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.deps.maritacaKey}` },
        body: JSON.stringify({ model: MARITACA_MODEL, messages }),
      });
    } catch (err) {
      throw new InferenceError(`Maritaca request failed: ${errMessage(err)}`);
    }
    if (!res.ok) throw new InferenceError(`Maritaca HTTP ${String(res.status)}`);
    const raw: unknown = await res.json();
    const data = raw as { choices?: { message?: { content?: string } }[]; usage?: unknown };
    return { text: data.choices?.[0]?.message?.content ?? "", usageRaw: data.usage, model: MARITACA_MODEL };
  }

  private async workersAi(prompt: string): Promise<string> {
    if (this.deps.ai === undefined) throw new InferenceError("Workers AI binding unavailable");
    const options = this.deps.gatewayId !== undefined ? { gateway: { id: this.deps.gatewayId } } : undefined;
    let res;
    try {
      res = await this.deps.ai.run(WORKERS_AI_CHAT_MODEL, { messages: [{ role: "user", content: prompt }] }, options);
    } catch (err) {
      throw new InferenceError(`Workers AI completion failed: ${errMessage(err)}`);
    }
    // Workers AI returns either the native {response} or the OpenAI-style {choices}.
    return res.response ?? res.choices?.[0]?.message?.content ?? "";
  }

  private async maritaca(prompt: string): Promise<string> {
    if (this.deps.maritacaKey === undefined || this.deps.maritacaKey.length === 0) {
      throw new InferenceError("Maritaca key unavailable");
    }
    const doFetch = this.deps.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(MARITACA_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.deps.maritacaKey}` },
        body: JSON.stringify({ model: MARITACA_MODEL, messages: [{ role: "user", content: prompt }] }),
      });
    } catch (err) {
      throw new InferenceError(`Maritaca request failed: ${errMessage(err)}`);
    }
    if (!res.ok) throw new InferenceError(`Maritaca HTTP ${String(res.status)}`);
    const raw: unknown = await res.json();
    const data = raw as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
}

/**
 * Flatten a structured turn to OpenAI-style messages. The retrieved Context Block is
 * appended INTO the final user message (not a separate trailing user message): the
 * Llama/OpenAI chat templates reject consecutive same-role turns, which caused a live
 * Workers AI 500. Merging is still P0 #1-safe — the cacheable prefix is [system,
 * ...history] (everything BEFORE the current turn), and the context never enters
 * history (only the bare question is persisted), so swapping memories can't mutate it.
 */
function flatten(turn: ChatTurn): ChatMessage[] {
  const ctx = turn.context;
  const userContent = ctx !== undefined && ctx.length > 0 ? `${turn.user}\n\n${ctx}` : turn.user;
  return [{ role: "system", content: turn.system }, ...turn.history, { role: "user", content: userContent }];
}

/** Best-effort message extraction for wrapping unknown throwables (no `String(obj)`). */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

function hasKey(key: string | undefined): boolean {
  return typeof key === "string" && key.length > 0;
}

/**
 * ICP routing (key-blind): pt-BR → Maritaca, everything else → Workers AI.
 * Prefer resolveChatProvider() on real request paths — it also checks key presence.
 */
export function providerForLanguage(lang: string): ChatProvider {
  return lang.toLowerCase().startsWith("pt") ? "maritaca" : "workers-ai";
}

/**
 * KEY-AWARE routing. An explicit `requested` provider wins only if its key is
 * present (Anthropic = premium, opt-in); otherwise pt-* + a Maritaca key → Maritaca,
 * else Workers AI. Never returns a provider whose key/binding is missing.
 */
export function resolveChatProvider(
  env: Pick<Env, "MARITACA_API_KEY" | "ANTHROPIC_API_KEY">,
  lang: string,
  requested?: ChatProvider,
): ChatProvider {
  if (requested === "anthropic" && hasKey(env.ANTHROPIC_API_KEY)) return "anthropic";
  if (requested === "maritaca" && hasKey(env.MARITACA_API_KEY)) return "maritaca";
  if (requested === "workers-ai") return "workers-ai";
  return lang.toLowerCase().startsWith("pt") && hasKey(env.MARITACA_API_KEY) ? "maritaca" : "workers-ai";
}

export interface InferenceBundle {
  /** env.AI as the embedding seam (bge-m3). */
  embedAi: AiLike;
  /** chat client (Workers AI + optional Maritaca). */
  chat: InferenceClient;
}

/**
 * Single factory so handlers never hand-cast env.AI into the two structurally
 * different seams (embed vs chat). Throws if Workers AI is unavailable (embeddings
 * are mandatory). Maritaca key + gateway id are passed through when present.
 */
export function buildInferenceDeps(env: Env, overrides: { anthropicKey?: string; maritacaKey?: string } = {}): InferenceBundle {
  if (env.AI === undefined) throw new InferenceError("Workers AI binding unavailable");
  // Managed BYOK: a tenant's own key overrides the platform key for that provider.
  const anthropicKey = overrides.anthropicKey ?? env.ANTHROPIC_API_KEY;
  const maritacaKey = overrides.maritacaKey ?? env.MARITACA_API_KEY;
  return {
    embedAi: env.AI,
    chat: new InferenceClient({
      ai: env.AI,
      ...(maritacaKey !== undefined ? { maritacaKey } : {}),
      ...(anthropicKey !== undefined ? { anthropicKey } : {}),
      ...(env.CF_AIGATEWAY_ID !== undefined ? { gatewayId: env.CF_AIGATEWAY_ID } : {}),
    }),
  };
}

/**
 * Single-attempt provider fallback: try the primary chat provider; if it raises an
 * InferenceError (provider unavailable), retry ONCE on Workers AI. Never changes
 * placement or persists anything — it only swaps the chat provider for this call.
 */
export async function completeWithFallback(client: InferenceClient, primary: ChatProvider, prompt: string): Promise<string> {
  try {
    return await client.complete(primary, prompt);
  } catch (err) {
    if (primary !== "workers-ai" && err instanceof InferenceError) {
      return client.complete("workers-ai", prompt);
    }
    throw err;
  }
}

/** Adapt the client to the curator's ChatLike + the council's CouncilModel seam. */
export function chatModel(client: InferenceClient, provider: ChatProvider): ChatLike & CouncilModel {
  return { id: provider, complete: (prompt: string) => client.complete(provider, prompt) };
}

/** A ChatLike that retries once on Workers AI if the primary provider is unavailable. */
export function chatModelWithFallback(client: InferenceClient, primary: ChatProvider): ChatLike {
  return { complete: (prompt: string) => completeWithFallback(client, primary, prompt) };
}

export interface FallbackTurnResult {
  result: ChatResult;
  /** The provider that actually served the turn (may differ from `primary` after a fallback). */
  provider: ChatProvider;
}

/**
 * Single-attempt turn fallback: try the primary provider; if it raises an
 * InferenceError (provider/key unavailable, 5xx), retry ONCE on Workers AI (the
 * always-available default). Returns the provider that actually served the turn so
 * usage is normalized against the real backend. Re-raises non-InferenceError.
 */
export async function chatTurnWithFallback(client: InferenceClient, primary: ChatProvider, turn: ChatTurn): Promise<FallbackTurnResult> {
  try {
    return { result: await client.chatTurn(primary, turn), provider: primary };
  } catch (err) {
    if (primary !== "workers-ai" && err instanceof InferenceError) {
      return { result: await client.chatTurn("workers-ai", turn), provider: "workers-ai" };
    }
    throw err;
  }
}
