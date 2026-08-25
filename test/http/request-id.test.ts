import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";

describe("request-id middleware", () => {
  const app = createApp();

  it("echoes a response x-request-id header", async () => {
    const res = await app.request("/health");
    expect(res.headers.get("x-request-id")).toBeTypeOf("string");
    expect(res.headers.get("x-request-id")?.length ?? 0).toBeGreaterThan(0);
  });

  it("preserves an inbound x-request-id", async () => {
    const res = await app.request("/health", { headers: { "x-request-id": "req-123" } });
    expect(res.headers.get("x-request-id")).toBe("req-123");
  });

  it("mints a fresh id per request when none is provided", async () => {
    const a = await app.request("/health");
    const b = await app.request("/health");
    const idA = a.headers.get("x-request-id");
    const idB = b.headers.get("x-request-id");
    expect(idA).not.toBe(idB);
  });
});
