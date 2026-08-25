import { z } from "zod";
import { buildCuratePrompt } from "../../prompts/curate_note";
import type { Db } from "../db/client";
import type { Logger } from "../obs/log";
import type { NoteGraph } from "./graph";
import { parseLinks } from "./graph";
import type { Note, VaultStore } from "./store";
import { NOTE_TYPES } from "./store";

/**
 * LLM-Wiki curator (PR #43 / vault-A3) — the core of the do-it-all memory model.
 *
 * On an incoming episode the LLM DECIDES: create a new atomic note OR update an
 * existing related one, maintaining [[wikilinks]] + the MEMORY.md-style index.
 * The user does nothing. The model output is schema-validated BEFORE any R2/D1
 * write — invalid output is rejected + logged and NOTHING is persisted (KFM-004).
 * The episode text is untrusted data, never treated as instructions (KFM-003).
 *
 * The chat model is dependency-injected (ChatLike) — Workers AI / AI Gateway has
 * no local sim; the real binding is wired by the inference client.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const decisionSchema = z.object({
  action: z.enum(["create", "update"]),
  slug: z.string().regex(SLUG_RE),
  type: z.enum(NOTE_TYPES),
  body: z.string().min(1),
});

export type CuratorDecision = z.infer<typeof decisionSchema>;

export class CuratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CuratorError";
  }
}

/** Minimal text-completion seam (real impl wraps Workers AI / AI Gateway in F3). */
export interface ChatLike {
  complete(prompt: string): Promise<string>;
}

export interface CuratorDeps {
  vault: VaultStore;
  graph: NoteGraph;
  db: Db;
  chat: ChatLike;
  logger?: Logger;
  /** Optional write-path hook: index the note's chunks for retrieval. */
  indexVectors?: (namespaceId: string, slug: string, body: string) => Promise<void>;
}

export interface CurateInput {
  tenantId: string;
  namespaceId: string;
  episode: { id: string; text: string };
  now: number;
}

export interface CurateResult {
  decision: CuratorDecision;
  note: Note;
  version: string;
}

/** Extract and schema-validate the curator's JSON decision. Throws on anything off. */
export function parseDecision(raw: string): CuratorDecision {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (match === null) {
    throw new CuratorError("curator output contained no JSON object");
  }
  let json: unknown;
  try {
    json = JSON.parse(match[0]);
  } catch {
    throw new CuratorError("curator output was not valid JSON");
  }
  const parsed = decisionSchema.safeParse(json);
  if (!parsed.success) {
    throw new CuratorError(`curator output failed schema: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  return parsed.data;
}

/**
 * Curate one episode into the vault: prompt the model, validate, then write the
 * note to R2 + mirror it in the D1 graph + rebuild the namespace index.
 */
export async function curate(deps: CuratorDeps, input: CurateInput): Promise<CurateResult> {
  const existing = await deps.db.listNotesByNamespace(input.namespaceId);
  const prompt = buildCuratePrompt({
    episodeText: input.episode.text,
    existingNotes: existing.map((n) => ({ slug: n.slug, type: n.type })),
  });

  const raw = await deps.chat.complete(prompt);

  let decision: CuratorDecision;
  try {
    decision = parseDecision(raw);
  } catch (err) {
    // Reject + log; persist NOTHING (KFM-004).
    deps.logger?.log("warn", "curator output rejected", {
      namespace_id: input.namespaceId,
      episode_id: input.episode.id,
      reason: err instanceof Error ? err.message : "unknown",
    });
    throw err;
  }

  const prior = decision.action === "update" ? await deps.db.getNoteBySlug(input.namespaceId, decision.slug) : null;
  // Deterministic, globally-unique id: namespace is unique, slug is unique within it.
  const id = prior?.id ?? `${input.namespaceId}:${decision.slug}`;
  const note: Note = {
    slug: decision.slug,
    frontmatter: {
      id,
      type: decision.type,
      created_at: prior?.created_at ?? input.now,
      updated_at: input.now,
      source_episode: input.episode.id,
      links: parseLinks(decision.body),
    },
    body: decision.body,
  };

  const put = await deps.vault.putNote(input.tenantId, input.namespaceId, note);
  await deps.graph.indexNote(
    input.namespaceId,
    {
      id,
      slug: note.slug,
      type: note.frontmatter.type,
      r2Key: put.key,
      createdAt: note.frontmatter.created_at,
      updatedAt: note.frontmatter.updated_at,
    },
    note.body,
  );
  await deps.indexVectors?.(input.namespaceId, note.slug, note.body);
  await rebuildIndex(deps, input.tenantId, input.namespaceId);

  return { decision, note, version: put.version };
}

/** Regenerate the MEMORY.md-style index from the D1 note mirror. */
async function rebuildIndex(deps: CuratorDeps, tenantId: string, namespaceId: string): Promise<void> {
  const notes = await deps.db.listNotesByNamespace(namespaceId);
  const lines = ["# Memory index", "", ...notes.map((n) => `- [[${n.slug}]] (${n.type})`)];
  await deps.vault.putIndex(tenantId, namespaceId, `${lines.join("\n")}\n`);
}
