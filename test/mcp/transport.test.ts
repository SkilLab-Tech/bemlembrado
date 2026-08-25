import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { createApp } from "../../src/http/app";
import { captureVectorize, fakeAi } from "../helpers/fakes";
import { appEnv } from "../helpers/env";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1.0.0" } },
};

function devEnv(): Env {
  // /mcp builds the tool-core server -> needs AI + Vectorize bindings (fakes here).
  return {
    ...appEnv,
    DEV_AUTHLESS: "true",
    ENVIRONMENT: "dev",
    AI: fakeAi() as unknown as Ai,
    VECTORIZE: captureVectorize().vectorize as unknown as VectorizeIndex,
  };
}

async function mcpPost(body: unknown, env: Env): Promise<Response> {
  return createApp().request(
    "/mcp",
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("MCP transport (/mcp)", () => {
  it("401s without an API key (auth gates the bare /mcp path)", async () => {
    const res = await mcpPost(INITIALIZE, appEnv);
    expect(res.status).toBe(401);
  });

  it("initialize round-trips: transport up, server identity + tools capability present", async () => {
    const res = await mcpPost(INITIALIZE, devEnv());
    expect(res.status).toBe(200);
    // Body framing may be JSON or SSE; assert on substance, not envelope shape.
    const text = await res.text();
    expect(text).toContain("bemlembrado"); // serverInfo.name
    expect(text).toContain("protocolVersion");
    expect(text).toContain("tools"); // capabilities advertise the tools the ping tool registered
  });
});
