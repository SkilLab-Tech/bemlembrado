import { beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "../../src/auth/api-key";
import { issueScopedToken } from "../../src/auth/scoped-token";
import { Db } from "../../src/db/client";
import { requireScope } from "../../src/http/middleware/require-scope";
import { createApp } from "../../src/http/app";
import { appEnv, testEnv } from "../helpers/env";

const PEPPER = "test-pepper";
const API_KEY = "bl_fullaccess";

/** App with a scope-guarded probe route appended (avoids needing AI/Vectorize). */
function app() {
  const a = createApp();
  a.get("/v1/needs-write", requireScope("memory:write"), (c) => c.json({ ok: true }));
  a.get("/v1/needs-read", requireScope("memory:read"), (c) => c.json({ ok: true }));
  return a;
}

async function seed() {
  await testEnv.DB.exec("DELETE FROM tenant");
  await new Db(testEnv.DB).insertTenant({ id: "t1", name: "T1", plan: "pro", api_key_hash: await hashApiKey(API_KEY, PEPPER), created_at: 1 });
}

describe("requireScope (scope enforcement, F5 #115)", () => {
  beforeEach(seed);

  it("an API key carries ALL scopes — write route passes", async () => {
    const res = await app().request("/v1/needs-write", { headers: { authorization: `Bearer ${API_KEY}` } }, appEnv);
    expect(res.status).toBe(200);
  });

  it("a read-only scoped token is FORBIDDEN on a write route (403)", async () => {
    const { token } = await issueScopedToken(new Db(testEnv.DB), PEPPER, "t1", ["memory:read"], Date.now());
    const res = await app().request("/v1/needs-write", { headers: { authorization: `Bearer ${token}` } }, appEnv);
    expect(res.status).toBe(403);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ error: { code: "forbidden" } });
  });

  it("the same read-only token IS allowed on a read route (200)", async () => {
    const { token } = await issueScopedToken(new Db(testEnv.DB), PEPPER, "t1", ["memory:read"], Date.now());
    const res = await app().request("/v1/needs-read", { headers: { authorization: `Bearer ${token}` } }, appEnv);
    expect(res.status).toBe(200);
  });

  it("a write-scoped token passes the write route", async () => {
    const { token } = await issueScopedToken(new Db(testEnv.DB), PEPPER, "t1", ["memory:read", "memory:write"], Date.now());
    const res = await app().request("/v1/needs-write", { headers: { authorization: `Bearer ${token}` } }, appEnv);
    expect(res.status).toBe(200);
  });

  it("a revoked/expired/unknown scoped token is 401 (never silent access)", async () => {
    const res = await app().request("/v1/needs-read", { headers: { authorization: "Bearer blt_bogus" } }, appEnv);
    expect(res.status).toBe(401);
  });
});
