import type { ContextPlacement } from "./contract";
import { sanitizeTrustedContext } from "./sanitize";
import type { VaultRetriever, VaultSearchInput } from "../vault/retrieve";

/**
 * Vault-sourced Context Block assembly (PR #45 / vault-A5) — the vault-backed
 * `get_session_context`. Retrieved notes are markdown (already cache-friendly).
 *
 * P0 invariant #1 (cache-correctness): the assembled block is emitted AFTER the
 * cache breakpoint — `tool_result`, or `mid_conv_system` ONLY for trusted Opus-4.8
 * — and is NEVER a system message. This function takes ONLY retrieved notes; it
 * has no access to the static prefix, so it structurally cannot mutate it. The
 * byte-identity request-builder + its gate land in F3 (#60–#62); this PR upholds
 * the "never in the system prompt" half and carries note provenance.
 *
 * KFM-003: retrieved content is fenced as data inside <retrieved-memory> and is
 * never treated as instructions (a stricter sanitizer lands in F3 #78).
 */

const OPEN = "<retrieved-memory>";
const CLOSE = "</retrieved-memory>";

export interface RetrievedNote {
  readonly slug: string;
  readonly body: string;
  readonly score?: number;
}

export interface NoteProvenance {
  readonly slug: string;
  readonly score?: number;
}

export interface ContextBlock {
  /** Markdown block, emitted AFTER the cache breakpoint — never in the system prompt. */
  readonly text: string;
  readonly placement: ContextPlacement;
  readonly provenance: readonly NoteProvenance[];
}

export interface AssembleOptions {
  /** mid-conv system placement is permitted ONLY for trusted Opus-4.8 (else tool_result). */
  readonly allowMidConvSystem?: boolean;
}

/** Assemble a Context Block from retrieved notes. Pure: notes in, block out. */
export function assembleContextBlock(notes: readonly RetrievedNote[], options: AssembleOptions = {}): ContextBlock {
  const sections = notes.map((n) => {
    const head = n.score !== undefined ? `## [[${n.slug}]] (score ${n.score.toFixed(2)})` : `## [[${n.slug}]]`;
    // Sanitize: retrieved content may be elevated to a trusted mid-conv-system message.
    return `${head}\n${sanitizeTrustedContext(n.body)}`;
  });
  const inner = sections.length > 0 ? sections.join("\n\n") : "(no relevant memories)";
  return {
    text: `${OPEN}\n${inner}\n${CLOSE}`,
    // Default to the always-safe placement; mid_conv_system is opt-in for Opus-4.8 only.
    placement: options.allowMidConvSystem === true ? "mid_conv_system" : "tool_result",
    provenance: notes.map((n) => (n.score !== undefined ? { slug: n.slug, score: n.score } : { slug: n.slug })),
  };
}

const WM_OPEN = "<working-memory>";
const WM_CLOSE = "</working-memory>";

export interface WorkingMemoryBlock {
  /** Fenced conversation block, emitted AFTER the cache breakpoint — never in the system prompt. */
  readonly text: string;
  readonly placement: ContextPlacement;
}

/**
 * Assemble the session working-memory Context Block (get_session_context). Same
 * P0 #1 placement rule as the note block: `tool_result`, or `mid_conv_system`
 * ONLY for trusted Opus-4.8 — NEVER a system message. Messages are fenced as data
 * (KFM-003): the recalled conversation is context, not instructions.
 */
export function assembleWorkingMemoryBlock(
  messages: readonly { readonly role: string; readonly content: string }[],
  options: AssembleOptions = {},
): WorkingMemoryBlock {
  // Sanitize each message: working memory holds prior END-USER turns (untrusted) and
  // this block can be elevated to a trusted mid_conv_system placement (KFM-003).
  const lines = messages.map((m) => `[${m.role}] ${sanitizeTrustedContext(m.content)}`);
  const inner = lines.length > 0 ? lines.join("\n") : "(no working memory)";
  return {
    text: `${WM_OPEN}\n${inner}\n${WM_CLOSE}`,
    placement: options.allowMidConvSystem === true ? "mid_conv_system" : "tool_result",
  };
}

export interface VaultContextInput extends VaultSearchInput {
  readonly allowMidConvSystem?: boolean;
}

/**
 * get_session_context (vault-backed): retrieve relevant notes for the namespace
 * and assemble the trailing Context Block. The working-memory/session layer
 * (SessionDO) composes on top in #54.
 */
export async function getVaultContext(retriever: VaultRetriever, input: VaultContextInput): Promise<ContextBlock> {
  const hits = await retriever.search(input);
  const notes: RetrievedNote[] = [];
  for (const hit of hits) {
    if (hit.note !== null) {
      notes.push({ slug: hit.slug, body: hit.note.body, score: hit.score });
    }
  }
  return assembleContextBlock(notes, { allowMidConvSystem: input.allowMidConvSystem ?? false });
}
