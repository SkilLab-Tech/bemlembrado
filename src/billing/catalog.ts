import type { AbuseConfig } from "../abuse/guards";
import type { FoundingTier } from "../db/client";

/**
 * Plan catalog + entitlements. The 4 plan ids mirror the TENANT.plan
 * enum exactly. Prices are stored in INTEGER CENTS
 * (BRL). This module is the internal source of truth for what a plan costs and what it
 * entitles — never a display surface on its own.
 *
 * Entitlements reuse the AbuseConfig shape (per-namespace memory cap, per-tenant
 * namespace cap) so a plan's limits compose directly with the abuse safety ceiling.
 * The caps here are TUNABLE DEFAULTS (ordered starter < pro < managed), not a hard
 * product promise — Managed is effectively unlimited (the client owns the instance).
 */

export const PLAN_IDS = ["open", "starter", "pro", "managed"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

const UNLIMITED = Number.MAX_SAFE_INTEGER;

/** Billing currencies. USD is the anchor (rest of world); BRL is the Brazil price grid. */
export const CURRENCIES = ["USD", "BRL"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Billing terms. `annual` cells hold the ANNUAL charge (= 12 × the discounted monthly-equivalent). */
export const BILLING_TERMS = ["monthly", "annual"] as const;
export type BillingTerm = (typeof BILLING_TERMS)[number];

/** Price grid: currency → term → amount CHARGED for one full term, in minor units (cents). null = custom-quoted / not offered. */
export type PriceGrid = Record<Currency, Record<BillingTerm, number | null>>;

export interface PlanDef {
  readonly id: PlanId;
  readonly label: string;
  /**
   * International price grid. USD-anchored, with a separate BRL grid; annual = the
   * discounted monthly-equivalent × 12 (so "R$50/mo billed annually" is `annual / 12`).
   * LITERAL table — never runtime FX.
   */
  readonly prices: PriceGrid;
  readonly entitlements: AbuseConfig;
  readonly blurb: string;
}

export const PLAN_CATALOG: Record<PlanId, PlanDef> = {
  open: {
    id: "open",
    label: "Open (self-host)",
    prices: { USD: { monthly: 0, annual: 0 }, BRL: { monthly: 0, annual: 0 } },
    entitlements: { maxMemoriesPerNamespace: 1_000, maxNamespacesPerTenant: 3, maxTurnsPerCycle: 500 },
    blurb: "Core open-source, MCP + REST, Docker/Wrangler template. No SLA.",
  },
  starter: {
    id: "starter",
    label: "Cloud Starter",
    // USD $18/mo · $15/mo annual ($180/yr); BRL R$65/mo · R$50/mo annual (R$600/yr).
    prices: { USD: { monthly: 1_800, annual: 18_000 }, BRL: { monthly: 6_500, annual: 60_000 } },
    entitlements: { maxMemoriesPerNamespace: 50_000, maxNamespacesPerTenant: 25, maxTurnsPerCycle: 10_000 },
    blurb: "Managed instance, token free tier, hosted MCP.",
  },
  pro: {
    id: "pro",
    label: "Cloud Pro",
    // USD $79/mo · $65/mo annual ($780/yr); BRL R$279/mo · R$229/mo annual (R$2.748/yr).
    prices: { USD: { monthly: 7_900, annual: 78_000 }, BRL: { monthly: 27_900, annual: 274_800 } },
    entitlements: { maxMemoriesPerNamespace: 500_000, maxNamespacesPerTenant: 250, maxTurnsPerCycle: 40_000 },
    blurb: "More volume, per-tenant isolation, cost analytics, email support. BYOK for uncapped turns.",
  },
  managed: {
    id: "managed",
    label: "Managed / Done-for-you",
    // Custom-quoted; geo N/A.
    prices: { USD: { monthly: null, annual: null }, BRL: { monthly: null, annual: null } },
    entitlements: { maxMemoriesPerNamespace: UNLIMITED, maxNamespacesPerTenant: UNLIMITED, maxTurnsPerCycle: UNLIMITED },
    blurb: "White-label deploy (client owns the instance), LGPD, integration, support.",
  },
};

/** The charged amount (cents) for a plan in a currency + term; null = custom-quoted / not offered. */
export function priceFor(plan: PlanDef, currency: Currency, term: BillingTerm): number | null {
  return plan.prices[currency][term];
}

/**
 * Country (ISO-3166 alpha-2, from `request.cf.country`) → billing currency. Brazil gets
 * the BRL grid; everyone else pays USD. Anti-abuse gates on the BRL payment instrument at
 * checkout, NOT on the IP — so a mis-detected country is corrected by which rail actually pays.
 */
export function resolveCurrency(country: string | null | undefined): Currency {
  return country === "BR" ? "BRL" : "USD";
}

export interface FoundingDef {
  readonly tier: FoundingTier;
  /** One-time price in BRL cents. */
  readonly priceCents: number;
  /** Hard cap on how many of this tier are sold. */
  readonly cap: number;
  readonly benefits: string;
}

/** Founding Members . One-time pre-purchase, NOT equity. Caps are firm. */
export const FOUNDING_CATALOG: Record<FoundingTier, FoundingDef> = {
  bronze: { tier: "bronze", priceCents: 49_700, cap: 30, benefits: "50% off forever · badge · community · beta +30d" },
  silver: { tier: "silver", priceCents: 149_700, cap: 12, benefits: "75% off · 1:1 onboarding · direct line · beta +60d" },
  gold: { tier: "gold", priceCents: 499_700, cap: 5, benefits: "Managed free 1yr + 100% off Cloud forever · quarterly strategy · logo on launch page · beta +90d" },
};

/** Guard: prices above are internal defaults, not a published price list. */
export const PRICES_ARE_PREPUBLISH = true;
