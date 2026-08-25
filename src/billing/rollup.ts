import type { Db, InvoiceRow } from "../db/client";
import { summarizeUsage, type UsageSummary } from "../usage/aggregate";
import { PLAN_CATALOG, priceFor } from "./catalog";
import { isPlanId } from "./plan-gating";

/**
 * Usage → billing rollup. Rolls a tenant's active subscription into a
 * period invoice at the plan's FLAT monthly price. The period usage summary is attached
 * for transparency but does NOT change the amount:
 *   - Mercado Pago is flat-only by design (no metered API) — the primary BR rail.
 *   - Metered/overage billing (#138, Stripe usage records) is DEFERRED: no per-unit price
 *     is confirmed (PRICES_ARE_PREPUBLISH). Inventing an overage number would be a
 *     fabricated price, so we don't.
 *
 * Returns null when there is nothing to bill: no active subscription, or a plan with no
 * flat price (open = R$0; managed = custom-quoted, invoiced out-of-band).
 *
 * IDEMPOTENT: an invoice already covering (subscription, period_start) is returned as-is,
 * never duplicated — safe for cron re-runs. The app-level lookup is the friendly
 * path; the partial UNIQUE index (mig 0017) is the race-safe backstop, so a concurrent
 * double-run resolves to the one existing invoice instead of throwing.
 */

export interface BillingPeriod {
  /** Inclusive period start (epoch ms). */
  start: number;
  /** Inclusive period end (epoch ms). */
  end: number;
}

export interface RollupResult {
  invoice: InvoiceRow;
  usage: UsageSummary;
}

export async function rollupSubscriptionInvoice(db: Db, tenantId: string, period: BillingPeriod, now: number): Promise<RollupResult | null> {
  const sub = await db.getActiveSubscriptionByTenant(tenantId);
  if (sub === null) return null;

  const plan = isPlanId(sub.plan) ? PLAN_CATALOG[sub.plan] : null;
  if (plan === null) return null; // unknown plan → nothing to bill
  // ponytail: rollup bills the BRL monthly cell — the subscription row carries no
  // currency/term yet, and the primary BR rail is monthly BRL. Read sub.currency/term
  // here once the Wave-3 billing wiring persists them at signup (freeze-at-signup).
  const priceCents = priceFor(plan, "BRL", "monthly");
  if (priceCents === null || priceCents === 0) return null; // managed (custom-quoted) / open (R$0) — not auto-invoiced

  const usage = summarizeUsage(await db.listUsageEventsByTenant(tenantId, { since: period.start, until: period.end }));

  const existing = await db.findInvoiceForPeriod(tenantId, sub.id, period.start);
  if (existing !== null) return { invoice: existing, usage };

  const invoice: InvoiceRow = {
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    subscription_id: sub.id,
    amount_cents: priceCents,
    currency: "BRL", // matches the BRL monthly cell billed above (see ponytail note)
    status: "open",
    period_start: period.start,
    period_end: period.end,
    created_at: now,
  };

  try {
    await db.insertInvoice(invoice);
    return { invoice, usage };
  } catch (err) {
    // Lost a race on the UNIQUE(subscription, period_start) backstop — the other run's
    // invoice is authoritative. Re-read and return it; rethrow anything else.
    const raced = await db.findInvoiceForPeriod(tenantId, sub.id, period.start);
    if (raced !== null) return { invoice: raced, usage };
    throw err;
  }
}
