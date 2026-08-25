import { beforeEach, describe, expect, it } from "vitest";
import { Db, type SubscriptionRow } from "../../src/db/client";
import { PLAN_CATALOG, priceFor } from "../../src/billing/catalog";
import { rollupSubscriptionInvoice } from "../../src/billing/rollup";
import { testEnv } from "../helpers/env";

const T0 = 1_700_000_000_000;
const PERIOD = { start: T0, end: T0 + 30 * 86_400_000 };
function db() {
  return new Db(testEnv.DB);
}

async function seedTenant(id: string) {
  await db().insertTenant({ id, name: id, plan: "open", api_key_hash: `h-${id}`, created_at: T0 });
}

async function seedSubscription(tenantId: string, plan: string): Promise<string> {
  const row: SubscriptionRow = {
    id: `sub-${tenantId}`, tenant_id: tenantId, plan, status: "active", provider: "mercadopago",
    external_ref: null, current_period_start: PERIOD.start, current_period_end: PERIOD.end, created_at: T0, canceled_at: null,
  };
  await db().insertSubscription(row);
  return row.id;
}

async function seedUsage(id: string, tenantId: string, createdAt: number, cacheRead = 0) {
  await db().insertUsageEvent({
    id, tenant_id: tenantId, session_id: "s1", turn: 1, tokens_fresh: 100, tokens_cache_read: cacheRead,
    tokens_cache_write: 0, provider: "anthropic", model: "claude", cost_usd: null, created_at: createdAt,
  });
}

describe("usage→billing rollup", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM tenant");
    await seedTenant("t1");
    await seedTenant("t2");
  });

  it("bills the plan's FLAT monthly price; attaches period usage; amount is unchanged by usage", async () => {
    await seedSubscription("t1", "pro");
    await seedUsage("u1", "t1", T0 + 1000, 400);
    await seedUsage("u2", "t1", T0 + 2000, 600);

    const r = await rollupSubscriptionInvoice(db(), "t1", PERIOD, T0 + 5000);
    expect(r).not.toBeNull();
    expect(r?.invoice.amount_cents).toBe(priceFor(PLAN_CATALOG.pro, "BRL", "monthly")); // flat, integer cents (BRL monthly cell)
    expect(r?.invoice.currency).toBe("BRL");
    expect(r?.invoice.status).toBe("open");
    expect(r?.invoice.period_start).toBe(PERIOD.start);
    expect(r?.usage.turns).toBe(2); // usage attached for transparency
    expect(r?.usage.tokensCacheRead).toBe(1000);
  });

  it("nothing to bill → null: no subscription, open plan (R$0), or managed (custom-quoted)", async () => {
    expect(await rollupSubscriptionInvoice(db(), "t1", PERIOD, T0)).toBeNull(); // no subscription

    await seedSubscription("t1", "open");
    expect(await rollupSubscriptionInvoice(db(), "t1", PERIOD, T0)).toBeNull(); // R$0

    await seedSubscription("t2", "managed");
    expect(await rollupSubscriptionInvoice(db(), "t2", PERIOD, T0)).toBeNull(); // price null → out-of-band
    expect(await db().listInvoicesByTenant("t1")).toStrictEqual([]);
    expect(await db().listInvoicesByTenant("t2")).toStrictEqual([]);
  });

  it("is idempotent: a second run returns the same invoice, never a duplicate (cron-safe)", async () => {
    await seedSubscription("t1", "starter");
    const first = await rollupSubscriptionInvoice(db(), "t1", PERIOD, T0 + 1);
    const second = await rollupSubscriptionInvoice(db(), "t1", PERIOD, T0 + 999);
    expect(second?.invoice.id).toBe(first?.invoice.id);
    expect(await db().listInvoicesByTenant("t1")).toHaveLength(1);
  });

  it("attached usage covers ONLY the billing period and ONLY this tenant", async () => {
    await seedSubscription("t1", "pro");
    await seedUsage("in", "t1", PERIOD.start + 10, 100); // in period
    await seedUsage("before", "t1", PERIOD.start - 10, 999); // before period
    await seedUsage("after", "t1", PERIOD.end + 10, 999); // after period
    await seedUsage("other", "t2", PERIOD.start + 10, 999); // other tenant

    const r = await rollupSubscriptionInvoice(db(), "t1", PERIOD, PERIOD.end);
    expect(r?.usage.turns).toBe(1);
    expect(r?.usage.tokensCacheRead).toBe(100); // only the in-period, in-tenant event
  });
});
