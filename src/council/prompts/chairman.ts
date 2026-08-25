import type { Candidate } from "./peer_rank";
import type { OpinionInput } from "./first_opinion";

/**
 * Stage 3 of the LLM Council: the chairman synthesizes the single canonical
 * note from the peer-ranked candidates, favoring the top-ranked.
 */
export function chairmanPrompt(input: OpinionInput, ranked: readonly Candidate[]): string {
  const list = ranked.map((c, i) => `### Rank ${String(i + 1)} (${c.label})\n${c.body}`).join("\n\n");
  return [
    "You are the council chairman. Synthesize the single canonical consolidated note from the",
    "ranked candidates below, favoring the top-ranked. Output ONLY the final note body.",
    `## Topic\n${input.topic}`,
    list,
  ].join("\n\n");
}
