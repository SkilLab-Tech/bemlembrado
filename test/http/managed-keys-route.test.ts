import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { createApp } from "../../src/http/app";
import { resetDb, seedTenant } from "../helpers/fixtures";
import { appEnv } from "../helpers/env";

const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
function env(overrides: Partial<Env> = {}): Env {
  return { ...appEnv, DEV_AUTHLESS: "true", ENVIRONMENT: "dev", BYOK_KEK: KEK, ...overrides };
}
async function req(method: string, path: string, e: Env, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return createApp().request(path, init, e);
}

describe("BYOK key management routes", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("dev");
  });

  it("401 without an API key", async () => {
    expect((await createApp().request("/v1/managed/keys", { method: "GET" }, appEnv)).status).toBe(401);
  });

  it("store (201) → GET returns metadata but NOT the key → delete (200) → GET empty", async () => {
    expect((await req("POST", "/v1/managed/keys", env(), { provider: "anthropic", apiKey: "sk-ant-secret" })).status).toBe(201);

    const listed = await req("GET", "/v1/managed/keys", env());
    const body: { keys: { provider: string }[] } = await listed.json();
    expect(body.keys.map((k) => k.provider)).toContain("anthropic");
    expect(JSON.stringify(body)).not.toContain("sk-ant"); // key material never surfaced

    expect((await req("DELETE", "/v1/managed/keys/anthropic", env())).status).toBe(200);
    const after: { keys: unknown[] } = await (await req("GET", "/v1/managed/keys", env())).json();
    expect(after.keys).toStrictEqual([]);
  });

  it("400 on a bad provider or a too-short key; 500 when BYOK is not configured", async () => {
    expect((await req("POST", "/v1/managed/keys", env(), { provider: "openai", apiKey: "sk-xxxxxxxx" })).status).toBe(400);
    expect((await req("POST", "/v1/managed/keys", env(), { provider: "anthropic", apiKey: "x" })).status).toBe(400);
    expect((await req("POST", "/v1/managed/keys", env({ BYOK_KEK: "" }), { provider: "anthropic", apiKey: "sk-ant-secret" })).status).toBe(500);
    expect((await req("DELETE", "/v1/managed/keys/openai", env())).status).toBe(404);
  });
});
