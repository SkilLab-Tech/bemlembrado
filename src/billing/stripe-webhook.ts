import type { Db, SubscriptionRow } from "../db/client";

/**
 * Stripe webhook: signature verification + the subscription/payment state machine
 *. This endpoint is the SOURCE OF TRUTH for subscription state — the
 * checkout endpoint writes nothing; only a confirmed webhook activates a subscription.
 *
 * Signature scheme (verified against docs.stripe.com/webhooks):
 *   Stripe-Signature: t=<unix>,v1=<hmac>[,v0=...]  — v0 is a test-only scheme, ignored.
 *   signed_payload = `${t}.${rawBody}` ; expected = HMAC-SHA256(whsec, signed_payload) hex.
 *   Constant-time compare vs v1; reject if |now - t| > tolerance (replay protection).
 */

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Verify a Stripe-Signature header against the raw body. Returns false on any anomaly (fail-closed). */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string, now: number, toleranceSec = 300): Promise<boolean> {
  if (header === null || header.length === 0) return false;
  let t: string | undefined;
  let v1: string | undefined;
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (k === "t") t = val;
    else if (k === "v1") v1 = val; // ignore v0 (Stripe test scheme)
  }
  if (t === undefined || v1 === undefined) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSec) return false; // replay window

  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(v1);
  if (a.byteLength !== b.byteLength) return false; // timingSafeEqual throws on length mismatch
  return crypto.subtle.timingSafeEqual(a, b);
}

export function isStripeEvent(v: unknown): v is StripeEvent {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const data = o.data;
  if (typeof data !== "object" || data === null) return false;
  const obj = (data as Record<string, unknown>).object;
  return typeof o.id === "string" && typeof o.type === "string" && typeof obj === "object" && obj !== null;
}

function asStr(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === "string" ? v : null;
}
function asNum(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  return typeof v === "number" ? v : null;
}
function asObj(o: Record<string, unknown>, k: string): Record<string, unknown> {
  const v = o[k];
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/**
 * Apply a verified Stripe event to billing state. Idempotent throughout (redelivered
 * events are safe): subscription creation guards on the provider ref (+ UNIQUE backstop),
 * payment recording relies on UNIQUE(provider, external_id), status writes are set-based.
 * Returns a short label for observability/tests.
 */
export async function handleStripeEvent(db: Db, event: StripeEvent, now: number): Promise<{ handled: string }> {
  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
      const meta = asObj(obj, "metadata");
      const tenantId = asStr(meta, "tenant_id");
      const plan = asStr(meta, "plan");
      const externalRef = asStr(obj, "subscription") ?? asStr(obj, "id");
      if (tenantId === null || plan === null || externalRef === null) return { handled: "skipped_missing_metadata" };
      if ((await db.getSubscriptionByExternalRef("stripe", externalRef)) !== null) return { handled: "subscription_exists" };
      const row: SubscriptionRow = {
        id: crypto.randomUUID(), tenant_id: tenantId, plan, status: "active", provider: "stripe",
        external_ref: externalRef, current_period_start: null, current_period_end: null, created_at: now, canceled_at: null,
      };
      try {
        await db.insertSubscription(row);
        return { handled: "subscription_activated" };
      } catch (err) {
        // Lost a race on UNIQUE(provider, external_ref) — the other delivery won; idempotent.
        if ((await db.getSubscriptionByExternalRef("stripe", externalRef)) !== null) return { handled: "subscription_exists" };
        throw err;
      }
    }
    case "invoice.paid":
    case "invoice.payment_succeeded": {
      const subRef = asStr(obj, "subscription");
      const invoiceId = asStr(obj, "id");
      const amount = asNum(obj, "amount_paid");
      if (subRef === null || invoiceId === null || amount === null) return { handled: "skipped_missing_fields" };
      const sub = await db.getSubscriptionByExternalRef("stripe", subRef);
      if (sub === null) return { handled: "no_subscription" };
      const currency = (asStr(obj, "currency") ?? "brl").toUpperCase();
      try {
        await db.insertPayment({
          id: crypto.randomUUID(), tenant_id: sub.tenant_id, invoice_id: null, provider: "stripe",
          external_id: invoiceId, amount_cents: amount, currency, status: "succeeded", paid_at: now, created_at: now,
        });
      } catch {
        // UNIQUE(provider, external_id) — this invoice's payment is already recorded; no-op.
      }
      if (sub.status !== "active") await db.updateSubscriptionStatus(sub.tenant_id, sub.id, "active"); // dunning recovery
      return { handled: "payment_recorded" };
    }
    case "invoice.payment_failed": {
      const subRef = asStr(obj, "subscription");
      if (subRef === null) return { handled: "skipped_missing_fields" };
      const sub = await db.getSubscriptionByExternalRef("stripe", subRef);
      if (sub === null) return { handled: "no_subscription" };
      await db.updateSubscriptionStatus(sub.tenant_id, sub.id, "past_due");
      return { handled: "marked_past_due" };
    }
    case "customer.subscription.deleted": {
      const subRef = asStr(obj, "id");
      if (subRef === null) return { handled: "skipped_missing_fields" };
      const sub = await db.getSubscriptionByExternalRef("stripe", subRef);
      if (sub === null) return { handled: "no_subscription" };
      await db.updateSubscriptionStatus(sub.tenant_id, sub.id, "canceled", now);
      return { handled: "subscription_canceled" };
    }
    default:
      return { handled: "ignored" };
  }
}
