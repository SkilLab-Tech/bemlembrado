/**
 * Consolidation candidate selection.
 *
 * Pure, deterministic pre-filter that runs BEFORE the (paid, flag-gated) LLM
 * council in consolidate.ts. Given an incoming memory write and the existing
 * memories already stored in the same namespace, it decides whether the write is
 * CONTESTED — a near-duplicate, refinement, or contradiction of something already
 * stored — and, if so, selects the single best existing note to consolidate
 * against.
 *
 * No model calls, no I/O — token-overlap (Jaccard) similarity only. The council
 * stays a no-op passthrough unless a write is flagged contested here, so the
 * common case (an unrelated write) never spends a token. Deliberately conservative:
 * a false negative just skips consolidation (write stored as-is); a false positive
 * only routes to the council, which still cannot drop a still-valid fact.
 */

export interface CandidateMemory {
  readonly id: string;
  readonly text: string;
}

export interface CandidateSelection {
  readonly contested: boolean;
  /** The existing note text to consolidate against (null when not contested). */
  readonly existing: string | null;
  /** The existing memory id chosen as the consolidation target (null when not contested). */
  readonly targetId: string | null;
  /** Jaccard overlap [0,1] of the chosen target (0 when none). */
  readonly score: number;
}

export interface CandidateOptions {
  /** Minimum token-overlap to treat a write as related/contested. Default 0.2. */
  readonly threshold?: number;
  /** Cap the existing memories scanned (caller passes most-recent-first). Default 50. */
  readonly maxCandidates?: number;
}

const DEFAULT_THRESHOLD = 0.2;
const DEFAULT_MAX_CANDIDATES = 50;
const MIN_TOKEN_LEN = 3;

/** Small pt-BR + en stoplist — only affects the similarity heuristic, never stored text. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "her", "his", "she", "him", "was", "are", "has", "have",
  "que", "com", "para", "dos", "das", "uma", "ums", "nao", "sim", "por", "sua", "seu",
  "ele", "ela", "eles", "elas", "esta", "esta", "isso", "este", "essa", "esse",
]);

/** Lowercase, strip accents, split on non-alphanumerics, drop stopwords + short tokens. */
export function tokenize(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // strip combining diacritics
  const out = new Set<string>();
  for (const raw of normalized.split(/[^a-z0-9]+/)) {
    if (raw.length >= MIN_TOKEN_LEN && !STOPWORDS.has(raw)) {
      out.add(raw);
    }
  }
  return out;
}

/** Jaccard similarity of two token sets: |A∩B| / |A∪B|. Empty-safe (returns 0). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Pick the best existing memory to consolidate an incoming write against.
 * Contested when the top overlap meets `threshold`. Ties resolve to the earliest
 * candidate in the (caller-ordered) list, so selection is fully deterministic.
 */
export function selectConsolidationCandidate(
  incoming: string,
  existing: readonly CandidateMemory[],
  opts: CandidateOptions = {},
): CandidateSelection {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const incomingTokens = tokenize(incoming);

  const none: CandidateSelection = { contested: false, existing: null, targetId: null, score: 0 };
  if (incomingTokens.size === 0 || existing.length === 0) return none;

  let best: CandidateMemory | null = null;
  let bestScore = 0;
  for (const candidate of existing.slice(0, maxCandidates)) {
    const score = jaccard(incomingTokens, tokenize(candidate.text));
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (best === null || bestScore < threshold) return none;
  return { contested: true, existing: best.text, targetId: best.id, score: bestScore };
}
