import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { createApp } from "../../src/http/app";
import { type Bucket, consumeToken, rateLimit } from "../../src/http/middleware/rate-limit";
import { appEnv } from "../helpers/env";

const OPTS = { capacity: 2, refillPerSec: 1, routeClass: "test" };

// --- pure token-bucket logic (deterministic) ---
describe("consumeToken", () => {
  it("allows and decrements from a full bucket", () => {
    const d = consumeToken({ tokens: 2, updatedAt: 0 }, OPTS, 0);
    expect(d.allowed).toBe(true);
    expect(d.bucket.tokens).toBe(1);
  });

  it("denies when empty and reports a Retry-After", () => {
    const d = consumeToken({ tokens: 0, updatedAt: 0 }, OPTS, 0);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("refills over elapsed time", () => {
    // empty at t=0; 2s later at 1 token/s -> 2 tokens available again
    const d = consumeToken({ tokens: 0, updatedAt: 0 }, OPTS, 2000);
    expect(d.allowed).toBe(true);
  });

  it("never refills above capacity", () => {
    const d = consumeToken({ tokens: 0, updatedAt: 0 }, OPTS, 1_000_000);
    expect(d.bucket.tokens).toBeLessThanOrEqual(OPTS.capacity);
  });

  it("refillPerSec=0 falls back to a fixed Retry-After", () => {
    const d = consumeToken({ tokens: 0, updatedAt: 0 }, { ...OPTS, refillPerSec: 0 }, 5000);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSec).toBe(60);
  });
});

// --- middleware integration (best-effort; tolerant of KV consistency) ---
function rlApp(capacity: number) {
  const app = createApp();
  app.use("/v1/rl", rateLimit({ capacity, refillPerSec: 0, routeClass: "test" }));
  app.get("/v1/rl", (c) => c.text("ok"));
  return app;
}

function env(enabled: boolean): Env {
  return { ...appEnv, DEV_AUTHLESS: "true", ENVIRONMENT: "dev", RATE_LIMIT_ENABLED: enabled ? "true" : "false" };
}

describe("rate limit middleware", () => {
  it("disabled: never limits", async () => {
    const app = rlApp(1);
    for (let i = 0; i < 5; i++) {
      expect((await app.request("/v1/rl", {}, env(false))).status).toBe(200);
    }
  });

  it("enabled: a 429 appears within a bounded number of hits", async () => {
    const app = rlApp(2);
    const e = env(true);
    let saw429 = false;
    let retryAfter: string | null = null;
    for (let i = 0; i < 8 && !saw429; i++) {
      const res = await app.request("/v1/rl", {}, e);
      if (res.status === 429) {
        saw429 = true;
        retryAfter = res.headers.get("retry-after");
        const body: unknown = await res.json();
        expect(body).toMatchObject({ error: { code: "rate_limited" } });
      }
    }
    expect(saw429).toBe(true);
    expect(retryAfter).not.toBeNull();
  });

  it("type guard: Bucket shape is JSON-round-trippable", () => {
    const b: Bucket = { tokens: 1, updatedAt: 123 };
    expect(JSON.parse(JSON.stringify(b))).toStrictEqual(b);
  });
});
