/**
 * DPA (Data Processing Agreement) scaffolding (F5 #113, LGPD).
 *
 * Machine-readable roles + processing facts that back the per-client DPA
 * (docs/lgpd/dpa.md). In the managed model: the CLIENT is the controller
 * (controlador) and BemLembrado is the operator (operador) under LGPD Arts. 5
 * VI/VII. These constants are the single source of truth referenced by the DPA
 * template, onboarding, and the residency disclosure — so processing purposes and
 * sub-processors are never described differently in two places.
 */

import type { Region } from "./residency";
import { residencyDisclosure } from "./residency";

export type LgpdRole = "controller" | "operator";

/** LGPD DPO (Encarregado). */
export const DPO = { name: "Ivan Prado", contact: "privacidade@bemlembrado.com" } as const;

/** Roles under the managed model (LGPD Arts. 5 VI/VII). */
export const ROLES: Readonly<Record<"client" | "bemLembrado", LgpdRole>> = {
  client: "controller",
  bemLembrado: "operator",
} as const;

/** The purposes for which personal data may be processed — closed list (minimization). */
export const PROCESSING_PURPOSES: readonly string[] = [
  "Store and retrieve agent memory on behalf of the controller",
  "Generate embeddings and consolidated summaries to serve retrieval",
  "Meter usage for billing",
  "Operate, secure, and debug the service (audit log, rate limiting)",
];

/** Sub-processors the operator relies on (disclosed to the controller in the DPA). */
export const SUBPROCESSORS: readonly { name: string; role: string }[] = [
  { name: "Cloudflare, Inc.", role: "Edge compute + storage (Workers, D1, KV, Vectorize, R2, Workers AI)" },
  { name: "Anthropic", role: "Optional premium inference (only when a tenant opts in with its own routing)" },
  { name: "Maritaca AI", role: "Optional pt-BR inference (only when configured)" },
];

/** Architectural rule (not a toggle): the operator never sells or re-purposes client data. */
export const NO_DATA_RESALE = true;

export interface DpaSummary {
  readonly roles: typeof ROLES;
  readonly dpo: typeof DPO;
  readonly purposes: readonly string[];
  readonly subprocessors: readonly { name: string; role: string }[];
  readonly noDataResale: boolean;
  readonly residency: string;
}

/** Assemble the DPA facts for a deployment region — for onboarding/disclosure surfaces. */
export function dpaSummary(region: Region): DpaSummary {
  return {
    roles: ROLES,
    dpo: DPO,
    purposes: PROCESSING_PURPOSES,
    subprocessors: SUBPROCESSORS,
    noDataResale: NO_DATA_RESALE,
    residency: residencyDisclosure(region),
  };
}
