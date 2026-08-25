import { describe, expect, it } from "vitest";
import type { AbuseConfig } from "../../src/abuse/guards";
import { FOUNDING_CATALOG, PLAN_CATALOG, PLAN_IDS, PRICES_ARE_PREPUBLISH } from "../../src/billing/catalog";
import { effectiveQuota, entitlementsFor, isPlanId, resolveQuotaGuard } from "../../src/billing/plan-gating";

describe("plan catalog", () => {
  it("has exactly the 4 tenant.plan tiers", () => {
    expect(PLAN_IDS).toStrictEqual(["open", "starter", "pro", "managed"]);
  });

  it("orders entitlements starter < pro < managed", () => {
    expect(PLAN_CATALOG.starter.entitlements.maxMemoriesPerNamespace).toBeLessThan(PLAN_CATALOG.pro.entitlements.maxMemoriesPerNamespace);
    expect(PLAN_CATALOG.pro.entitlements.maxMemoriesPerNamespace).toBeLessThan(PLAN_CATALOG.managed.entitlements.maxMemoriesPerNamespace);
  });

  it("founding catalog matches §6 (prices + firm caps)", () => {
    expect(FOUNDING_CATALOG.bronze).toMatchObject({ priceCents: 49_700, cap: 30 });
    expect(FOUNDING_CATALOG.silver).toMatchObject({ priceCents: 149_700, cap: 12 });
    expect(FOUNDING_CATALOG.gold).toMatchObject({ priceCents: 499_700, cap: 5 });
  });

  it("prices are flagged pre-publish (not for public display)", () => {
    expect(PRICES_ARE_PREPUBLISH).toBe(true);
  });
});

describe("plan-gating engine (F6 #129-130)", () => {
  it("isPlanId narrows only the 4 known ids", () => {
    expect(isPlanId("pro")).toBe(true);
    expect(isPlanId("enterprise")).toBe(false);
    expect(isPlanId(undefined)).toBe(false);
    expect(isPlanId(null)).toBe(false);
  });

  it("entitlementsFor is FAIL-SAFE: unknown/absent plan → open (most restrictive)", () => {
    expect(entitlementsFor("pro")).toStrictEqual(PLAN_CATALOG.pro.entitlements);
    expect(entitlementsFor("bogus")).toStrictEqual(PLAN_CATALOG.open.entitlements);
    expect(entitlementsFor(undefined)).toStrictEqual(PLAN_CATALOG.open.entitlements);
    expect(entitlementsFor(null)).toStrictEqual(PLAN_CATALOG.open.entitlements);
  });

  it("effectiveQuota takes the per-field minimum (most restrictive wins)", () => {
    const a: AbuseConfig = { maxMemoriesPerNamespace: 1_000, maxNamespacesPerTenant: 50, maxTurnsPerCycle: 9_000 };
    const b: AbuseConfig = { maxMemoriesPerNamespace: 500, maxNamespacesPerTenant: 100, maxTurnsPerCycle: 3_000 };
    expect(effectiveQuota([a, b])).toStrictEqual({ maxMemoriesPerNamespace: 500, maxNamespacesPerTenant: 50, maxTurnsPerCycle: 3_000 });
    expect(() => effectiveQuota([])).toThrow();
  });

  it("resolveQuotaGuard: undefined when BOTH off (zero-cost default)", () => {
    const cfg: AbuseConfig = { maxMemoriesPerNamespace: 2, maxNamespacesPerTenant: 2, maxTurnsPerCycle: 2 };
    expect(resolveQuotaGuard({ planGatingEnabled: false, abuseEnabled: false, plan: "pro", abuseConfig: cfg })).toBeUndefined();
  });

  it("resolveQuotaGuard: plan-only uses the plan's entitlements", () => {
    const cfg: AbuseConfig = { maxMemoriesPerNamespace: 2, maxNamespacesPerTenant: 2, maxTurnsPerCycle: 2 };
    expect(resolveQuotaGuard({ planGatingEnabled: true, abuseEnabled: false, plan: "open", abuseConfig: cfg })).toStrictEqual(PLAN_CATALOG.open.entitlements);
  });

  it("resolveQuotaGuard: both on → most restrictive per field (abuse ceiling caps a rich plan)", () => {
    const abuseCeiling: AbuseConfig = { maxMemoriesPerNamespace: 5, maxNamespacesPerTenant: 1, maxTurnsPerCycle: 100 };
    const eff = resolveQuotaGuard({ planGatingEnabled: true, abuseEnabled: true, plan: "managed", abuseConfig: abuseCeiling });
    // managed is unlimited, but the abuse ceiling wins.
    expect(eff).toStrictEqual({ maxMemoriesPerNamespace: 5, maxNamespacesPerTenant: 1, maxTurnsPerCycle: 100 });
  });

  it("resolveQuotaGuard: abuse-only preserves the prior behaviour (env config verbatim)", () => {
    const cfg: AbuseConfig = { maxMemoriesPerNamespace: 42, maxNamespacesPerTenant: 7, maxTurnsPerCycle: 7 };
    expect(resolveQuotaGuard({ planGatingEnabled: false, abuseEnabled: true, plan: "pro", abuseConfig: cfg })).toStrictEqual(cfg);
  });
});
