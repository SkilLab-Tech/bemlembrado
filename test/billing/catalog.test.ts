import { describe, expect, it } from "vitest";
import { BILLING_TERMS, CURRENCIES, PLAN_CATALOG, priceFor, resolveCurrency } from "../../src/billing/catalog";

describe("international price grid", () => {
  it("prices the paid tiers per the signed USD/BRL × monthly/annual grid", () => {
    // Starter: USD $18/mo · $15/mo annual ($180/yr); BRL R$65/mo · R$50/mo annual (R$600/yr).
    expect(priceFor(PLAN_CATALOG.starter, "USD", "monthly")).toBe(1_800);
    expect(priceFor(PLAN_CATALOG.starter, "USD", "annual")).toBe(18_000);
    expect(priceFor(PLAN_CATALOG.starter, "BRL", "monthly")).toBe(6_500);
    expect(priceFor(PLAN_CATALOG.starter, "BRL", "annual")).toBe(60_000);
    // Pro: USD $79/mo · $65/mo annual ($780/yr); BRL R$279/mo · R$229/mo annual (R$2.748/yr).
    expect(priceFor(PLAN_CATALOG.pro, "USD", "monthly")).toBe(7_900);
    expect(priceFor(PLAN_CATALOG.pro, "USD", "annual")).toBe(78_000);
    expect(priceFor(PLAN_CATALOG.pro, "BRL", "monthly")).toBe(27_900);
    expect(priceFor(PLAN_CATALOG.pro, "BRL", "annual")).toBe(274_800);
  });

  it("annual = 12 × the discounted monthly-equivalent (never the monthly × 12)", () => {
    // annual is cheaper per month than monthly — the discount is real, not a rounding of monthly.
    for (const plan of [PLAN_CATALOG.starter, PLAN_CATALOG.pro]) {
      for (const cur of CURRENCIES) {
        const monthly = priceFor(plan, cur, "monthly");
        const annual = priceFor(plan, cur, "annual");
        if (monthly === null || annual === null) throw new Error(`paid tier ${plan.id}/${cur} must have prices`);
        expect(annual).toBeLessThan(monthly * 12); // annual saves vs paying monthly
      }
    }
  });

  it("open is free and managed is custom-quoted (null) across every cell", () => {
    for (const cur of CURRENCIES) {
      for (const term of BILLING_TERMS) {
        expect(priceFor(PLAN_CATALOG.open, cur, term)).toBe(0);
        expect(priceFor(PLAN_CATALOG.managed, cur, term)).toBeNull();
      }
    }
  });
});

describe("resolveCurrency (geo-pricing)", () => {
  it("Brazil gets the BRL grid, everyone else pays USD", () => {
    expect(resolveCurrency("BR")).toBe("BRL");
    expect(resolveCurrency("US")).toBe("USD");
    expect(resolveCurrency("PT")).toBe("USD");
    expect(resolveCurrency(undefined)).toBe("USD"); // unknown country → USD (never the cheaper grid by default)
    expect(resolveCurrency(null)).toBe("USD");
  });
});
