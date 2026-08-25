import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { createApp } from "../../src/http/app";
import { db as fixDb, resetDb, seedTenant } from "../helpers/fixtures";
import { appEnv } from "../helpers/env";

const SECRET = "whsec_route_test";

function envWith(overrides: Partial<Env> = {}): Env {
  return { ...appEnv, STRIPE_WEBHOOK_SECRET: SECRET, ...overrides };
}
async function sign(body: string, secret = SECRET): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${String(ts)}.${body}`));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${String(ts)},v1=${hex}`;
}
async function post(body: string, env: Env, sig?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sig !== undefined) headers["stripe-signature"] = sig;
  return createApp().request("/webhooks/stripe", { method: "POST", headers, body }, env);
}

describe("POST /webhooks/stripe", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
  });

  it("500 when the webhook secret is not configured", async () => {
    const res = await createApp().request("/webhooks/stripe", { method: "POST", body: "{}" }, appEnv); // appEnv has no secret
    expect(res.status).toBe(500);
  });

  it("401 on a missing or invalid signature (no state change)", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs", subscription: "sub_a", metadata: { tenant_id: "t1", plan: "pro" } } } });
    expect((await post(body, envWith())).status).toBe(401); // no signature header
    expect((await post(body, envWith(), "t=1,v1=deadbeef")).status).toBe(401); // bad signature
    expect(await fixDb().getActiveSubscriptionByTenant("t1")).toBeNull();
  });

  it("200 + activates the subscription on a correctly-signed event", async () => {
    const body = JSON.stringify({ id: "evt_2", type: "checkout.session.completed", data: { object: { id: "cs2", subscription: "sub_b", metadata: { tenant_id: "t1", plan: "pro" } } } });
    const res = await post(body, envWith(), await sign(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, handled: "subscription_activated" });
    expect((await fixDb().getActiveSubscriptionByTenant("t1"))?.plan).toBe("pro");
  });
});
