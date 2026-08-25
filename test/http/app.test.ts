import { describe, expect, it } from "vitest";
import { createApp, VERSION } from "../../src/http/app";

describe("app", () => {
  const app = createApp();

  it("GET /health returns 200", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("GET /health returns status ok + version", async () => {
    const res = await app.request("/health");
    const body: unknown = await res.json();
    expect(body).toMatchObject({ status: "ok", version: VERSION });
  });

  it("unknown route returns 404", async () => {
    const res = await app.request("/does-not-exist");
    expect(res.status).toBe(404);
  });
});
