import type { Db } from "../db/client";
import { createLogger } from "../obs/log";
import { type ChatLike, curate } from "../vault/curator";
import { NoteGraph } from "../vault/graph";
import type { VaultStore } from "../vault/store";

/**
 * Post-turn curation (turn-batch). After a turn completes, optionally fold the
 * exchange into the LLM-Wiki vault as an atomic note (the "self-organizing memory"
 * differentiator). BEST-EFFORT: never throws — a curation failure must not affect
 * the turn response the caller already received. Flag-gated by the caller
 * (CURATOR_ENABLED); uses Workers AI (free) with single-attempt fallback.
 *
 * Vector indexing of the note (for retrieval) is wired separately with the notes
 * search endpoint; here the note is written to R2 + mirrored in the D1 graph.
 */

export interface CurateTurnDeps {
  db: Db;
  vault: VaultStore;
  chat: ChatLike;
  /** Index the curated note's chunks for retrieval (note: vector namespace). Optional. */
  indexVectors?: (namespaceId: string, slug: string, body: string) => Promise<void>;
}

export interface CurateTurnInput {
  tenantId: string;
  namespaceId: string;
  episodeId: string;
  /** The exchange text to curate (user message + assistant reply). */
  text: string;
  now: number;
}

export async function curateTurn(deps: CurateTurnDeps, input: CurateTurnInput): Promise<void> {
  try {
    await curate(
      {
        db: deps.db,
        vault: deps.vault,
        graph: new NoteGraph(deps.db),
        chat: deps.chat,
        ...(deps.indexVectors !== undefined ? { indexVectors: deps.indexVectors } : {}),
      },
      { tenantId: input.tenantId, namespaceId: input.namespaceId, episode: { id: input.episodeId, text: input.text }, now: input.now },
    );
  } catch (err) {
    createLogger().log("warn", "post-turn curation failed (best-effort; turn unaffected)", {
      namespace_id: input.namespaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
