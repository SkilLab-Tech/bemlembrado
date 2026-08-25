import { beforeEach, describe, expect, it } from "vitest";
import { Db } from "../../src/db/client";
import { testEnv } from "../helpers/env";

const T0 = 1_700_000_000_000;

function db() {
  return new Db(testEnv.DB);
}

async function reset() {
  await testEnv.DB.exec("DELETE FROM tenant");
}

async function seedTenant(id: string) {
  await db().insertTenant({ id, name: id, plan: "open", api_key_hash: `h-${id}`, created_at: T0 });
}

describe("billing repo (F6 #126-127)", () => {
  beforeEach(async () => {
    await reset();
    await seedTenant("t1");
    await seedTenant("t2");
  });

  it("subscription: insert → read active → cancel drops it from active", async () => {
    await db().insertSubscription({
      id: "s1", tenant_id: "t1", plan: "pro", status: "active", provider: "mercadopago",
      external_ref: "mp-123", current_period_start: T0, current_period_end: T0 + 1, created_at: T0, canceled_at: null,
    });
    const active = await db().getActiveSubscriptionByTenant("t1");
    expect(active?.id).toBe("s1");
    expect(active?.plan).toBe("pro");

    await db().updateSubscriptionStatus("t1", "s1", "canceled", T0 + 5);
    expect(await db().getActiveSubscriptionByTenant("t1")).toBeNull(); // canceled excluded
  });

  it("subscription/payment mutations are tenant-scoped: a wrong tenant id is a no-op (INVARIANT #2)", async () => {
    await db().insertSubscription({ id: "s1", tenant_id: "t1", plan: "pro", status: "active", provider: "stripe", external_ref: null, current_period_start: null, current_period_end: null, created_at: T0, canceled_at: null });
    // t2 must NOT be able to cancel t1's subscription by guessing its id.
    await db().updateSubscriptionStatus("t2", "s1", "canceled", T0 + 5);
    expect((await db().getActiveSubscriptionByTenant("t1"))?.id).toBe("s1"); // unchanged
    await db().updateSubscriptionStatus("t1", "s1", "canceled", T0 + 5);
    expect(await db().getActiveSubscriptionByTenant("t1")).toBeNull(); // owner can

    await db().insertPayment({ id: "p1", tenant_id: "t1", invoice_id: null, provider: "stripe", external_id: "ch_x", amount_cents: 100, currency: "BRL", status: "pending", paid_at: null, created_at: T0 });
    await db().updatePaymentStatus("t2", "p1", "succeeded", T0 + 3); // wrong tenant
    expect((await db().getPaymentByProviderRef("stripe", "ch_x"))?.status).toBe("pending"); // unchanged
    await db().updatePaymentStatus("t1", "p1", "succeeded", T0 + 3); // owner
    expect((await db().getPaymentByProviderRef("stripe", "ch_x"))?.status).toBe("succeeded");
  });

  it("invoice: insert + list is tenant-scoped (no cross-tenant leak)", async () => {
    await db().insertInvoice({ id: "i1", tenant_id: "t1", subscription_id: null, amount_cents: 9700, currency: "BRL", status: "open", period_start: T0, period_end: T0 + 1, created_at: T0 });
    await db().insertInvoice({ id: "i2", tenant_id: "t2", subscription_id: null, amount_cents: 39700, currency: "BRL", status: "open", period_start: T0, period_end: T0 + 1, created_at: T0 });
    const t1 = await db().listInvoicesByTenant("t1");
    expect(t1.map((r) => r.id)).toStrictEqual(["i1"]);
    expect(t1[0]?.amount_cents).toBe(9700); // integer cents, never a float
  });

  it("payment: provider-ref lookup gives webhook idempotency; UNIQUE(provider,external_id) blocks a dup", async () => {
    await db().insertPayment({ id: "p1", tenant_id: "t1", invoice_id: null, provider: "mercadopago", external_id: "evt-1", amount_cents: 9700, currency: "BRL", status: "pending", paid_at: null, created_at: T0 });
    const found = await db().getPaymentByProviderRef("mercadopago", "evt-1");
    expect(found?.id).toBe("p1");
    expect(await db().getPaymentByProviderRef("mercadopago", "evt-nope")).toBeNull();

    // A second event with the same (provider, external_id) must be rejected (idempotency at the DB).
    await expect(
      db().insertPayment({ id: "p2", tenant_id: "t1", invoice_id: null, provider: "mercadopago", external_id: "evt-1", amount_cents: 9700, currency: "BRL", status: "succeeded", paid_at: T0, created_at: T0 }),
    ).rejects.toThrow();

    await db().updatePaymentStatus("t1", "p1", "succeeded", T0 + 3);
    expect((await db().getPaymentByProviderRef("mercadopago", "evt-1"))?.status).toBe("succeeded");
  });

  it("manual payments allow multiple NULL external_id (no false idempotency collision)", async () => {
    await db().insertPayment({ id: "m1", tenant_id: "t1", invoice_id: null, provider: "manual", external_id: null, amount_cents: 100, currency: "BRL", status: "succeeded", paid_at: T0, created_at: T0 });
    await expect(
      db().insertPayment({ id: "m2", tenant_id: "t1", invoice_id: null, provider: "manual", external_id: null, amount_cents: 200, currency: "BRL", status: "succeeded", paid_at: T0, created_at: T0 }),
    ).resolves.toBeUndefined();
  });

  it("founding member: signal captured + per-tier count (the cap basis)", async () => {
    await db().insertFoundingMember({ id: "f1", tenant_id: null, email: "a@x.com", tier: "gold", amount_cents: 499700, status: "signal", signal_at: T0, created_at: T0 });
    await db().insertFoundingMember({ id: "f2", tenant_id: "t1", email: "b@x.com", tier: "bronze", amount_cents: 49700, status: "signal", signal_at: T0, created_at: T0 });
    expect(await db().countFoundingMembersByTier("gold")).toBe(1);
    expect(await db().countFoundingMembersByTier("bronze")).toBe(1);
    expect(await db().countFoundingMembersByTier("silver")).toBe(0);
  });

  it("tenant delete CASCADEs billing rows (LGPD right-to-erasure)", async () => {
    await db().insertSubscription({ id: "s1", tenant_id: "t1", plan: "pro", status: "active", provider: "stripe", external_ref: null, current_period_start: null, current_period_end: null, created_at: T0, canceled_at: null });
    await db().insertInvoice({ id: "i1", tenant_id: "t1", subscription_id: "s1", amount_cents: 39700, currency: "BRL", status: "paid", period_start: null, period_end: null, created_at: T0 });
    await db().insertPayment({ id: "p1", tenant_id: "t1", invoice_id: "i1", provider: "stripe", external_id: "ch_1", amount_cents: 39700, currency: "BRL", status: "succeeded", paid_at: T0, created_at: T0 });

    await testEnv.DB.prepare("DELETE FROM tenant WHERE id = ?").bind("t1").run();

    expect(await db().getActiveSubscriptionByTenant("t1")).toBeNull();
    expect(await db().listInvoicesByTenant("t1")).toStrictEqual([]);
    expect(await db().getPaymentByProviderRef("stripe", "ch_1")).toBeNull();
  });
});
