import { describe, expect, it } from "vitest";
import { StripeCheckout, resolveCheckoutProvider } from "../../src/billing/checkout";
import type { Env } from "../../src/env";
import { appEnv } from "../helpers/env";

const INPUT = {
  tenantId: "t1",
  plan: "pro" as const,
  successUrl: "https://app.example.com/ok",
  cancelUrl: "https://app.example.com/no",
  clientReference: "req-123",
};

/** A fetch double that records the last call and returns a scripted Response. */
function fakeFetch(response: Response): { fetch: typeof fetch; lastCall: () => { url: RequestInfo | URL; init: RequestInit } } {
  let captured: { url: RequestInfo | URL; init: RequestInit } | undefined;
  const fn = ((input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: input, init: init ?? {} };
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetch: fn, lastCall: () => captured ?? { url: "", init: {} } };
}

function okResponse() {
  return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("StripeCheckout adapter", () => {
  it("POSTs the documented subscription-mode form contract and returns the hosted url", async () => {
    const dbl = fakeFetch(okResponse());
    const sut = new StripeCheckout("sk_test_x", { pro: "price_pro" }, dbl.fetch);
    const session = await sut.createCheckout(INPUT);

    expect(session).toStrictEqual({ provider: "stripe", url: "https://checkout.stripe.com/c/pay/cs_test_1", externalRef: "cs_test_1" });

    const { url, init } = dbl.lastCall();
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk_test_x");
    const form = new URLSearchParams(init.body as string);
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("line_items[0][price]")).toBe("price_pro");
    expect(form.get("success_url")).toBe(INPUT.successUrl);
    expect(form.get("client_reference_id")).toBe("req-123");
    expect(form.get("metadata[tenant_id]")).toBe("t1"); // webhook resolves the tenant from here
    expect(form.get("metadata[plan]")).toBe("pro");
  });

  it("throws when the plan has no configured Stripe price (no silent wrong-price checkout)", async () => {
    const dbl = fakeFetch(okResponse());
    const sut = new StripeCheckout("sk_test_x", { starter: "price_starter" }, dbl.fetch); // no `pro`
    await expect(sut.createCheckout(INPUT)).rejects.toThrow(/no Stripe price/);
  });

  it("throws on a non-2xx Stripe response without leaking the body", async () => {
    const dbl = fakeFetch(new Response("{\"error\":\"bad\"}", { status: 402 }));
    const sut = new StripeCheckout("sk_test_x", { pro: "price_pro" }, dbl.fetch);
    await expect(sut.createCheckout(INPUT)).rejects.toThrow(/stripe checkout failed \(402/);
  });

  it("throws when Stripe returns no session url", async () => {
    const dbl = fakeFetch(new Response(JSON.stringify({ id: "cs_1" }), { status: 200, headers: { "content-type": "application/json" } }));
    const sut = new StripeCheckout("sk_test_x", { pro: "price_pro" }, dbl.fetch);
    await expect(sut.createCheckout(INPUT)).rejects.toThrow(/no session url/);
  });
});

describe("resolveCheckoutProvider factory", () => {
  it("returns a Stripe provider when the secret key is set", () => {
    const env: Env = { ...appEnv, STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_PRO: "price_pro" };
    expect(resolveCheckoutProvider(env, "stripe").id).toBe("stripe");
  });

  it("throws (honest config gap) when Stripe is not configured, or for an unwired provider", () => {
    expect(() => resolveCheckoutProvider(appEnv, "stripe")).toThrow(/not configured/); // test env has no STRIPE_SECRET_KEY
    expect(() => resolveCheckoutProvider({ ...appEnv, STRIPE_SECRET_KEY: "sk_x" }, "mercadopago")).toThrow(/not configured yet/);
    expect(() => resolveCheckoutProvider(appEnv, "manual")).toThrow(/not configured/);
  });
});
