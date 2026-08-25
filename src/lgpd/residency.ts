/**
 * Data-residency policy (F5 #112, LGPD by design).
 *
 * HONESTY FIRST — this is a *declared policy + satisfiability guard*, not a claim the
 * edge can pin every byte to a country. On Cloudflare: D1 takes a location HINT at
 * creation (closest of wnam/enam/weur/eeur/apac/oc — there is no exact BR hint); KV and
 * Vectorize are GLOBAL. So the strongest honest guarantee is "primary D1 store in
 * region X". The guard's job is to REFUSE to promise a tenant a residency the
 * deployment cannot back — never to fake per-request geo-fencing we don't have.
 *
 * The runbook (docs/lgpd/dpa.md) documents the D1 location hint used per deployment
 * and states plainly what is and isn't residency-guaranteed.
 */

export type Region = "global" | "br" | "sa" | "us" | "eu" | "apac";

const REGIONS: ReadonlySet<Region> = new Set<Region>(["global", "br", "sa", "us", "eu", "apac"]);

export class ResidencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResidencyError";
  }
}

/** Validate/parse a configured region string. Unknown values throw (fail-closed at boot). */
export function parseRegion(value: string | undefined, fallback: Region = "global"): Region {
  if (value === undefined || value.length === 0) return fallback;
  const lower = value.toLowerCase();
  if (!REGIONS.has(lower as Region)) {
    throw new ResidencyError(`unknown data-residency region: ${value}`);
  }
  return lower as Region;
}

/**
 * Refuse to grant a tenant a residency the deployment cannot satisfy:
 * - requested "global" (no constraint) is always fine;
 * - a deployment with region "global" makes no guarantee → any non-global request throws;
 * - otherwise the requested region must equal the deployment region.
 * This keeps the LGPD promise honest — a tenant is never told "your data stays in BR"
 * unless the deployment is actually pinned there.
 */
export function assertResidencySatisfiable(requested: Region, deployment: Region): void {
  if (requested === "global") return;
  if (deployment === "global") {
    throw new ResidencyError(`deployment declares no residency; cannot guarantee "${requested}"`);
  }
  if (requested !== deployment) {
    throw new ResidencyError(`deployment residency "${deployment}" cannot satisfy requested "${requested}"`);
  }
}

/** Honest, human-readable disclosure of what a region guarantees on the CF edge. */
export function residencyDisclosure(region: Region): string {
  if (region === "global") {
    return "No data-residency guarantee: primary store and edge caches may be located in any Cloudflare region.";
  }
  return `Primary D1 store provisioned with the ${region.toUpperCase()} location hint. Note: KV and Vectorize are global by design; residency covers the source-of-truth store, not edge caches.`;
}
