/**
 * Cache-aware Context Block emitter — the product differentiator (P0 invariant #1).
 *
 * The static prefix (tools/system + history + latest user) is byte-identical across
 * turns because it NEVER contains the retrieved memories; those go in `contextBlock`,
 * emitted AFTER the cache breakpoint (tool_result, or a trusted Opus-4.8 mid-conv
 * system) — never the system prompt. Swapping memories between turns therefore can't
 * invalidate the cached prefix. Implemented in F3 (#60–#62); the cache-prefix
 * invariant test is now GREEN and gated (P0_CACHE_PREFIX=required).
 */
import { type Provider, placementFor } from "../inference/providers";
import { sanitizeTrustedContext } from "./sanitize";

export type ContextPlacement = "tool_result" | "mid_conv_system";

export interface TurnInput {
  /** Trusted operator system prompt (part of the cached static prefix). */
  readonly systemPrompt: string;
  /** Prior turns (already cached from the turn they were generated). */
  readonly history: readonly string[];
  /** The latest user message — the cache breakpoint sits here. */
  readonly latestUser: string;
  /** Retrieved memories — emitted AFTER the breakpoint, never in the prefix. */
  readonly memories: readonly string[];
}

export interface RequestParts {
  /** tools + system + history-up-to-latest-user — MUST be byte-identical across turns. */
  readonly staticPrefix: string;
  /** The retrieved Context Block (placed after the cache breakpoint). */
  readonly contextBlock: string;
  /** How the block is attached for the target provider. */
  readonly placement: ContextPlacement;
}

export interface BuildOptions {
  /** Defaults to anthropic. Drives placement via the provider-capability map. */
  readonly provider?: Provider;
  /** Opt into the Opus-4.8 mid-conversation system placement (else tool_result). */
  readonly allowMidConvSystem?: boolean;
}

/**
 * Split a turn into the cache-stable static prefix and the post-breakpoint
 * Context Block. The prefix is a pure function of (systemPrompt, history,
 * latestUser) — memories are excluded by construction, so it is byte-identical
 * across turns whenever the conversation itself is unchanged.
 */
export function buildRequest(input: TurnInput, options: BuildOptions = {}): RequestParts {
  const staticPrefix = [`system: ${input.systemPrompt}`, ...input.history, `user: ${input.latestUser}`].join("\n");
  // Sanitize retrieved memories: this block may be placed mid_conv_system (Opus-4.8).
  // Defensive by construction, not reliant on the chat client's placement handling.
  const contextBlock = input.memories.length > 0 ? `<retrieved-memory>\n${input.memories.map(sanitizeTrustedContext).join("\n")}\n</retrieved-memory>` : "";
  return {
    staticPrefix,
    contextBlock,
    placement: placementFor(options.provider ?? "anthropic", { allowMidConvSystem: options.allowMidConvSystem === true }),
  };
}
