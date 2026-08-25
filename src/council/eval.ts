import { consolidate, type CouncilModel } from "./consolidate";

/**
 * LLM Council eval harness (PR #52). Runs each golden case through
 * BOTH single-pass and council-on and scores the result, so the value of the
 * council (vs its ~Nx cost) is measured, not assumed.
 *
 * The cases target the failure single-pass exhibits: naive "take the incoming
 * write" silently DROPS still-valid facts from the existing note. A consolidating
 * council retains them. (Models are dependency-injected; the executable harness is
 * real — see docs/council-eval.md for the honesty caveat about simulated vs real
 * models pending the AI Gateway wiring in F3.)
 */

export interface GoldenCase {
  readonly id: string;
  readonly topic: string;
  readonly existing: string | null;
  readonly incoming: string;
  /** Tokens the CORRECT consolidated note must contain. */
  readonly expectedContains: readonly string[];
}

export const GOLDEN_CASES: readonly GoldenCase[] = [
  { id: "retain-plan", topic: "ana", existing: "Ana is on the pro-plan.", incoming: "Ana prefers email contact.", expectedContains: ["pro-plan", "email"] },
  { id: "retain-name", topic: "client", existing: "Client name is Ana Paula Souza.", incoming: "She works at Acme.", expectedContains: ["Ana Paula", "Acme"] },
  { id: "retain-pref", topic: "billing", existing: "Prefers PIX for payment.", incoming: "Lives in São Paulo.", expectedContains: ["PIX", "São Paulo"] },
  { id: "overwrite-new", topic: "deadline", existing: null, incoming: "Project deadline is 2026-08-01.", expectedContains: ["2026-08-01"] },
  { id: "correct-value", topic: "budget", existing: "Budget is 1000.", incoming: "Budget is now 2000.", expectedContains: ["2000"] },
];

/** Fraction of the expected tokens present in the output (0..1). */
export function scoreOutput(output: string, expectedContains: readonly string[]): number {
  if (expectedContains.length === 0) return 1;
  const lower = output.toLowerCase();
  const hits = expectedContains.filter((t) => lower.includes(t.toLowerCase())).length;
  return hits / expectedContains.length;
}

export interface EvalDeps {
  members: readonly CouncilModel[];
  chairman: CouncilModel;
}

export interface CaseResult {
  id: string;
  singlePass: number;
  council: number;
}

export interface EvalReport {
  cases: CaseResult[];
  avgSinglePass: number;
  avgCouncil: number;
  delta: number;
  verdict: string;
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export async function runCouncilEval(deps: EvalDeps): Promise<EvalReport> {
  const cases: CaseResult[] = [];
  for (const c of GOLDEN_CASES) {
    const base = { topic: c.topic, existing: c.existing, incoming: c.incoming, contested: true };
    const sp = await consolidate({ config: { enabled: false }, members: deps.members, chairman: deps.chairman }, base);
    const co = await consolidate({ config: { enabled: true }, members: deps.members, chairman: deps.chairman }, base);
    cases.push({ id: c.id, singlePass: scoreOutput(sp.body, c.expectedContains), council: scoreOutput(co.body, c.expectedContains) });
  }
  const avgSinglePass = avg(cases.map((r) => r.singlePass));
  const avgCouncil = avg(cases.map((r) => r.council));
  const delta = avgCouncil - avgSinglePass;
  const verdict = delta > 0 ? `council +${(delta * 100).toFixed(0)}% on the golden set` : "no measurable gain — not worth the cost";
  return { cases, avgSinglePass, avgCouncil, delta, verdict };
}
