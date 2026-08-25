import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { hashApiKey } from "../../src/auth/api-key";
import { issueScopedToken } from "../../src/auth/scoped-token";
import { Db } from "../../src/db/client";
import { createApp } from "../../src/http/app";
import { recordUsage } from "../../src/usage/record";
import { db, resetDb, seedTenant } from "../helpers/fixtures";
import { appEnv, testEnv } from "../helpers/env";

function devEnv(): Env {
  return { ...appEnv, DEV_AUTHLESS: "true", ENVIRONMENT: "dev" };
}

describe("REST GET /v1/usage", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("dev");
  });

  it("401 without an API key", async () => {
    expect((await createApp().request("/v1/usage", {}, appEnv)).status).toBe(401);
  });

  it("returns the token splits + savings ratio for the tenant", async () => {
    await recordUsage(db(), { tenantId: "dev", sessionId: "s1", usage: { provider: "anthropic", model: "c", fresh: 100, cacheRead: 0, cacheWrite: 3000, cacheReported: true } }, 1);
    await recordUsage(db(), { tenantId: "dev", sessionId: "s1", usage: { provider: "anthropic", model: "c", fresh: 100, cacheRead: 3000, cacheWrite: 0, cacheReported: true } }, 2);

    const res = await createApp().request("/v1/usage", {}, devEnv());
    expect(res.status).toBe(200);
    const raw: unknown = await res.json();
    const body = raw as { turns: number; tokensCacheRead: number; savingsRatio: number | null };
    expect(body.turns).toBe(2);
    expect(body.tokensCacheRead).toBe(3000);
    expect(body.savingsRatio).toBeCloseTo(3000 / 3200, 4); // cacheRead 3000 / (cacheRead 3000 + fresh 200)
  });

  it("?session= filters to one session", async () => {
    await recordUsage(db(), { tenantId: "dev", sessionId: "s1", usage: { provider: "workers-ai", model: "w", fresh: 10, cacheRead: 0, cacheWrite: 0, cacheReported: false } }, 1);
    await recordUsage(db(), { tenantId: "dev", sessionId: "s2", usage: { provider: "workers-ai", model: "w", fresh: 99, cacheRead: 0, cacheWrite: 0, cacheReported: false } }, 2);

    const res = await createApp().request("/v1/usage?session=s2", {}, devEnv());
    const raw: unknown = await res.json();
    expect((raw as { tokensFresh: number; turns: number }).tokensFresh).toBe(99);
    expect((raw as { turns: number }).turns).toBe(1);
  });
});

describe("REST GET /v1/usage — scope enforcement", () => {
  const PEPPER = "test-pepper";
  const API_KEY = "bl_usagefull";

  beforeEach(async () => {
    await resetDb();
    await new Db(testEnv.DB).insertTenant({ id: "t1", name: "T1", plan: "pro", api_key_hash: await hashApiKey(API_KEY, PEPPER), created_at: 1 });
  });

  it("a full API key reads usage (carries all scopes)", async () => {
    const res = await createApp().request("/v1/usage", { headers: { authorization: `Bearer ${API_KEY}` } }, appEnv);
    expect(res.status).toBe(200);
  });

  it("a memory:read scoped token reads usage (200)", async () => {
    const { token } = await issueScopedToken(new Db(testEnv.DB), PEPPER, "t1", ["memory:read"], Date.now());
    const res = await createApp().request("/v1/usage", { headers: { authorization: `Bearer ${token}` } }, appEnv);
    expect(res.status).toBe(200);
  });

  it("a token WITHOUT memory:read is FORBIDDEN (403) — usage is no longer readable by any scope", async () => {
    const { token } = await issueScopedToken(new Db(testEnv.DB), PEPPER, "t1", ["session:read"], Date.now());
    const res = await createApp().request("/v1/usage", { headers: { authorization: `Bearer ${token}` } }, appEnv);
    expect(res.status).toBe(403);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ error: { code: "forbidden" } });
  });
});
