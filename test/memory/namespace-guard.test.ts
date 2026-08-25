import { beforeEach, describe, expect, it } from "vitest";
import { BadRequest, NotFound } from "../../src/http/errors";
import { resolveMemoryNamespace } from "../../src/memory/namespace-guard";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";

describe("resolveMemoryNamespace", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("n1", "t1", "agent-a");
    await seedNamespace("n2", "t2", "agent-a");
  });

  it("resolves a tenant-owned namespace to its id", async () => {
    expect((await resolveMemoryNamespace(db(), "t1", "agent-a", false)).id).toBe("n1");
  });

  it("rejects a missing namespace with BadRequest", async () => {
    await expect(resolveMemoryNamespace(db(), "t1", undefined, false)).rejects.toBeInstanceOf(BadRequest);
  });

  it("rejects a cross-tenant namespace with NotFound", async () => {
    // 'agent-a' exists for t2 — but t1 must never reach it.
    expect((await resolveMemoryNamespace(db(), "t1", "agent-a", false)).id).toBe("n1");
    await expect(resolveMemoryNamespace(db(), "t1", "agent-b", false)).rejects.toBeInstanceOf(NotFound);
  });

  it("rejects an unknown namespace with NotFound", async () => {
    await expect(resolveMemoryNamespace(db(), "t2", "nope", false)).rejects.toBeInstanceOf(NotFound);
  });
});
