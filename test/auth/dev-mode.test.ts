import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { createApp } from "../../src/http/app";
import { appEnv } from "../helpers/env";

function appWithRoute() {
  const app = createApp();
  app.get("/v1/whoami", (c) => c.json(c.var.tenant ?? null));
  return app;
}

function envWith(overrides: Partial<Env>): Env {
  return { ...appEnv, ...overrides };
}

describe("authless dev mode", () => {
  it("bypasses auth with a synthetic dev tenant in dev", async () => {
    const res = await appWithRoute().request("/v1/whoami", {}, envWith({ DEV_AUTHLESS: "true", ENVIRONMENT: "dev" }));
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ id: "dev" });
  });

  it("FAIL-SAFE: ignored in production (still 401 without a key)", async () => {
    const res = await appWithRoute().request("/v1/whoami", {}, envWith({ DEV_AUTHLESS: "true", ENVIRONMENT: "production" }));
    expect(res.status).toBe(401);
  });

  it("FAIL-SAFE: ignored in staging", async () => {
    const res = await appWithRoute().request("/v1/whoami", {}, envWith({ DEV_AUTHLESS: "true", ENVIRONMENT: "staging" }));
    expect(res.status).toBe(401);
  });

  it("with DEV_AUTHLESS off, dev still enforces auth", async () => {
    const res = await appWithRoute().request("/v1/whoami", {}, envWith({ DEV_AUTHLESS: "false", ENVIRONMENT: "dev" }));
    expect(res.status).toBe(401);
  });

  it("dev tenant has plan open", async () => {
    const res = await appWithRoute().request("/v1/whoami", {}, envWith({ DEV_AUTHLESS: "true", ENVIRONMENT: "dev" }));
    const body: unknown = await res.json();
    expect(body).toMatchObject({ plan: "open" });
  });
});
