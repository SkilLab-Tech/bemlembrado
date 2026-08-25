import { beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "../../src/auth/api-key";
import { Db } from "../../src/db/client";
import { createApp } from "../../src/http/app";
import { bootstrapDefaults } from "../../src/onboarding/defaults";
import { buildOnboarding } from "../../src/onboarding/connect";
import { appEnv, testEnv } from "../helpers/env";

const PEPPER = "test-pepper";
const RAW = "bl_onboardkey";

describe("bootstrapDefaults", () => {
  it("ships sane zero-config defaults (council OFF, default namespace)", () => {
    const d = bootstrapDefaults();
    expect(d.namespaceLabel).toBe("default");
    expect(d.councilEnabled).toBe(false);
    expect(d.embedModel).toContain("bge-m3");
  });
});

describe("buildOnboarding", () => {
  it("builds the one-line MCP connect string + REST base from the origin", () => {
    const info = buildOnboarding("https://api.bemlembrado.com");
    expect(info.namespace).toBe("default");
    expect(info.mcp.url).toBe("https://api.bemlembrado.com/mcp");
    expect(info.mcp.config.mcpServers.bemlembrado.headers.Authorization).toBe("Bearer <YOUR_API_KEY>");
    expect(info.rest.base).toBe("https://api.bemlembrado.com/v1");
    expect(info.defaults.councilEnabled).toBe(false);
  });
});

describe("GET /v1/onboarding (zero-config, authed)", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM tenant");
    const hash = await hashApiKey(RAW, PEPPER);
    await new Db(testEnv.DB).insertTenant({ id: "t1", name: "T1", plan: "open", api_key_hash: hash, created_at: 1 });
  });

  it("requires auth", async () => {
    const res = await createApp().request("/v1/onboarding", {}, appEnv);
    expect(res.status).toBe(401);
  });

  it("returns the connect string with a placeholder key (raw key never echoed)", async () => {
    const res = await createApp().request("/v1/onboarding", { headers: { authorization: `Bearer ${RAW}` } }, appEnv);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({
      namespace: "default",
      mcp: { config: { mcpServers: { bemlembrado: { headers: { Authorization: "Bearer <YOUR_API_KEY>" } } } } },
    });
    expect(JSON.stringify(body)).toContain("/mcp");
    expect(JSON.stringify(body)).not.toContain(RAW); // the real key is never returned
  });
});
