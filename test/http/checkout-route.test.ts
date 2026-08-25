import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { createApp } from "../../src/http/app";
import { resetDb, seedTenant } from "../helpers/fixtures";
import { appEnv } from "../helpers/env";

function devEnv(overrides: Partial<Env> = {}): Env {
  return { ...appEnv, DEV_AUTHLESS: "true", ENVIRONMENT: "dev", ...overrides };
}
async function checkout(body: unknown, env: Env): Promise<Response> {
  return createApp().request("/v1/billing/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
}
const OK = { plan: "pro", successUrl: "https://app.example.com/ok", cancelUrl: "https://app.example.com/no" };

describe("POST /v1/billing/checkout", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("dev");
  });

  it("401 without an API key", async () => {
    expect((await checkout(OK, appEnv)).status).toBe(401);
  });

  it("400 on an unpayable plan or a missing/invalid redirect url", async () => {
    expect((await checkout({ ...OK, plan: "open" }, devEnv())).status).toBe(400); // open is free/self-host
    expect((await checkout({ ...OK, plan: "managed" }, devEnv())).status).toBe(400); // managed is custom-quoted
    expect((await checkout({ plan: "pro", cancelUrl: "https://x/y" }, devEnv())).status).toBe(400); // successUrl missing
    expect((await checkout({ ...OK, successUrl: "not-a-url" }, devEnv())).status).toBe(400);
  });

  it("500 not-configured until Stripe creds are set (honest deployment gap, no secret leaked)", async () => {
    const res = await checkout(OK, devEnv()); // test env has no STRIPE_SECRET_KEY
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "internal" } });
  });
});
