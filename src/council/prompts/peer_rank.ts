/**
 * Stage 2 of the LLM Council: each member anonymously ranks the candidate
 * notes. Candidates are presented by opaque label so a model cannot favor "its own".
 */
export interface Candidate {
  readonly label: string;
  readonly body: string;
}

export function peerRankPrompt(candidates: readonly Candidate[]): string {
  const list = candidates.map((c) => `### ${c.label}\n${c.body}`).join("\n\n");
  return [
    "Anonymously rank these candidate consolidated notes from best to worst by accuracy and",
    'contradiction-resolution. Respond with ONLY a JSON array of labels, best first, e.g. ["B","A"].',
    list,
  ].join("\n\n");
}
