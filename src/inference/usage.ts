import type { ChatProvider } from "./client";

/**
 * Normalized token usage (turn-batch). The savings story depends on splitting
 * input tokens into fresh vs cache-read: only a provider with prompt caching
 * (Anthropic) reports cache accounting, so `cacheReported` is honest about whether
 * a savings number is even measurable from this turn.
 *
 * - fresh:      freshly processed tokens (non-cached input + output)
 * - cacheRead:  input tokens served from cache (the saving; billed ~0.1x)
 * - cacheWrite: input tokens written to cache (billed ~1.25x)
 */
export interface NormalizedUsage {
  provider: string;
  model: string | null;
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  /** true only when the provider reports cache token accounting (Anthropic). */
  cacheReported: boolean;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

interface AnthropicUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
}

interface OpenAiUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
}

/** Anthropic Messages API usage -> normalized (the only provider that reports cache tokens). */
export function normalizeAnthropicUsage(raw: unknown, model: string | null): NormalizedUsage {
  const u = (raw ?? {}) as AnthropicUsage;
  return {
    provider: "anthropic",
    model,
    fresh: num(u.input_tokens) + num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    cacheReported: true,
  };
}

/** OpenAI-style usage (Workers AI / Maritaca): no cache accounting -> honest zeros. */
export function normalizeOpenAiUsage(provider: string, raw: unknown, model: string | null): NormalizedUsage {
  const u = (raw ?? {}) as OpenAiUsage;
  const split = num(u.prompt_tokens) + num(u.completion_tokens);
  return {
    provider,
    model,
    fresh: split > 0 ? split : num(u.total_tokens),
    cacheRead: 0,
    cacheWrite: 0,
    cacheReported: false,
  };
}

/** Dispatch by the chat provider. Never throws — malformed usage -> zeros. */
export function normalizeUsage(provider: ChatProvider, raw: unknown, model: string | null): NormalizedUsage {
  if (provider === "anthropic") return normalizeAnthropicUsage(raw, model);
  return provider === "maritaca" ? normalizeOpenAiUsage("maritaca", raw, model) : normalizeOpenAiUsage("workers-ai", raw, model);
}
