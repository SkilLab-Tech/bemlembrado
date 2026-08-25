import type { Logger } from "../obs/log";
import { chairmanPrompt } from "./prompts/chairman";
import { firstOpinionPrompt } from "./prompts/first_opinion";
import { type Candidate, peerRankPrompt } from "./prompts/peer_rank";

/**
 * LLM Council write-time consolidation gate (PR #51).
 *
 * Karpathy's 3-stage council adapted to MEMORY writes: when a write is CONTESTED
 * (contradiction / low-confidence), N members each propose a consolidated note,
 * anonymously peer-rank the others, and a chairman synthesizes the canonical note.
 * This reduces hallucinated/sycophantic memories.
 *
 * OFF BY DEFAULT (cost): with the flag off — or when not contested — it is a
 * single-pass passthrough with NO model calls and NO spend. Enabling paid
 * multi-model council is an explicit, cost-estimated decision. Per-run cost is
 * always logged. Models are dependency-injected (real wiring via AI Gateway, F3).
 */

export interface CouncilConfig {
  readonly enabled: boolean;
}

export const DEFAULT_COUNCIL_CONFIG: CouncilConfig = { enabled: false };

export interface CouncilModel {
  readonly id: string;
  complete(prompt: string): Promise<string>;
}

export interface ConsolidateInput {
  readonly topic: string;
  readonly existing: string | null;
  readonly incoming: string;
  /** Caller-determined: is this write contradicting/low-confidence? */
  readonly contested: boolean;
}

export type Provenance = "single-pass" | "council";

export interface ConsolidateResult {
  readonly body: string;
  readonly consolidatedBy: Provenance;
  readonly cost: { calls: number; estUsd: number };
}

export interface ConsolidateDeps {
  config: CouncilConfig;
  members: readonly CouncilModel[];
  chairman: CouncilModel;
  logger?: Logger;
  /** Estimated USD per model call (default 0; set to the real rate in prod). */
  costPerCallUsd?: number;
}

function label(i: number): string {
  return String.fromCharCode(65 + (i % 26));
}

/** Parse a peer-rank response into the ordered list of known labels it cites. */
export function parseRanking(raw: string, validLabels: readonly string[]): string[] {
  const valid = new Set(validLabels);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.toUpperCase().match(/[A-Z]/g) ?? []) {
    if (valid.has(token) && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/** Borda-count the members' rankings; tie-break by original candidate order. */
function aggregate(candidates: readonly Candidate[], rankings: readonly string[]): Candidate[] {
  const labels = candidates.map((c) => c.label);
  const score = new Map<string, number>(labels.map((l) => [l, 0]));
  for (const ranking of rankings) {
    const ordered = parseRanking(ranking, labels);
    ordered.forEach((l, pos) => score.set(l, (score.get(l) ?? 0) + (labels.length - pos)));
  }
  return [...candidates].sort((a, b) => {
    const diff = (score.get(b.label) ?? 0) - (score.get(a.label) ?? 0);
    return diff !== 0 ? diff : labels.indexOf(a.label) - labels.indexOf(b.label);
  });
}

export async function consolidate(deps: ConsolidateDeps, input: ConsolidateInput): Promise<ConsolidateResult> {
  // Single-pass: flag off, not contested, or no council members configured.
  if (!deps.config.enabled || !input.contested || deps.members.length === 0) {
    return { body: input.incoming, consolidatedBy: "single-pass", cost: { calls: 0, estUsd: 0 } };
  }

  const opinionInput = { topic: input.topic, existing: input.existing, incoming: input.incoming };

  // Stage 1 — first opinions.
  const opinions = await Promise.all(deps.members.map((m) => m.complete(firstOpinionPrompt(opinionInput))));
  const candidates: Candidate[] = opinions.map((body, i) => ({ label: label(i), body: body.trim() }));

  // Stage 2 — anonymized peer ranking.
  const rankings = await Promise.all(deps.members.map((m) => m.complete(peerRankPrompt(candidates))));
  const ranked = aggregate(candidates, rankings);

  // Stage 3 — chairman synthesis.
  const body = (await deps.chairman.complete(chairmanPrompt(opinionInput, ranked))).trim();

  const calls = deps.members.length * 2 + 1;
  const cost = { calls, estUsd: calls * (deps.costPerCallUsd ?? 0) };
  deps.logger?.log("info", "council run", { topic: input.topic, members: deps.members.length, calls, est_usd: cost.estUsd });

  return { body, consolidatedBy: "council", cost };
}
