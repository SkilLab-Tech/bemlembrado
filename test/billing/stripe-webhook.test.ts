import { beforeEach, describe, expect, it } from "vitest";
import { Db } from "../../src/db/client";
import { handleStripeEvent, isStripeEvent, verifyStripeSignature, type StripeEvent } from "../../src/billing/stripe-webhook";
import { testEnv } from "../helpers/env";

const T0 = 1_700_000_000_000;
const NOW_SEC = Math.floor(T0 / 1000);
const SECRET = "whsec_test_secret";

function db() {
  return new Db(testEnv.DB);
}

/** Produce a valid Stripe-Signature header for a body — mirrors the documented scheme. */
async function sign(body: string, secret = SECRET, ts = NOW_SEC): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${String(ts)}.${body}`));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${String(ts)},v1=${hex}`;
}

describe("verifyStripeSignature", () => {
  const body = '{"hello":"world"}';

  it("accepts a correctly-signed payload", async () => {
    expect(await verifyStripeSignature(body, await sign(body), SECRET, T0)).toBe(true);
  });

  it("rejects a wrong secret, a tampered body, a stale timestamp, and a missing/blank header", async () => {
    expect(await verifyStripeSignature(body, await sign(body, "whsec_other"), SECRET, T0)).toBe(false);
    expect(await verifyStripeSignature(body + "x", await sign(body), SECRET, T0)).toBe(false);
    expect(await verifyStripeSignature(body, await sign(body, SECRET, NOW_SEC - 10_000), SECRET, T0)).toBe(false); // replay window
    expect(await verifyStripeSignature(body, null, SECRET, T0)).toBe(false);
    expect(await verifyStripeSignature(body, "t=1", SECRET, T0)).toBe(false); // no v1
  });
});

describe("handleStripeEvent state machine", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM tenant");
    await db().insertTenant({ id: "t1", name: "t1", plan: "open", api_key_hash: "h", created_at: T0 });
  });

  function evt(type: string, object: Record<string, unknown>): StripeEvent {
    return { id: `evt_${type}`, type, data: { object } };
  }

  it("checkout.session.completed activates a subscription; a redelivery is idempotent", async () => {
    const e = evt("checkout.session.completed", { id: "cs_1", subscription: "sub_ext_1", metadata: { tenant_id: "t1", plan: "pro" } });
    expect((await handleStripeEvent(db(), e, T0)).handled).toBe("subscription_activated");
    expect((await handleStripeEvent(db(), e, T0)).handled).toBe("subscription_exists"); // redelivery

    const sub = await db().getActiveSubscriptionByTenant("t1");
    expect(sub?.plan).toBe("pro");
    expect(sub?.status).toBe("active");
    expect(sub?.external_ref).toBe("sub_ext_1");
  });

  it("skips a checkout with no tenant metadata (never creates an orphan subscription)", async () => {
    const e = evt("checkout.session.completed", { id: "cs_x", subscription: "sub_x", metadata: {} });
    expect((await handleStripeEvent(db(), e, T0)).handled).toBe("skipped_missing_metadata");
    expect(await db().getActiveSubscriptionByTenant("t1")).toBeNull();
  });

  it("invoice.paid records a succeeded payment (idempotent) and recovers a past_due subscription", async () => {
    await handleStripeEvent(db(), evt("checkout.session.completed", { id: "cs_2", subscription: "sub_ext_2", metadata: { tenant_id: "t1", plan: "starter" } }), T0);
    const active = await db().getActiveSubscriptionByTenant("t1");
    await db().updateSubscriptionStatus("t1", active?.id ?? "", "past_due");

    const inv = evt("invoice.paid", { id: "in_1", subscription: "sub_ext_2", amount_paid: 9700, currency: "brl" });
    expect((await handleStripeEvent(db(), inv, T0)).handled).toBe("payment_recorded");
    expect((await handleStripeEvent(db(), inv, T0)).handled).toBe("payment_recorded"); // idempotent

    const pay = await db().getPaymentByProviderRef("stripe", "in_1");
    expect(pay?.status).toBe("succeeded");
    expect(pay?.amount_cents).toBe(9700);
    expect(pay?.currency).toBe("BRL");
    expect((await db().getActiveSubscriptionByTenant("t1"))?.status).toBe("active"); // recovered
    expect(await db().listInvoicesByTenant("t1")).toStrictEqual([]); // no dup payment rows leaked as invoices
  });

  it("payment_failed → past_due; subscription.deleted → canceled", async () => {
    await handleStripeEvent(db(), evt("checkout.session.completed", { id: "cs_3", subscription: "sub_ext_3", metadata: { tenant_id: "t1", plan: "pro" } }), T0);

    expect((await handleStripeEvent(db(), evt("invoice.payment_failed", { subscription: "sub_ext_3" }), T0)).handled).toBe("marked_past_due");
    expect((await db().getActiveSubscriptionByTenant("t1"))?.status).toBe("past_due");

    expect((await handleStripeEvent(db(), evt("customer.subscription.deleted", { id: "sub_ext_3" }), T0 + 1)).handled).toBe("subscription_canceled");
    expect(await db().getActiveSubscriptionByTenant("t1")).toBeNull(); // canceled excluded from active
  });

  it("ignores an unrecognized event type and events for unknown subscriptions", async () => {
    expect((await handleStripeEvent(db(), evt("payment_intent.created", {}), T0)).handled).toBe("ignored");
    expect((await handleStripeEvent(db(), evt("invoice.paid", { id: "in_z", subscription: "sub_nope", amount_paid: 1 }), T0)).handled).toBe("no_subscription");
  });

  it("isStripeEvent guards structure", () => {
    expect(isStripeEvent({ id: "e", type: "x", data: { object: {} } })).toBe(true);
    expect(isStripeEvent({ id: "e", type: "x" })).toBe(false);
    expect(isStripeEvent(null)).toBe(false);
  });
});
