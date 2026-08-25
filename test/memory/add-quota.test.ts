import { beforeEach, describe, expect, it } from "vitest";
import { addMemory, type AbuseGuard } from "../../src/memory/add";
import { QuotaExceeded } from "../../src/http/errors";
import { captureVectorize, fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";

const guard = (max: number): AbuseGuard => ({
  enabled: true,
  config: { maxMemoriesPerNamespace: max, maxNamespacesPerTenant: 1000, maxTurnsPerCycle: 100_000 },
});

describe("addMemory — storage-abuse quota", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "agent-a");
  });

  it("OFF by default: writes past the (would-be) cap succeed", async () => {
    const { vectorize } = captureVectorize();
    const base = { db: db(), ai: fakeAi(), vectorize };
    for (let i = 0; i < 3; i += 1) {
      await addMemory(base, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: `m${String(i)}`, now: i });
    }
    expect(await db().countMemoriesByNamespace("n1")).toBe(3);
  });

  it("ON: refuses a NEW write once the namespace is at the cap", async () => {
    const { vectorize } = captureVectorize();
    const base = { db: db(), ai: fakeAi(), vectorize, abuse: guard(2) };
    await addMemory(base, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "m0", now: 0 });
    await addMemory(base, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "m1", now: 1 });
    await expect(
      addMemory(base, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "m2", now: 2 }),
    ).rejects.toBeInstanceOf(QuotaExceeded);
    expect(await db().countMemoriesByNamespace("n1")).toBe(2); // the blocked write left no row
  });

  it("ON: an idempotent dedupe hit is NOT blocked at the cap", async () => {
    const { vectorize } = captureVectorize();
    const base = { db: db(), ai: fakeAi(), vectorize, abuse: guard(1) };
    const first = await addMemory(base, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "only", dedupeKey: "k1", now: 0 });
    // at cap (1), but a repeat with the same dedupeKey returns the existing id, no new write
    const again = await addMemory(base, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "only", dedupeKey: "k1", now: 1 });
    expect(again.id).toBe(first.id);
    expect(await db().countMemoriesByNamespace("n1")).toBe(1);
  });
});
