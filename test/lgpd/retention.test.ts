import { beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "../../src/obs/log";
import type { DeleteVectorize } from "../../src/lgpd/delete";
import { sweepExpiredMemories } from "../../src/lgpd/retention";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";

const DAY = 86_400_000;
const NOW = 1_000_000_000_000;
const noopLogger: Logger = { log: () => undefined };

function fakeVectorize() {
  const deleted: string[] = [];
  const vectorize: DeleteVectorize = {
    deleteByIds(ids) {
      deleted.push(...ids);
      return Promise.resolve({ count: ids.length });
    },
  };
  return { vectorize, deleted };
}

async function seedMem(nsId: string, id: string, createdAt: number, vectorId: string | null): Promise<void> {
  await db().insertMemory({
    id,
    namespace_id: nsId,
    kind: "episodic",
    text: `t-${id}`,
    vector_id: vectorId,
    metadata_json: null,
    created_at: createdAt,
    ttl: null,
    dedupe_key: null,
  });
}

describe("retention sweep (F5 #110-111)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    // n1 + n2: 30-day retention. n3: no policy.
    await seedNamespace("n1", "t1", "agent-a");
    await seedNamespace("n2", "t1", "agent-b");
    await seedNamespace("n3", "t1", "agent-c");
    await db().setNamespaceRetention("t1", "n1", 30);
    await db().setNamespaceRetention("t1", "n2", 30);
    await seedMem("n1", "m-old", NOW - 40 * DAY, "v-old"); // expired
    await seedMem("n1", "m-new", NOW - 10 * DAY, "v-new"); // fresh
    await seedMem("n2", "m2-old", NOW - 40 * DAY, "v2-old"); // expired (other ns)
    await seedMem("n3", "m3-old", NOW - 40 * DAY, "v3-old"); // no retention -> immune
  });

  it("dry-run counts expired but deletes nothing", async () => {
    const { vectorize, deleted } = fakeVectorize();
    const report = await sweepExpiredMemories({ db: db(), vectorize, logger: noopLogger }, NOW, false);

    expect(report.dryRun).toBe(true);
    expect(report.namespacesScanned).toBe(2); // only n1 + n2 have a policy
    expect(report.memoriesExpired).toBe(2); // m-old + m2-old
    expect(report.memoriesPurged).toBe(0);
    expect(report.vectorsPurged).toBe(0);
    expect(deleted).toEqual([]); // Vectorize untouched

    // nothing removed from D1
    expect(await db().getMemoryById("n1", "m-old")).not.toBeNull();
    expect(await db().getMemoryById("n2", "m2-old")).not.toBeNull();
  });

  it("enabled: purges only expired rows (D1 + Vectorize), spares fresh + no-policy namespaces", async () => {
    const { vectorize, deleted } = fakeVectorize();
    const report = await sweepExpiredMemories({ db: db(), vectorize, logger: noopLogger }, NOW, true);

    expect(report.dryRun).toBe(false);
    expect(report.memoriesExpired).toBe(2);
    expect(report.memoriesPurged).toBe(2);
    expect(report.vectorsPurged).toBe(2);
    expect(deleted.sort()).toEqual(["v-old", "v2-old"]); // exactly the expired vectors

    // expired gone
    expect(await db().getMemoryById("n1", "m-old")).toBeNull();
    expect(await db().getMemoryById("n2", "m2-old")).toBeNull();
    // fresh + no-policy survive
    expect(await db().getMemoryById("n1", "m-new")).not.toBeNull();
    expect(await db().getMemoryById("n3", "m3-old")).not.toBeNull();
  });

  it("no-op safe when Vectorize is absent (still purges D1, reports skipped vectors as 0)", async () => {
    const report = await sweepExpiredMemories({ db: db(), logger: noopLogger }, NOW, true);
    expect(report.memoriesPurged).toBe(2);
    expect(report.vectorsPurged).toBe(0); // no binding -> vectors left, D1 rows still purged
    expect(await db().getMemoryById("n1", "m-old")).toBeNull();
  });
});
