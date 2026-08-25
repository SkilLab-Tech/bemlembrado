import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import { appEnv } from "../helpers/env";

function app() {
  return createApp();
}

describe("security headers", () => {
  it("sets the OWASP baseline on a 200 response", async () => {
    const res = await app().request("/health", {}, appEnv);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("applies the baseline to error responses too (404)", async () => {
    const res = await app().request("/nope", {}, appEnv);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});

describe("CORS", () => {
  it("answers an OPTIONS preflight with allow headers", async () => {
    const res = await app().request(
      "/v1/memory",
      { method: "OPTIONS", headers: { origin: "https://example.com", "access-control-request-method": "POST" } },
      appEnv,
    );
    expect(res.headers.get("access-control-allow-origin")).not.toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("sets access-control-allow-origin on a normal response", async () => {
    const res = await app().request("/health", { headers: { origin: "https://example.com" } }, appEnv);
    expect(res.headers.get("access-control-allow-origin")).not.toBeNull();
  });
});
