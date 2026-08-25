import type { Env } from "../env";
import { Internal } from "../http/errors";
import type { PlanId } from "./catalog";

/**
 * Provider-agnostic checkout seam. A checkout provider turns a
 * (tenant, plan) into a hosted payment session and returns the URL to redirect the
 * buyer to; the subscription itself is created by the provider's WEBHOOK on payment
 * confirmation (never here), so this path writes nothing to our DB.
 *
 * Stripe (cross-border) is the first wired provider, built against the documented REST
 * contract (POST /v1/checkout/sessions, mode=subscription). Mercado Pago (PIX/BRL, the
 * primary BR rail) slots into this same interface once its webhook-signature manifest is
 * verified from the official docs (deferred — not built from memory). The factory throws a
 * clear, non-secret error for any provider whose credentials/config are absent.
 */

export type CheckoutProviderId = "stripe" | "mercadopago" | "manual";

export interface CheckoutInput {
  tenantId: string;
  plan: PlanId;
  /** Where the provider redirects on success / cancel (https). Supplied by the integrating app. */
  successUrl: string;
  cancelUrl: string;
  /** Caller idempotency/correlation ref → client_reference_id. */
  clientReference: string;
}

export interface CheckoutSession {
  provider: CheckoutProviderId;
  /** Hosted checkout URL to redirect the buyer to. */
  url: string;
  /** Provider's session id — the webhook correlates this back to the tenant. */
  externalRef: string;
}

export interface CheckoutProvider {
  readonly id: CheckoutProviderId;
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
}

const STRIPE_API = "https://api.stripe.com/v1/checkout/sessions";

/** Stripe Checkout adapter (subscription mode). DI: `fetchImpl` is injectable for tests. */
export class StripeCheckout implements CheckoutProvider {
  readonly id = "stripe" as const;
  constructor(
    private readonly secretKey: string,
    /** PlanId → Stripe Price id (price_...). A plan absent here cannot check out via Stripe. */
    private readonly priceIds: Partial<Record<PlanId, string>>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const price = this.priceIds[input.plan];
    if (price === undefined) throw new Internal(`no Stripe price configured for plan "${input.plan}"`);

    // application/x-www-form-urlencoded per the Stripe REST contract. tenant_id + plan
    // travel in metadata so the webhook resolves the owning tenant (the caller has none yet).
    const form = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.clientReference,
      "metadata[tenant_id]": input.tenantId,
      "metadata[plan]": input.plan,
    });

    const res = await this.fetchImpl(STRIPE_API, {
      method: "POST",
      headers: { authorization: `Bearer ${this.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) {
      // Never surface the buyer/secret; the request-id is enough to trace in Stripe's dashboard.
      throw new Internal(`stripe checkout failed (${String(res.status)} ${res.headers.get("request-id") ?? "?"})`);
    }
    const body: { id?: unknown; url?: unknown } = await res.json();
    if (typeof body.id !== "string" || typeof body.url !== "string") {
      throw new Internal("stripe checkout returned no session url");
    }
    return { provider: this.id, url: body.url, externalRef: body.id };
  }
}

/**
 * Resolve the checkout provider for an id from env config. Throws Internal (500) with a
 * NON-secret message when a provider isn't configured/wired — an honest deployment-config
 * gap, not a client error.
 */
export function resolveCheckoutProvider(env: Env, id: CheckoutProviderId): CheckoutProvider {
  switch (id) {
    case "stripe": {
      if (env.STRIPE_SECRET_KEY === undefined || env.STRIPE_SECRET_KEY.length === 0) {
        throw new Internal("stripe checkout is not configured");
      }
      const priceIds: Partial<Record<PlanId, string>> = {};
      if (env.STRIPE_PRICE_STARTER !== undefined) priceIds.starter = env.STRIPE_PRICE_STARTER;
      if (env.STRIPE_PRICE_PRO !== undefined) priceIds.pro = env.STRIPE_PRICE_PRO;
      return new StripeCheckout(env.STRIPE_SECRET_KEY, priceIds);
    }
    case "mercadopago":
      throw new Internal("mercadopago checkout is not configured yet"); // slots into this interface once its webhook manifest is verified
    case "manual":
      throw new Internal("manual checkout is not configured");
  }
}
