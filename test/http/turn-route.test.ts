import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { createApp } from "../../src/http/app";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { captureVectorize } from "../helpers/fakes";
import { appEnv, testEnv } from "../helpers/env";

/** One fake AI binding serving BOTH embeddings ({data}) and chat ({response,usage}). */
const dualAi = {
  run: () => Promise.resolve({ data: [[0.1, 0.2, 0.3]], response: "blue sky reply", usage: { prompt_tokens: 40, completion_tokens: 8 } }),
};

function devEnv(): Env {
  return {
    ...appEnv,
    DEV_AUTHLESS: "true",
    ENVIRONMENT: "dev",
    AI: dualAi as unknown as Ai,
    VECTORIZE: captureVectorize().vectorize as unknown as VectorizeIndex,
  };
}

async function postTurn(body: unknown, env: Env): Promise<Response> {
  return createApp().request(
    "/v1/turn",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
}

describe("REST POST /v1/turn", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("dev");
    await seedNamespace("nd", "dev", "agent-a");
  });

  it("401 without an API key", async () => {
    const res = await postTurn({ sessionId: "s1", namespace: "agent-a", message: "hi" }, appEnv);
    expect(res.status).toBe(401);
  });

  it("200: returns reply + usage + provenance and records a USAGE_EVENT", async () => {
    const res = await postTurn({ sessionId: "s1", namespace: "agent-a", message: "why is the sky blue?" }, devEnv());
    expect(res.status).toBe(200);
    const raw: unknown = await res.json();
    const body = raw as { reply: string; usage: { provider: string; fresh: number }; provenance: unknown[] };
    expect(body.reply).toBe("blue sky reply");
    expect(body.usage.provider).toBe("workers-ai");
    expect(body.usage.fresh).toBe(48);
    expect(Array.isArray(body.provenance)).toBe(true);

    expect((await db().listUsageEventsByTenant("dev")).length).toBe(1);
  });

  it("400 on an invalid body (missing message / oversized)", async () => {
    expect((await postTurn({ sessionId: "s1", namespace: "agent-a" }, devEnv())).status).toBe(400);
    expect((await postTurn({ sessionId: "s1", namespace: "agent-a", message: "x".repeat(8001) }, devEnv())).status).toBe(400);
  });
});

describe("REST POST /v1/turn — failure corpus (F5 #123 HTTP wiring)", () => {
  /** An AI binding that always rejects → forces runTurn (embed/chat) to throw. */
  const throwingAi = { run: () => Promise.reject(new Error("ai upstream down")) };

  function failEnv(overrides: Partial<Env> = {}): Env {
    return {
      ...appEnv,
      DEV_AUTHLESS: "true",
      ENVIRONMENT: "dev",
      AI: throwingAi as unknown as Ai,
      VECTORIZE: captureVectorize().vectorize as unknown as VectorizeIndex,
      ...overrides,
    };
  }

  async function clearFailures(): Promise<void> {
    const { keys } = await testEnv.KV.list({ prefix: "t:dev:fail:" });
    for (const k of keys) await testEnv.KV.delete(k.name);
  }

  beforeEach(async () => {
    await resetDb();
    await seedTenant("dev");
    await seedNamespace("nd", "dev", "agent-a");
    await clearFailures();
  });

  it("records a REDACTED failure entry in KV when a turn throws (flag ON)", async () => {
    const res = await postTurn({ sessionId: "s1", namespace: "agent-a", message: "boom" }, failEnv({ FAILURE_CORPUS_ENABLED: "true" }));
    expect(res.status).toBeGreaterThanOrEqual(500); // original error is never masked
    const { keys } = await testEnv.KV.list({ prefix: "t:dev:fail:" });
    expect(keys.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT record when the flag is off (default): failure still propagates, no corpus write", async () => {
    const res = await postTurn({ sessionId: "s1", namespace: "agent-a", message: "boom" }, failEnv());
    expect(res.status).toBeGreaterThanOrEqual(500);
    const { keys } = await testEnv.KV.list({ prefix: "t:dev:fail:" });
    expect(keys.length).toBe(0);
  });
});
