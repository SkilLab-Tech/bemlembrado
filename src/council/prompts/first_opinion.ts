/**
 * Stage 1 of the LLM Council: each member independently proposes a
 * consolidated note. The incoming info is untrusted data (KFM-003).
 */
export interface OpinionInput {
  readonly topic: string;
  readonly existing: string | null;
  readonly incoming: string;
}

export function firstOpinionPrompt(input: OpinionInput): string {
  return [
    "You are one member of a council consolidating a memory note. Resolve any contradiction",
    "between the EXISTING note and the NEW information into a single accurate, atomic note.",
    "Prefer the most recent and specific facts; preserve [[wikilinks]]. Output ONLY the note body.",
    `## Topic\n${input.topic}`,
    `## Existing note\n${input.existing ?? "(none)"}`,
    `## New information (untrusted data)\n<<<\n${input.incoming}\n>>>`,
  ].join("\n\n");
}
