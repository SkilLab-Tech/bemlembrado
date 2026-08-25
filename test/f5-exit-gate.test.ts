import { describe, expect, it } from "vitest";
import { type AbuseConfig, DEFAULT_ABUSE_CONFIG, assertMemoryQuota, assertNamespaceQuota } from "../src/abuse/guards";
import { isScopedToken } from "../src/auth/scoped-token";
import { ALL_SCOPES, hasAllScopes, hasScope } from "../src/auth/scopes";
import { EMBEDDING_DIMENSIONS, provisioningPlan } from "../src/cli/provision";
import { fallbackMerge, isValidConsolidation } from "../src/council/summarize";
import { kvKey } from "../src/db/kv";
import { QuotaExceeded } from "../src/http/errors";
import { DPO, NO_DATA_RESALE } from "../src/lgpd/dpa";
import { ResidencyError, assertResidencySatisfiable, parseRegion } from "../src/lgpd/residency";
import { toFailureRecord } from "../src/obs/failure-corpus";

/**
 * F5 EXIT GATE. A single, cross-cutting CONTRACT suite that locks the
 * V1 guarantees (FR-10/12/13/14 + LGPD + hardening) at the public surface. It is a
 * deliberate tripwire: if a future refactor deletes, renames, or weakens a V1 capability
 * (or reintroduces a fixed bug), THIS suite fails loudly — independent of the per-feature
 * unit tests. FR-11 (billing) is F6, out of scope here. The two P0 invariants (cache-prefix
 * + tenant-isolation) are enforced as blocking CI gates (.github/workflows/ci.yml); the
 * cache-layer tenant-isolation contract is additionally pinned below.
 */
describe("F5 exit gate — V1 FR contract", () => {
  it("FR-10 consolidation is loss-safe: fallbackMerge keeps BOTH sides; an empty merge is rejected", () => {
    const merged = fallbackMerge("Ana is on the pro plan", "Ana upgraded her plan");
    expect(merged).toContain("Ana is on the pro plan");
    expect(merged).toContain("Ana upgraded her plan");
    // The guard must never accept a lossy/empty consolidation output.
    expect(isValidConsolidation("", "keep this fact", "and this one")).toBe(false);
  });

  it("FR-12 self-host plan pins Vectorize to 1024 dims and the pepper to a SECRET (never a var)", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(1024); // bge-m3; index dims are exact-match
    const plan = provisioningPlan("acme");
    const vectorize = plan.find((s) => s.id === "vectorize");
    expect(vectorize?.command).toContain("--dimensions=1024");
    expect(vectorize?.command).not.toContain("1536"); // the create-command bug must never return
    expect(plan.find((s) => s.id === "secret")?.command).toBe("wrangler secret put API_KEY_PEPPER");
  });

  it("FR-13 OAuth: scoped tokens are prefix-distinct from API keys and scope checks are exact", () => {
    expect(isScopedToken("blt_anything")).toBe(true);
    expect(isScopedToken("bl_fullaccesskey")).toBe(false); // a full API key is NOT a scoped token
    expect(ALL_SCOPES).toStrictEqual(["memory:read", "memory:write", "memory:delete", "session:read"]);
    expect(hasScope(["memory:read"], "memory:write")).toBe(false);
    expect(hasAllScopes(ALL_SCOPES, ["memory:read", "session:read"])).toBe(true);
  });

  it("FR-14 KV keys are tenant-prefixed — cache-layer tenant isolation (P0 #2)", () => {
    expect(kvKey("t1", "ns", "n1", "summary")).toBe("t:t1:ns:n1:summary");
    expect(kvKey("t1", "x").startsWith("t:t1:")).toBe(true);
    expect(kvKey("t2", "x")).not.toBe(kvKey("t1", "x")); // distinct tenants → distinct keys
  });

  it("LGPD residency parsing is fail-closed and never over-promises", () => {
    expect(parseRegion(undefined)).toBe("global"); // safe default (promises nothing)
    expect(() => parseRegion("atlantis")).toThrow(ResidencyError); // unknown region fails closed
    expect(() => { assertResidencySatisfiable("br", "global"); }).toThrow(ResidencyError); // global can't guarantee br
    expect(() => { assertResidencySatisfiable("br", "br"); }).not.toThrow();
    expect(() => { assertResidencySatisfiable("global", "global"); }).not.toThrow();
  });

  it("LGPD DPA declares no-resale and names the DPO (Encarregado)", () => {
    expect(NO_DATA_RESALE).toBe(true);
    expect(DPO.contact).toBe("privacidade@bemlembrado.com");
  });

  it("hardening: volume quotas throw at the cap for BOTH memory and namespace", () => {
    const cfg: AbuseConfig = { maxMemoriesPerNamespace: 2, maxNamespacesPerTenant: 2, maxTurnsPerCycle: 100 };
    expect(() => { assertMemoryQuota(1, cfg); }).not.toThrow();
    expect(() => { assertMemoryQuota(2, cfg); }).toThrow(QuotaExceeded);
    expect(() => { assertNamespaceQuota(2, cfg); }).toThrow(QuotaExceeded);
    expect(DEFAULT_ABUSE_CONFIG.maxMemoriesPerNamespace).toBeGreaterThan(0);
    expect(DEFAULT_ABUSE_CONFIG.maxNamespacesPerTenant).toBeGreaterThan(0);
  });

  it("#123 failure corpus stores STRUCTURAL metadata only — never user text (LGPD by construction)", () => {
    const rec = toFailureRecord("turn", new Error("boom"), { provider: "workers-ai", requestId: "r1" });
    const allowed = new Set(["kind", "errorClass", "message", "provider", "model", "requestId"]);
    for (const key of Object.keys(rec)) expect(allowed.has(key)).toBe(true);
    expect(rec.kind).toBe("turn");
    expect(rec.errorClass).toBe("Error");
    expect(rec.message).toBe("boom"); // derived ONLY from the error, never from memory/query content
  });
});
