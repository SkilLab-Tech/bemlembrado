import { beforeEach, describe, expect, it } from "vitest";
import { BadRequest, NotFound } from "../../src/http/errors";
import { Db } from "../../src/db/client";
import { requireNamespace, resolveNamespace } from "../../src/auth/namespace";
import { testEnv } from "../helpers/env";

function db() {
  return new Db(testEnv.DB);
}

async function seed(tenantId: string, nsId: string, label: string) {
  await db().insertTenant({ id: tenantId, name: tenantId, plan: "open", api_key_hash: `h-${tenantId}`, created_at: 1 });
  await db().insertNamespace({ id: nsId, tenant_id: tenantId, label, created_at: 1 });
}

describe("requireNamespace", () => {
  it("returns the label when present", () => {
    expect(requireNamespace("agent-a")).toBe("agent-a");
  });
  it("throws BadRequest on empty", () => {
    expect(() => requireNamespace("")).toThrow(BadRequest);
  });
  it("throws BadRequest on undefined", () => {
    expect(() => requireNamespace(undefined)).toThrow(BadRequest);
  });
});

describe("resolveNamespace", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM tenant");
  });

  it("resolves a tenant-owned namespace to its id", async () => {
    await seed("t1", "n1", "agent-a");
    expect((await resolveNamespace(db(), "t1", "agent-a", false)).id).toBe("n1");
  });

  it("returns 404 (NotFound) for another tenant's namespace", async () => {
    await seed("t2", "n2", "agent-a");
    await expect(resolveNamespace(db(), "t1", "agent-a", false)).rejects.toBeInstanceOf(NotFound);
  });

  it("returns 404 (NotFound) for an unknown label", async () => {
    await seed("t1", "n1", "agent-a");
    await expect(resolveNamespace(db(), "t1", "nope", false)).rejects.toBeInstanceOf(NotFound);
  });

  it("no existence oracle: cross-tenant and unknown both raise the same NotFound", async () => {
    await seed("t2", "n2", "secret-ns");
    const crossTenant = await resolveNamespace(db(), "t1", "secret-ns", false).catch((e: unknown) => e);
    const unknown = await resolveNamespace(db(), "t1", "does-not-exist", false).catch((e: unknown) => e);
    expect(crossTenant).toBeInstanceOf(NotFound);
    expect(unknown).toBeInstanceOf(NotFound);
  });

  it("is tenant-scoped: same label resolves to each tenant's own id", async () => {
    await seed("t1", "n1", "shared");
    await db().insertTenant({ id: "t2", name: "t2", plan: "open", api_key_hash: "h-t2", created_at: 1 });
    await db().insertNamespace({ id: "n2", tenant_id: "t2", label: "shared", created_at: 1 });
    expect((await resolveNamespace(db(), "t1", "shared", false)).id).toBe("n1");
    expect((await resolveNamespace(db(), "t2", "shared", false)).id).toBe("n2");
  });
});
