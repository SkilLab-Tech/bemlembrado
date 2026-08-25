import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import { BadRequest, RateLimited, Unauthorized } from "../../src/http/errors";

function appWithBoomRoutes() {
  const app = createApp();
  app.get("/boom-bad", () => {
    throw new BadRequest("bad input");
  });
  app.get("/boom-auth", () => {
    throw new Unauthorized();
  });
  app.get("/boom-rate", () => {
    throw new RateLimited();
  });
  app.get("/boom-unknown", () => {
    throw new Error("SECRET internal detail");
  });
  return app;
}

/** Narrow an unknown JSON body to the error envelope shape (cast is necessary: unknown -> T). */
function errorOf(body: unknown): { code: unknown; message: unknown; request_id: unknown } {
  return (body as { error: { code: unknown; message: unknown; request_id: unknown } }).error;
}

describe("error envelope", () => {
  const app = appWithBoomRoutes();

  it("unknown route renders a 404 envelope", async () => {
    const res = await app.request("/missing");
    expect(res.status).toBe(404);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ error: { code: "not_found" } });
  });

  it("AppError maps to its status + code + message", async () => {
    const res = await app.request("/boom-bad");
    expect(res.status).toBe(400);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ error: { code: "bad_request", message: "bad input" } });
  });

  it("Unauthorized -> 401", async () => {
    const res = await app.request("/boom-auth");
    expect(res.status).toBe(401);
  });

  it("RateLimited -> 429", async () => {
    const res = await app.request("/boom-rate");
    expect(res.status).toBe(429);
  });

  it("unknown error -> opaque 500 envelope", async () => {
    const res = await app.request("/boom-unknown");
    expect(res.status).toBe(500);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ error: { code: "internal", message: "internal error" } });
  });

  it("unknown error never leaks the thrown message", async () => {
    const res = await app.request("/boom-unknown");
    const text = await res.text();
    expect(text).not.toContain("SECRET internal detail");
  });

  it("includes a request_id from the request-id middleware", async () => {
    const res = await app.request("/boom-bad");
    const body: unknown = await res.json();
    expect(errorOf(body).request_id).toBeTypeOf("string");
  });
});
