import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import { appEnv } from "../helpers/env";

describe("GET /openapi.json", () => {
  it("serves a valid OpenAPI 3.1 doc unauthenticated, covering the core endpoints", async () => {
    const res = await createApp().request("/openapi.json", {}, appEnv); // no key -> still 200 (public)
    expect(res.status).toBe(200);
    const raw: unknown = await res.json();
    const spec = raw as { openapi: string; servers: { url: string }[]; paths: Record<string, unknown>; components: { securitySchemes: Record<string, unknown> } };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers[0]?.url).toContain("http");
    for (const p of ["/v1/memory", "/v1/search", "/v1/turn", "/v1/usage", "/v1/notes/search", "/v1/sessions/{id}/context"]) {
      expect(Object.keys(spec.paths)).toContain(p);
    }
    expect(spec.components.securitySchemes).toHaveProperty("bearerAuth");
  });

  it("is not gated by API-key auth", async () => {
    // health is public; openapi must be too (no Authorization header).
    expect((await createApp().request("/openapi.json", {}, appEnv)).status).toBe(200);
  });
});
