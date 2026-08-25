/**
 * Retrieval-relevance eval harness.
 *
 * A golden set of retrieval cases + standard IR metrics (precision@k, recall, MRR)
 * over a dependency-injected retriever. The harness is real and executable; the
 * SCORES are only as real as the retriever passed in. Unit tests exercise it with a
 * deterministic fake retriever (metrics correctness). REAL relevance numbers require
 * live embeddings + Vectorize — run `runRetrievalEval` against a staging retriever
 * that seeds each case's corpus and calls search_memory (see docs/retrieval-eval.md).
 *
 * This is also the A/B rig for the AutoRAG-vs-Vectorize decision (docs/decisions/
 * ai-search-autorag.md): swap the retriever, re-run the same golden set, compare.
 */

export interface RetrievalCase {
  readonly id: string;
  /** Namespace the corpus is seeded into (isolation-per-case). */
  readonly namespace: string;
  /** The corpus to seed before querying (memory id → text). */
  readonly corpus: readonly { readonly id: string; readonly text: string }[];
  readonly query: string;
  /** Ground-truth relevant memory ids for the query. */
  readonly relevantIds: readonly string[];
}

export interface CaseScore {
  readonly id: string;
  readonly precisionAtK: number;
  readonly recall: number;
  readonly reciprocalRank: number;
}

export interface RetrievalReport {
  readonly k: number;
  readonly cases: readonly CaseScore[];
  readonly meanPrecisionAtK: number;
  readonly meanRecall: number;
  readonly mrr: number;
}

/** Returns ranked memory ids for a (namespace, query), best first. */
export type Retriever = (namespace: string, query: string, k: number) => Promise<string[]>;

/** ≥5 golden cases (en + pt-BR). Corpus ids are the ground truth for each query. */
export const GOLDEN_RETRIEVAL_CASES: readonly RetrievalCase[] = [
  {
    id: "billing-pref",
    namespace: "eval-billing",
    corpus: [
      { id: "m1", text: "The customer prefers to pay via PIX." },
      { id: "m2", text: "The customer's favorite color is blue." },
      { id: "m3", text: "Invoices are sent on the first of the month." },
    ],
    query: "How does the customer like to pay?",
    relevantIds: ["m1"],
  },
  {
    id: "contact-channel",
    namespace: "eval-contact",
    corpus: [
      { id: "m1", text: "Reach Ana by email, she ignores phone calls." },
      { id: "m2", text: "Ana works in the São Paulo office." },
      { id: "m3", text: "Ana prefers email for all communication." },
    ],
    query: "What is the best way to contact Ana?",
    relevantIds: ["m1", "m3"],
  },
  {
    id: "plano-assinatura",
    namespace: "eval-plano",
    corpus: [
      { id: "m1", text: "O cliente está no plano Pro anual." },
      { id: "m2", text: "O cliente mora no Rio de Janeiro." },
      { id: "m3", text: "A renovação do plano acontece em agosto." },
    ],
    query: "Qual é o plano de assinatura do cliente?",
    relevantIds: ["m1"],
  },
  {
    id: "deadline",
    namespace: "eval-deadline",
    corpus: [
      { id: "m1", text: "The project must ship by 2026-08-01." },
      { id: "m2", text: "The design review is scheduled for July." },
      { id: "m3", text: "The team stand-up is every morning." },
    ],
    query: "When is the project deadline?",
    relevantIds: ["m1"],
  },
  {
    id: "restricao-alimentar",
    namespace: "eval-dieta",
    corpus: [
      { id: "m1", text: "O convidado é alérgico a amendoim." },
      { id: "m2", text: "O convidado gosta de música ao vivo." },
      { id: "m3", text: "Evitar pratos com amendoim no cardápio." },
    ],
    query: "Há alguma restrição alimentar do convidado?",
    relevantIds: ["m1", "m3"],
  },
  {
    // Selectivity: 1 relevant fact buried in 6 distractors that all share the query's
    // vocabulary (turn/plan/month/quota/limit). Only m1 states the actual cap. A naive or
    // over-eager retriever recalls the fact but drags in near-misses — precision@k is the
    // signal that separates a discriminating retriever from an indiscriminate one here.
    id: "selectivity-quota",
    namespace: "eval-selectivity",
    corpus: [
      { id: "m1", text: "The customer's plan caps them at 10000 turns per month." },
      { id: "m2", text: "The customer upgraded from the free plan last quarter." },
      { id: "m3", text: "The customer asked about turn limits during onboarding." },
      { id: "m4", text: "Turn usage resets at the start of each calendar month." },
      { id: "m5", text: "The customer's monthly invoice is sent by email." },
      { id: "m6", text: "The team discussed raising plan limits next year." },
      { id: "m7", text: "The customer rarely exceeds half their monthly quota." },
    ],
    query: "What is the customer's monthly turn cap?",
    relevantIds: ["m1"],
  },
];

/** Fraction of the top-k ranked ids that are relevant (denominator = k). */
export function precisionAtK(ranked: readonly string[], relevant: readonly string[], k: number): number {
  if (k <= 0) return 0;
  const rel = new Set(relevant);
  const hits = ranked.slice(0, k).filter((id) => rel.has(id)).length;
  return hits / k;
}

/** Fraction of relevant ids that appear anywhere in the ranking. */
export function recall(ranked: readonly string[], relevant: readonly string[]): number {
  if (relevant.length === 0) return 1;
  const found = new Set(ranked);
  const hits = relevant.filter((id) => found.has(id)).length;
  return hits / relevant.length;
}

/** 1 / (rank of the first relevant id); 0 if none is retrieved. */
export function reciprocalRank(ranked: readonly string[], relevant: readonly string[]): number {
  const rel = new Set(relevant);
  for (let i = 0; i < ranked.length; i += 1) {
    const id = ranked[i];
    if (id !== undefined && rel.has(id)) return 1 / (i + 1);
  }
  return 0;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Run the golden set through a retriever and aggregate the metrics. The retriever
 * is responsible for the corpus being queryable (a staging harness seeds each case's
 * corpus first); this function only ranks-and-scores.
 */
export async function runRetrievalEval(
  retriever: Retriever,
  cases: readonly RetrievalCase[] = GOLDEN_RETRIEVAL_CASES,
  k = 5,
): Promise<RetrievalReport> {
  const scores: CaseScore[] = [];
  for (const c of cases) {
    const ranked = await retriever(c.namespace, c.query, k);
    scores.push({
      id: c.id,
      precisionAtK: precisionAtK(ranked, c.relevantIds, k),
      recall: recall(ranked, c.relevantIds),
      reciprocalRank: reciprocalRank(ranked, c.relevantIds),
    });
  }
  return {
    k,
    cases: scores,
    meanPrecisionAtK: mean(scores.map((s) => s.precisionAtK)),
    meanRecall: mean(scores.map((s) => s.recall)),
    mrr: mean(scores.map((s) => s.reciprocalRank)),
  };
}
