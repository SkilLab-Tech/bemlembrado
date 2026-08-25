/**
 * Context-block budget guard (turn-batch, roadmap #75). Caps the RETRIEVED memories
 * injected per turn — bounding request size + cost.
 *
 * Deliberately scoped to the Context Block ONLY, never the history: the Context
 * Block rides AFTER the cache breakpoint, so trimming it has zero cache impact.
 * Trimming history instead would slide the window and break the append-only cached
 * prefix (P0 #1) — so we don't. Oversized history is a consolidation concern, later.
 */

export const DEFAULT_CONTEXT_CHAR_BUDGET = 8000;
export const DEFAULT_MAX_MEMORIES = 20;

export interface ContextBudget {
  charBudget?: number;
  maxItems?: number;
}

/**
 * Take memories in rank order until the char budget OR item cap is hit; drop the
 * rest. Returns the kept slice plus how many were dropped (for honest telemetry).
 */
export function clampMemories(
  texts: readonly string[],
  budget: ContextBudget = {},
): { kept: string[]; dropped: number } {
  const charBudget = budget.charBudget ?? DEFAULT_CONTEXT_CHAR_BUDGET;
  const maxItems = budget.maxItems ?? DEFAULT_MAX_MEMORIES;
  const kept: string[] = [];
  let used = 0;
  for (const t of texts) {
    if (kept.length >= maxItems || used + t.length > charBudget) break;
    kept.push(t);
    used += t.length;
  }
  return { kept, dropped: texts.length - kept.length };
}
