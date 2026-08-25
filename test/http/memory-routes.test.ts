import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { createApp } from "../../src/http/app";
import { Audit } from "../../src/lgpd/audit";
import { captureVectorize, fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { appEnv } from "../helpers/env";

/** dev-authless env (synthetic tenant "dev"), with injected AI + a SHARED vectorize. */
function devEnv(vectorize = captureVectorize().vectorize, overrides: Partial<Env> = {}): Env {
  return {
    ...appEnv,
    DEV_AUTHLESS: "true",
    ENVIRONMENT: "dev",
    AI: fakeAi() as unknown as Ai,
    VECTORIZE: vectorize as unknown as VectorizeIndex,
    ...overrides,
  };
}

async function post(path: string, body: unknown, env: Env): Promise<Response> {
  return createApp().request(
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
}

async function get(path: string, env: Env): Promise<Response> {
  return createApp().request(path, {}, env);
}

describe("REST /v1/memory + /v1/search", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("dev");
    await seedNamespace("nd", "dev", "agent-a");
  });

  it("401s without an API key (auth gates /v1/*)", async () => {
    // appEnv = real auth (no dev bypass); no Authorization header.
    const res = await post("/v1/memory", { namespace: "agent-a", text: "x" }, appEnv);
    expect(res.status).toBe(401);
  });

  it("add (201) then search (200) round-trip through the SAME store", async () => {
    const { vectorize } = captureVectorize();
    const env = devEnv(vectorize);

    const addRes = await post("/v1/memory", { namespace: "agent-a", text: "the sky is blue" }, env);
    expect(addRes.status).toBe(201);
    const addedRaw: unknown = await addRes.json();
    const added = addedRaw as { id: string };
    expect(added.id.length).toBeGreaterThan(0);

    const searchRes = await post("/v1/search", { namespace: "agent-a", query: "sky" }, env);
    expect(searchRes.status).toBe(200);
    const foundRaw: unknown = await searchRes.json();
    const found = foundRaw as { hits: { id: string; text: string | null }[] };
    expect(found.hits.map((h) => h.id)).toContain(added.id);
    expect(found.hits.find((h) => h.id === added.id)?.text).toBe("the sky is blue");
  });

  it("records the write audit with the key fingerprint as actor", async () => {
    await post("/v1/memory", { namespace: "agent-a", text: "remember this" }, devEnv());
    const rows = await new Audit(db()).list("dev");
    expect(rows.length).toBe(1);
    expect(rows[0]?.action).toBe("write");
    expect(rows[0]?.actor).toBe("dev"); // dev-authless fingerprint
    expect(rows[0]?.target).toMatch(/^mem:agent-a#/);
  });

  it("400s on a body that violates the tool-core bounds", async () => {
    const env = devEnv();
    expect((await post("/v1/memory", { namespace: "agent-a" }, env)).status).toBe(400); // missing text
    expect((await post("/v1/search", { namespace: "agent-a", query: "x".repeat(1001) }, env)).status).toBe(400);
    // malformed JSON -> empty object -> zod rejects required fields -> 400
    const malformed = await createApp().request(
      "/v1/memory",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" },
      env,
    );
    expect(malformed.status).toBe(400);
  });

  it("stays functional with the rate limiter enabled (under capacity)", async () => {
    const env = devEnv(captureVectorize().vectorize, { RATE_LIMIT_ENABLED: "true" });
    for (let i = 0; i < 3; i++) {
      const res = await post("/v1/memory", { namespace: "agent-a", text: `m${String(i)}` }, env);
      expect(res.status).toBe(201);
    }
  });

  it("enforces the per-namespace memory quota end-to-end (403 quota_exceeded) — FR/#122 HTTP wiring", async () => {
    // Abuse guards ON with a tiny cap so the boundary is cheap to hit.
    const env = devEnv(captureVectorize().vectorize, { ABUSE_GUARDS_ENABLED: "true", MAX_MEMORIES_PER_NAMESPACE: "2" });
    expect((await post("/v1/memory", { namespace: "agent-a", text: "one" }, env)).status).toBe(201);
    expect((await post("/v1/memory", { namespace: "agent-a", text: "two" }, env)).status).toBe(201);
    const over = await post("/v1/memory", { namespace: "agent-a", text: "three" }, env);
    expect(over.status).toBe(403);
    expect(await over.json()).toMatchObject({ error: { code: "quota_exceeded" } });
  });

  it("does NOT count when the quota flag is off (default): the same third write succeeds", async () => {
    const env = devEnv(captureVectorize().vectorize, { MAX_MEMORIES_PER_NAMESPACE: "2" }); // flag absent ⇒ no guard
    for (const t of ["one", "two", "three"]) {
      expect((await post("/v1/memory", { namespace: "agent-a", text: t }, env)).status).toBe(201);
    }
  });
});

describe("REST GET /v1/memory (get_page) + POST /v1/decisions (log_decision)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("dev");
    await seedNamespace("nd", "dev", "agent-a");
  });

  it("400s without ?namespace, then lists a namespace's own memories (not semantic search), clamped to `limit`", async () => {
    const env = devEnv();
    expect((await get("/v1/memory?limit=10", env)).status).toBe(400);

    const first = await post("/v1/memory", { namespace: "agent-a", text: "first" }, env);
    const second = await post("/v1/memory", { namespace: "agent-a", text: "second" }, env);
    const { id: firstId }: { id: string } = await first.json();
    const { id: secondId }: { id: string } = await second.json();

    const page = await get("/v1/memory?namespace=agent-a", env);
    expect(page.status).toBe(200);
    const body: { namespace: string; memories: { id: string }[] } = await page.json();
    expect(body.namespace).toBe("agent-a");
    // Real wall-clock `now` on this path — exact newest-first tie-breaking is asserted
    // deterministically at the service/MCP layer (test/mcp/tools.test.ts); here just
    // confirm both rows round-trip and `limit` clamps the page.
    expect(body.memories.map((m) => m.id).sort()).toEqual([firstId, secondId].sort());

    const capped: { memories: { id: string }[] } = await (await get("/v1/memory?namespace=agent-a&limit=1", env)).json();
    expect(capped.memories).toHaveLength(1);
  });

  it("log_decision composes '# title\\n\\nbody' + refs and is retrievable via get_page", async () => {
    const env = devEnv();
    const logged = await post("/v1/decisions", { namespace: "agent-a", title: "Adopt Postgres", body: "JSONB support.", refs: ["PR#42"] }, env);
    expect(logged.status).toBe(201);
    const { id }: { id: string } = await logged.json();

    const page = await get("/v1/memory?namespace=agent-a", env);
    const { memories }: { memories: { id: string; text: string | null }[] } = await page.json();
    expect(memories.find((m) => m.id === id)?.text).toBe("# Adopt Postgres\n\nJSONB support.\n\nRefs: PR#42");
  });

  it("log_decision 400s on a missing title/body, same tool-core bounds as add_memory", async () => {
    const env = devEnv();
    expect((await post("/v1/decisions", { namespace: "agent-a", body: "no title" }, env)).status).toBe(400);
  });
});
