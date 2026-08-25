import { beforeEach, describe, expect, it } from "vitest";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { testEnv } from "../helpers/env";

async function seedSession(id: string, namespaceId: string) {
  await testEnv.DB.prepare(
    "INSERT INTO session (id, namespace_id, status, started_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, namespaceId, "active", 1)
    .run();
}

describe("mig 0008 — MESSAGE.entities_json", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "a");
    await seedSession("s1", "n1");
  });

  it("persists entities_json on a message", async () => {
    const entities = JSON.stringify(["PIX", "Brazil"]);
    await db().insertMessage({ id: "m1", session_id: "s1", role: "user", content: "hi", token_count: 1, created_at: 1, entities_json: entities });
    const rows = await db().listMessagesBySession("s1");
    expect(rows[0]?.entities_json).toBe(entities);
  });

  it("defaults entities_json to null when omitted", async () => {
    await db().insertMessage({ id: "m1", session_id: "s1", role: "assistant", content: "ok", token_count: 1, created_at: 1 });
    const rows = await db().listMessagesBySession("s1");
    expect(rows[0]?.entities_json).toBeNull();
  });

  it("round-trips a JSON array via entities_json", async () => {
    await db().insertMessage({ id: "m1", session_id: "s1", role: "tool", content: "ctx", token_count: 1, created_at: 1, entities_json: JSON.stringify([{ name: "Alex", kind: "person" }]) });
    const rows = await db().listMessagesBySession("s1");
    const parsed: unknown = JSON.parse(rows[0]?.entities_json ?? "[]");
    expect(parsed).toStrictEqual([{ name: "Alex", kind: "person" }]);
  });
});
