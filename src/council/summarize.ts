import type { ChatProvider, InferenceClient } from "../inference/client";
import type { Logger } from "../obs/log";
import { tokenize } from "./candidates";

/**
 * Single-model consolidation summarizer.
 *
 * When candidate selection flags an incoming write CONTESTED against an
 * existing note, this merges the two into ONE canonical note via a single chat
 * call on the free default provider (Workers AI). It is the cheap path used when
 * only one model is configured — distinct from the multi-model council in
 * consolidate.ts, which is worth its ~Nx cost only when members actually differ.
 *
 * SAFETY (the reason single-pass "take the incoming write" is wrong): a naive
 * overwrite silently DROPS still-valid facts from the existing note. So the model
 * output is GUARDED — it must be non-empty, size-bounded, and retain the salient
 * tokens of BOTH sides. If the model fails or the output fails the guard, we fall
 * back to a deterministic loss-free merge (existing + incoming). Never worse than
 * not consolidating; never drops a fact.
 */

export interface SummarizeInput {
  /** Topic/subject label — for the prompt + logs (e.g. the namespace or entity). */
  readonly topic: string;
  /** The existing note being refined. */
  readonly existing: string;
  /** The new (contested) write. */
  readonly incoming: string;
}

export interface SummarizeResult {
  /** The consolidated note to store. */
  readonly body: string;
  /** True when the model output passed the guard; false when we used the fallback merge. */
  readonly valid: boolean;
}

export interface SummarizeDeps {
  readonly client: InferenceClient;
  /** Default: workers-ai (free tier). */
  readonly provider?: ChatProvider;
  /** Reject (and fall back) if the model output exceeds this. Default 8192. */
  readonly maxOutputChars?: number;
  /** Min fraction of each side's salient tokens the output must retain. Default 0.5. */
  readonly minRetention?: number;
  readonly logger?: Logger;
}

const MAX_OUTPUT_CHARS = 8192;
const MIN_RETENTION = 0.5;

/** Deterministic, loss-free merge used when the model output is unavailable or rejected. */
export function fallbackMerge(existing: string, incoming: string): string {
  const a = existing.trim();
  const b = incoming.trim();
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  return `${a}\n${b}`;
}

/** Fraction of `reference`'s salient tokens present in `body` (1 when reference is empty). */
function retention(body: Set<string>, reference: Set<string>): number {
  if (reference.size === 0) return 1;
  let hits = 0;
  for (const t of reference) {
    if (body.has(t)) hits += 1;
  }
  return hits / reference.size;
}

/**
 * Guard a consolidated note: non-empty, within the size cap, and retaining at least
 * `minRetention` of BOTH the existing and incoming salient tokens. This is what makes
 * consolidation safe — an output that dropped either side's facts is rejected.
 */
export function isValidConsolidation(
  body: string,
  existing: string,
  incoming: string,
  maxChars = MAX_OUTPUT_CHARS,
  minRetention = MIN_RETENTION,
): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) return false;
  const out = tokenize(trimmed);
  return (
    retention(out, tokenize(existing)) >= minRetention &&
    retention(out, tokenize(incoming)) >= minRetention
  );
}

/** Prompt: merge two notes into one, keep every still-valid fact, newer value wins on conflict. */
export function consolidationPrompt(input: SummarizeInput): string {
  return [
    `You maintain a memory note about "${input.topic}".`,
    "Merge the EXISTING note and the NEW information into ONE concise, factual note.",
    "Rules:",
    "- Keep EVERY still-valid fact from both. Do not drop information.",
    "- If they conflict on the same attribute, prefer the NEW value.",
    "- Write in the same language as the inputs. Output only the merged note — no preamble.",
    "",
    `EXISTING:\n${input.existing}`,
    "",
    `NEW:\n${input.incoming}`,
  ].join("\n");
}

/**
 * Produce the consolidated note. One chat call on `provider` (default Workers AI);
 * the output is guarded and, on model error or a failed guard, replaced by the
 * deterministic loss-free merge so a bad model never destroys a stored fact.
 */
export async function summarizeConsolidation(deps: SummarizeDeps, input: SummarizeInput): Promise<SummarizeResult> {
  const provider = deps.provider ?? "workers-ai";
  const maxChars = deps.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const minRetention = deps.minRetention ?? MIN_RETENTION;

  let raw: string;
  try {
    raw = await deps.client.complete(provider, consolidationPrompt(input));
  } catch (err) {
    deps.logger?.log("warn", "consolidation summarize failed — fallback merge", {
      topic: input.topic,
      error: err instanceof Error ? err.message : "unknown",
    });
    return { body: fallbackMerge(input.existing, input.incoming), valid: false };
  }

  const body = raw.trim();
  if (isValidConsolidation(body, input.existing, input.incoming, maxChars, minRetention)) {
    return { body, valid: true };
  }
  deps.logger?.log("warn", "consolidation output rejected by guard — fallback merge", { topic: input.topic });
  return { body: fallbackMerge(input.existing, input.incoming), valid: false };
}
