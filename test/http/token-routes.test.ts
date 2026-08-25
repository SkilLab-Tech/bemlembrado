import { beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "../../src/auth/api-key";
import { Db } from "../../src/db/client";
import { createApp } from "../../src/http/app";
import { appEnv, testEnv } from "../helpers/env";

const PEPPER = "test-pepper";
const KEY_T1 = "bl_tenant1key";
const KEY_T2 = "bl_tenant2key";

function bearer(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

async function seed() {
  await testEnv.DB.exec("DELETE FROM tenant");
  const db = new Db(testEnv.DB);
  await db.insertTenant({ id: "t1", name: "T1", plan: "pro", api_key_hash: await hashApiKey(KEY_T1, PEPPER), created_at: 1 });
  await db.insertTenant({ id: "t2", name: "T2", plan: "pro", api_key_hash: await hashApiKey(KEY_T2, PEPPER), created_at: 1 });
}

interface IssueResp { id: string; token: string; scopes: string[]; expiresAt: number | null }

async function issue(app: ReturnType<typeof createApp>, key: string, scopes: string[]): Promise<{ status: number; body: IssueResp }> {
  const res = await app.request(
    "/v1/tokens",
    { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ scopes }) },
    appEnv,
  );
  const body: IssueResp = await res.json();
  return { status: res.status, body };
}

describe("token management routes", () => {
  beforeEach(seed);

  it("API key issues a scoped token (201, raw token returned once)", async () => {
    const { status, body } = await issue(createApp(), KEY_T1, ["memory:read"]);
    expect(status).toBe(201);
    expect(body.token.startsWith("blt_")).toBe(true);
    expect(body.scopes).toStrictEqual(["memory:read"]);
  });

  it("GET /v1/tokens lists metadata only — never the hash or raw token", async () => {
    const app = createApp();
    await issue(app, KEY_T1, ["memory:read", "memory:write"]);
    const res = await app.request("/v1/tokens", bearer(KEY_T1), appEnv);
    expect(res.status).toBe(200);
    const body: { tokens: Record<string, unknown>[] } = await res.json();
    expect(body.tokens).toHaveLength(1);
    const t = body.tokens[0] ?? {};
    expect(t).toHaveProperty("id");
    expect(t.scopes).toBe("memory:read memory:write");
    expect(t).not.toHaveProperty("token_hash");
    expect(t).not.toHaveProperty("token");
  });

  it("a scoped token CANNOT mint tokens — privilege escalation blocked (403)", async () => {
    const app = createApp();
    const { body } = await issue(app, KEY_T1, ["memory:read", "memory:write"]);
    const res = await app.request(
      "/v1/tokens",
      { method: "POST", headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" }, body: JSON.stringify({ scopes: ["memory:read"] }) },
      appEnv,
    );
    expect(res.status).toBe(403);
  });

  it("a scoped token cannot list or revoke tokens (403)", async () => {
    const app = createApp();
    const { body } = await issue(app, KEY_T1, ["memory:read"]);
    const list = await app.request("/v1/tokens", bearer(body.token), appEnv);
    expect(list.status).toBe(403);
    const del = await app.request(`/v1/tokens/${body.id}`, { method: "DELETE", ...bearer(body.token) }, appEnv);
    expect(del.status).toBe(403);
  });

  it("revoke works, is idempotent-404 on repeat, and the revoked token stops authenticating", async () => {
    const app = createApp();
    const { body } = await issue(app, KEY_T1, ["memory:read"]);
    const del1 = await app.request(`/v1/tokens/${body.id}`, { method: "DELETE", ...bearer(KEY_T1) }, appEnv);
    expect(del1.status).toBe(200);
    const del2 = await app.request(`/v1/tokens/${body.id}`, { method: "DELETE", ...bearer(KEY_T1) }, appEnv);
    expect(del2.status).toBe(404); // already revoked
    // the revoked token no longer authenticates
    const after = await app.request("/v1/tokens", bearer(body.token), appEnv);
    expect(after.status).toBe(401);
  });

  it("cross-tenant revoke is refused (404, no oracle)", async () => {
    const app = createApp();
    const { body } = await issue(app, KEY_T1, ["memory:read"]);
    const del = await app.request(`/v1/tokens/${body.id}`, { method: "DELETE", ...bearer(KEY_T2) }, appEnv);
    expect(del.status).toBe(404);
    // t1's token is still valid → t2 could not revoke it
    const list = await app.request("/v1/tokens", bearer(KEY_T1), appEnv);
    const body2: { tokens: { revokedAt: number | null }[] } = await list.json();
    expect(body2.tokens[0]?.revokedAt).toBeNull();
  });

  it("rejects empty or unknown-only scope sets (400)", async () => {
    const app = createApp();
    const empty = await app.request(
      "/v1/tokens",
      { method: "POST", headers: { authorization: `Bearer ${KEY_T1}`, "content-type": "application/json" }, body: JSON.stringify({ scopes: [] }) },
      appEnv,
    );
    expect(empty.status).toBe(400);
    const bogus = await app.request(
      "/v1/tokens",
      { method: "POST", headers: { authorization: `Bearer ${KEY_T1}`, "content-type": "application/json" }, body: JSON.stringify({ scopes: ["nope:nope"] }) },
      appEnv,
    );
    expect(bogus.status).toBe(400);
  });
});
