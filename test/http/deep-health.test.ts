import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import { appEnv } from "../helpers/env";

describe("GET /health/deep", () => {
  it("pings D1 live + reports binding presence (public, 200 when D1 is up)", async () => {
    const res = await createApp().request("/health/deep", {}, appEnv); // no key -> still served
    expect(res.status).toBe(200);
    const raw: unknown = await res.json();
    const body = raw as { status: string; checks: { d1: string; kv: string; vectorize: string; vault: string } };
    expect(body.status).toBe("ok");
    expect(body.checks.d1).toBe("ok"); // live SELECT 1
    expect(body.checks.kv).toBe("ok"); // bound in env.test
    expect(body.checks.vault).toBe("ok"); // R2 bound in env.test
    expect(body.checks.vectorize).toBe("absent"); // omitted from env.test (no local sim)
  });
});
