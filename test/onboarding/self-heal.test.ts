import { beforeEach, describe, expect, it } from "vitest";
import { ensureNamespace, SelfHealError, selectInferenceProvider } from "../../src/onboarding/self-heal";
import type { AbuseConfig } from "../../src/abuse/guards";
import { QuotaExceeded } from "../../src/http/errors";
import type { Env } from "../../src/env";
import { db, resetDb, seedTenant } from "../helpers/fixtures";

describe("ensureNamespace (auto-create on first call)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedTenant("t2");
  });

  it("creates the namespace on first call, returns it", async () => {
    const ns = await ensureNamespace(db(), "t1", "default", 100);
    expect(ns.tenant_id).toBe("t1");
    expect(ns.label).toBe("default");
    expect(await db().getNamespace("t1", "default")).not.toBeNull();
  });

  it("is idempotent: a second call returns the same row, no duplicate", async () => {
    const a = await ensureNamespace(db(), "t1", "default", 100);
    const b = await ensureNamespace(db(), "t1", "default", 200);
    expect(b.id).toBe(a.id);
    expect(b.created_at).toBe(100); // not overwritten by the second call
  });

  it("is tenant-scoped: same label across tenants -> distinct namespaces", async () => {
    const n1 = await ensureNamespace(db(), "t1", "default", 1);
    const n2 = await ensureNamespace(db(), "t2", "default", 1);
    expect(n1.id).not.toBe(n2.id);
  });

  it("requires tenant + label", async () => {
    await expect(ensureNamespace(db(), "", "default", 1)).rejects.toBeInstanceOf(SelfHealError);
  });

  it("enforces the per-tenant namespace quota on the create branch", async () => {
    const quota: AbuseConfig = { maxMemoriesPerNamespace: 999, maxNamespacesPerTenant: 2, maxTurnsPerCycle: 100 };
    await ensureNamespace(db(), "t1", "a", 1, { quota });
    await ensureNamespace(db(), "t1", "b", 1, { quota });
    // 3rd distinct namespace exceeds the cap → refused.
    await expect(ensureNamespace(db(), "t1", "c", 1, { quota })).rejects.toBeInstanceOf(QuotaExceeded);
    // Resolving an EXISTING namespace never counts against the cap (no throw, even at cap).
    await expect(ensureNamespace(db(), "t1", "a", 1, { quota })).resolves.toMatchObject({ label: "a" });
    // The cap is per-tenant: t2 is unaffected.
    await expect(ensureNamespace(db(), "t2", "a", 1, { quota })).resolves.toMatchObject({ tenant_id: "t2" });
  });
});

describe("selectInferenceProvider (graceful fallback)", () => {
  it("falls back to Workers AI when no premium key is set", () => {
    expect(selectInferenceProvider({} as Env)).toBe("workers-ai");
    expect(selectInferenceProvider({ ANTHROPIC_API_KEY: "" } as Env)).toBe("workers-ai");
  });
  it("uses Anthropic when a key is present", () => {
    expect(selectInferenceProvider({ ANTHROPIC_API_KEY: "sk-ant-xxx" } as Env)).toBe("anthropic");
  });
});
