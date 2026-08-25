import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { createApp } from "../../src/http/app";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { appEnv } from "../helpers/env";

function devEnv(overrides: Partial<Env> = {}): Env {
  return { ...appEnv, DEV_AUTHLESS: "true", ENVIRONMENT: "dev", ...overrides };
}

async function post(path: string, body: unknown, env: Env): Promise<Response> {
  return createApp().request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
}

describe("REST /v1/namespaces management", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("dev"); // dev-authless synthetic tenant, plan=open
  });

  it("401 without an API key", async () => {
    expect((await createApp().request("/v1/namespaces", {}, appEnv)).status).toBe(401);
  });

  it("create (201) → list shows it → re-create is idempotent (200, created:false)", async () => {
    const created = await post("/v1/namespaces", { namespace: "agent-a" }, devEnv());
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ label: "agent-a", created: true });

    const list = await createApp().request("/v1/namespaces", {}, devEnv());
    expect(list.status).toBe(200);
    const body: { namespaces: { label: string }[] } = await list.json();
    expect(body.namespaces.map((n) => n.label)).toContain("agent-a");

    const again = await post("/v1/namespaces", { namespace: "agent-a" }, devEnv());
    expect(again.status).toBe(200); // idempotent, no duplicate
    expect(await again.json()).toMatchObject({ created: false });
    expect((await db().listNamespacesByTenant("dev")).filter((n) => n.label === "agent-a")).toHaveLength(1);
  });

  it("400 on a missing/oversized/blank namespace label", async () => {
    expect((await post("/v1/namespaces", {}, devEnv())).status).toBe(400);
    expect((await post("/v1/namespaces", { namespace: "x".repeat(201) }, devEnv())).status).toBe(400);
    expect((await post("/v1/namespaces", { namespace: "   " }, devEnv())).status).toBe(400); // whitespace-only rejected
  });

  it("list is tenant-scoped (no cross-tenant leak)", async () => {
    await seedTenant("other");
    await seedNamespace("o1", "other", "secret-ns");
    const res = await createApp().request("/v1/namespaces", {}, devEnv());
    const body: { namespaces: { label: string }[] } = await res.json();
    expect(body.namespaces.map((n) => n.label)).not.toContain("secret-ns");
  });

  it("enforces the per-plan namespace quota end-to-end when PLAN_GATING_ENABLED (open plan cap=3)", async () => {
    const env = devEnv({ PLAN_GATING_ENABLED: "true" }); // dev tenant plan=open → cap 3 namespaces
    for (const label of ["a", "b", "c"]) {
      expect((await post("/v1/namespaces", { namespace: label }, env)).status).toBe(201);
    }
    const over = await post("/v1/namespaces", { namespace: "d" }, env);
    expect(over.status).toBe(403);
    expect(await over.json()).toMatchObject({ error: { code: "quota_exceeded" } });
  });

  it("no quota when both flags off (default): a 4th namespace still succeeds", async () => {
    const env = devEnv();
    for (const label of ["a", "b", "c", "d"]) {
      expect((await post("/v1/namespaces", { namespace: label }, env)).status).toBe(201);
    }
  });
});
