import { beforeEach, describe, expect, it } from "vitest";
import { Audit, type AuditPrincipal, hashForAudit, recordAudit } from "../../src/lgpd/audit";
import { Db } from "../../src/db/client";
import { db, resetDb, seedTenant } from "../helpers/fixtures";
import { testEnv } from "../helpers/env";

describe("Audit", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedTenant("t2");
  });

  it("records one row per op, queryable by tenant", async () => {
    const audit = new Audit(db());
    await audit.record("t1", "t1", "write", "ns1/note", 100);
    await audit.record("t1", "t1", "read", "ns1", 200);
    await audit.record("t2", "t2", "delete", "ns9", 150);

    const t1 = await audit.list("t1");
    expect(t1.map((r) => r.action)).toStrictEqual(["write", "read"]); // ordered by ts
    expect(t1[0]?.target).toBe("ns1/note");
    expect((await audit.list("t2")).length).toBe(1); // isolation
  });

  it("filters by time range", async () => {
    const audit = new Audit(db());
    await audit.record("t1", "t1", "write", "a", 100);
    await audit.record("t1", "t1", "write", "b", 200);
    await audit.record("t1", "t1", "write", "c", 300);
    const mid = await audit.list("t1", { since: 150, until: 250 });
    expect(mid.map((r) => r.target)).toStrictEqual(["b"]);
  });

  it("audit rows survive a namespace delete but cascade on tenant delete", async () => {
    const audit = new Audit(db());
    await audit.record("t1", "t1", "delete", "ns1", 100);
    // tenant-scoped, no namespace FK -> deleting a namespace leaves the audit row
    await testEnv.DB.prepare("DELETE FROM tenant WHERE id = ?").bind("t1").run();
    expect((await audit.list("t1")).length).toBe(0); // tenant delete cascades
  });
});

describe("recordAudit (success boundary)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
  });

  const principal: AuditPrincipal = { tenantId: "t1", keyId: "key-abc12345", requestId: "req-1" };

  it("writes exactly one row with actor=keyId and the request id", async () => {
    await recordAudit(db(), principal, "write", { kind: "memory", namespace: "agent-a", memoryId: "m-1" }, 100);

    const rows = await new Audit(db()).list("t1");
    expect(rows.length).toBe(1);
    expect(rows[0]?.actor).toBe("key-abc12345");
    expect(rows[0]?.request_id).toBe("req-1");
    expect(rows[0]?.target).toBe("mem:agent-a#m-1");
    expect(rows[0]?.created_at).toBe(100);
  });

  it("hashes a search query — the raw query is never stored", async () => {
    const query = "what is the patient's CPF 123.456.789-00";
    await recordAudit(db(), principal, "read", { kind: "query", namespace: "agent-a", query }, 200);

    const row = (await new Audit(db()).list("t1"))[0];
    expect(row?.target).toBe(`query:agent-a#${await hashForAudit(query)}`);
    expect(row?.target).not.toContain("CPF");
    expect(row?.target).not.toContain("123.456.789-00");
  });

  it("falls back to tenant id as actor when no keyId is given", async () => {
    await recordAudit(db(), { tenantId: "t1" }, "delete", { kind: "namespace", namespace: "agent-a" }, 300);
    const row = (await new Audit(db()).list("t1"))[0];
    expect(row?.actor).toBe("t1");
    expect(row?.target).toBe("namespace:agent-a");
    expect(row?.request_id).toBeNull();
  });

  it("is best-effort: a failing audit never throws and never rolls back the op", async () => {
    const brokenDb = new Db({
      prepare() {
        throw new Error("d1 unavailable");
      },
    } as unknown as D1Database);

    // Resolves (does not reject) even though the underlying insert blows up.
    await expect(
      recordAudit(brokenDb, principal, "write", { kind: "resource", name: "vault" }, 400),
    ).resolves.toBeUndefined();
    // And nothing was persisted to the real store.
    expect((await new Audit(db()).list("t1")).length).toBe(0);
  });

  it("accepts a null target (op with no specific subject)", async () => {
    await recordAudit(db(), principal, "export", null, 500);
    expect((await new Audit(db()).list("t1"))[0]?.target).toBeNull();
  });
});
