import { beforeEach, describe, expect, it } from "vitest";
import { Db } from "../../src/db/client";
import { testEnv } from "../helpers/env";

const T0 = 1_700_000_000_000;

function db() {
  return new Db(testEnv.DB);
}

async function seedTenant(id: string, hash: string | null = `hash-${id}`) {
  await db().insertTenant({ id, name: `name-${id}`, plan: "open", api_key_hash: hash, created_at: T0 });
}

async function seedNamespace(id: string, tenantId: string, label: string) {
  await db().insertNamespace({ id, tenant_id: tenantId, label, created_at: T0 });
}

async function seedSession(id: string, namespaceId: string) {
  await testEnv.DB.prepare(
    "INSERT INTO session (id, namespace_id, status, started_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, namespaceId, "active", T0)
    .run();
}

describe("Db client", () => {
  // isolatedStorage rolls back per test, but clear defensively for clarity.
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM tenant");
  });

  it("inserts and fetches a tenant by api_key_hash", async () => {
    await seedTenant("t1", "hash-abc");
    const got = await db().getTenantByApiKeyHash("hash-abc");
    expect(got?.id).toBe("t1");
    expect(got?.plan).toBe("open");
  });

  it("returns null for an unknown api_key_hash", async () => {
    expect(await db().getTenantByApiKeyHash("nope")).toBeNull();
  });

  it("inserts and fetches a namespace scoped by tenant + label", async () => {
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "agent-a");
    const got = await db().getNamespace("t1", "agent-a");
    expect(got?.id).toBe("n1");
  });

  it("never returns another tenant's namespace for the same label", async () => {
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("n2", "t2", "shared-label");
    expect(await db().getNamespace("t1", "shared-label")).toBeNull();
  });

  it("getNamespaceById is tenant-scoped", async () => {
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("n2", "t2", "agent-a");
    expect(await db().getNamespaceById("t1", "n2")).toBeNull();
    expect((await db().getNamespaceById("t2", "n2"))?.id).toBe("n2");
  });

  it("inserts memories and lists only the namespace's rows", async () => {
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "a");
    await seedNamespace("n2", "t1", "b");
    await db().insertMemory({ id: "m1", namespace_id: "n1", kind: "semantic", text: "x", vector_id: "v1", metadata_json: null, created_at: T0, ttl: null });
    await db().insertMemory({ id: "m2", namespace_id: "n2", kind: "semantic", text: "y", vector_id: "v2", metadata_json: null, created_at: T0 + 1, ttl: null });
    const rows = await db().listMemoriesByNamespace("n1");
    expect(rows.map((r) => r.id)).toStrictEqual(["m1"]);
  });

  it("deleteMemoriesByNamespace removes only that namespace's rows", async () => {
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "a");
    await seedNamespace("n2", "t1", "b");
    await db().insertMemory({ id: "m1", namespace_id: "n1", kind: "episodic", text: null, vector_id: null, metadata_json: null, created_at: T0, ttl: null });
    await db().insertMemory({ id: "m2", namespace_id: "n2", kind: "episodic", text: null, vector_id: null, metadata_json: null, created_at: T0, ttl: null });
    await db().deleteMemoriesByNamespace("n1");
    expect(await db().listMemoriesByNamespace("n1")).toHaveLength(0);
    expect(await db().listMemoriesByNamespace("n2")).toHaveLength(1);
  });

  it("inserts and lists messages by session", async () => {
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "a");
    await seedSession("s1", "n1");
    await db().insertMessage({ id: "msg1", session_id: "s1", role: "user", content: "hi", token_count: 3, created_at: T0 });
    await db().insertMessage({ id: "msg2", session_id: "s1", role: "tool", content: "ctx", token_count: 5, created_at: T0 + 1 });
    const rows = await db().listMessagesBySession("s1");
    expect(rows.map((r) => r.role)).toStrictEqual(["user", "tool"]);
  });

  it("inserts and lists usage events by tenant", async () => {
    await seedTenant("t1");
    await db().insertUsageEvent({ id: "u1", tenant_id: "t1", session_id: "s1", turn: 1, tokens_fresh: 100, tokens_cache_read: 900, tokens_cache_write: 50, provider: "anthropic", model: "opus", cost_usd: 0.01, created_at: T0 });
    const rows = await db().listUsageEventsByTenant("t1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokens_cache_read).toBe(900);
  });

  it("counts usage events by tenant, filtered by since + provider (TC-1 turn cap basis)", async () => {
    await seedTenant("t1");
    const ev = (id: string, provider: string, created_at: number) => ({
      id, tenant_id: "t1", session_id: "s1", turn: 1, tokens_fresh: 1, tokens_cache_read: 0, tokens_cache_write: 0, provider, model: "m", cost_usd: 0, created_at,
    });
    await db().insertUsageEvent(ev("a", "workers-ai", T0 - 1)); // before the cycle → excluded
    await db().insertUsageEvent(ev("b", "workers-ai", T0));      // in cycle, default → counted
    await db().insertUsageEvent(ev("c", "workers-ai", T0 + 1));  // in cycle, default → counted
    await db().insertUsageEvent(ev("d", "anthropic", T0 + 2));   // in cycle, BYOK → NOT counted
    expect(await db().countUsageEventsByTenant("t1", { since: T0, provider: "workers-ai" })).toBe(2);
    expect(await db().countUsageEventsByTenant("t1", { since: T0 })).toBe(3); // all in-cycle providers
    expect(await db().countUsageEventsByTenant("t1")).toBe(4); // no filters → all
    expect(await db().countUsageEventsByTenant("other", { provider: "workers-ai" })).toBe(0); // tenant-scoped
  });

  it("binds parameters (no SQL injection via a label)", async () => {
    await seedTenant("t1");
    const evil = "x'; DROP TABLE tenant; --";
    await seedNamespace("n1", "t1", evil);
    expect((await db().getNamespace("t1", evil))?.label).toBe(evil);
    // tenant table survives — the payload was bound data, not executed SQL.
    expect(await db().getTenantByApiKeyHash("hash-t1")).not.toBeNull();
  });
});
