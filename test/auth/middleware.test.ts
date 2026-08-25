import { beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "../../src/auth/api-key";
import { Db } from "../../src/db/client";
import { createApp } from "../../src/http/app";
import { appEnv, testEnv } from "../helpers/env";

const PEPPER = "test-pepper";
const RAW = "bl_validkey";

function appWithRoute() {
  const app = createApp();
  app.get("/v1/whoami", (c) => c.json(c.var.tenant ?? null));
  return app;
}

async function seedTenantWithKey() {
  const hash = await hashApiKey(RAW, PEPPER);
  await new Db(testEnv.DB).insertTenant({ id: "t1", name: "T1", plan: "pro", api_key_hash: hash, created_at: 1 });
}

describe("apiKeyAuth", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM tenant");
  });

  it("401 without a key", async () => {
    const res = await appWithRoute().request("/v1/whoami", {}, appEnv);
    expect(res.status).toBe(401);
  });

  it("401 with an invalid key", async () => {
    const res = await appWithRoute().request("/v1/whoami", { headers: { authorization: "Bearer bl_nope" } }, appEnv);
    expect(res.status).toBe(401);
  });

  it("401 envelope carries code unauthorized", async () => {
    const res = await appWithRoute().request("/v1/whoami", {}, appEnv);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("200 + resolves tenant with a valid Bearer key", async () => {
    await seedTenantWithKey();
    const res = await appWithRoute().request("/v1/whoami", { headers: { authorization: `Bearer ${RAW}` } }, appEnv);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ id: "t1", plan: "pro" });
  });

  it("accepts the x-api-key header", async () => {
    await seedTenantWithKey();
    const res = await appWithRoute().request("/v1/whoami", { headers: { "x-api-key": RAW } }, appEnv);
    expect(res.status).toBe(200);
  });

  it("a malformed Authorization (not Bearer) -> 401", async () => {
    await seedTenantWithKey();
    const res = await appWithRoute().request("/v1/whoami", { headers: { authorization: RAW } }, appEnv);
    expect(res.status).toBe(401);
  });

  it("does not gate /health", async () => {
    const res = await appWithRoute().request("/health", {}, appEnv);
    expect(res.status).toBe(200);
  });

  it("a revoked/unknown hash never resolves a tenant", async () => {
    await seedTenantWithKey();
    const res = await appWithRoute().request("/v1/whoami", { headers: { authorization: "Bearer bl_other" } }, appEnv);
    expect(res.status).toBe(401);
  });
});
