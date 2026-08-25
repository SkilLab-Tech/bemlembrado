import type { ContextPlacement } from "../context/contract";

/**
 * Provider-capability map (PR #56 / F3-01) — the source of truth for HOW the
 * cache-aware Context Block is emitted per provider (P0 invariant #1).
 *
 * ICP order is pt-BR → en-US → es-LATAM, so Maritaca (pt-BR specialist) is a
 * first-class provider alongside Workers AI (multilingual default/fallback) and
 * Anthropic (premium, the only one with explicit cache_control + a trusted
 * mid-conversation system message on Opus-4.8).
 */

export type Provider = "anthropic" | "workers-ai" | "maritaca";

export interface ProviderCapabilities {
  readonly id: Provider;
  /** Honors explicit cache_control breakpoints (Anthropic prompt caching). */
  readonly supportsCacheControl: boolean;
  /** Accepts a trusted mid-conversation system message (Anthropic Opus-4.8 only). */
  readonly supportsMidConvSystem: boolean;
  /** Relies on implicit prefix caching via session affinity (Workers AI). */
  readonly implicitPrefixCache: boolean;
}

export const PROVIDERS: Record<Provider, ProviderCapabilities> = {
  anthropic: { id: "anthropic", supportsCacheControl: true, supportsMidConvSystem: true, implicitPrefixCache: false },
  "workers-ai": { id: "workers-ai", supportsCacheControl: false, supportsMidConvSystem: false, implicitPrefixCache: true },
  maritaca: { id: "maritaca", supportsCacheControl: false, supportsMidConvSystem: false, implicitPrefixCache: false },
};

/**
 * Where the retrieved Context Block goes for a provider. mid_conv_system is used
 * ONLY when the provider supports it AND the caller opts in (trusted Opus-4.8);
 * everything else gets the always-safe tool_result. NEVER the system prompt.
 */
export function placementFor(provider: Provider, opts: { allowMidConvSystem?: boolean } = {}): ContextPlacement {
  return PROVIDERS[provider].supportsMidConvSystem && opts.allowMidConvSystem === true ? "mid_conv_system" : "tool_result";
}
