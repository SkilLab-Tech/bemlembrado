import { MAX_DIMS } from "./vector-index";

/** Workers AI embedding model. bge-m3 returns 1024-dim vectors (under the 1536 cap). */
export const EMBED_MODEL = "@cf/baai/bge-m3";

/** Dimension bge-m3 emits and the Vectorize index is created with. */
export const EMBED_DIMS = 1024;

/**
 * Fail-fast guard against the live-only dim mismatch (e.g. a 1536 vector hitting a
 * 1024 index). Opt-in (NOT inside embed(), which accepts any dim <= cap) — wired at
 * the production upsert boundary; unit tests with small fake vectors stay unaffected.
 */
export function assertEmbedDims(values: number[], expected: number = EMBED_DIMS): void {
  if (values.length !== expected) {
    throw new EmbedError(`embedding dims ${String(values.length)} != expected ${String(expected)}`);
  }
}

export class EmbedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedError";
  }
}

/** Minimal structural subset of the Workers AI binding this module uses. */
export interface AiLike {
  run(model: string, inputs: { text: string | string[] }): Promise<{ data: number[][] }>;
}

/**
 * Embed a single text with bge-m3. Injected as AiLike so unit tests pass a fake
 * (Workers AI has no local Miniflare simulation). Guards: non-empty input,
 * a vector must come back, and dims must be within the Vectorize cap.
 */
export async function embed(ai: AiLike, text: string): Promise<number[]> {
  if (text.trim().length === 0) {
    throw new EmbedError("cannot embed empty text");
  }
  const result = await ai.run(EMBED_MODEL, { text });
  const vector = result.data[0];
  if (vector === undefined) {
    throw new EmbedError("no embedding returned");
  }
  if (vector.length > MAX_DIMS) {
    throw new EmbedError(`embedding dims ${String(vector.length)} exceed ${String(MAX_DIMS)}`);
  }
  return vector;
}
