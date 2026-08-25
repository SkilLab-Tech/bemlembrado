import { beforeEach, describe, expect, it } from "vitest";
import { addMemory, type ConsolidationDeps } from "../../src/memory/add";
import { type AiChatBinding, InferenceClient } from "../../src/inference/client";
import { KvStore } from "../../src/db/kv";
import { captureVectorize, fakeAi } from "../helpers/fakes";
import { testEnv } from "../helpers/env";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";

/** Workers AI chat stub returning a fixed merged note (ignores the prompt). */
function chatClient(response: string): InferenceClient {
  const ai: AiChatBinding = { run: () => Promise.resolve({ response }) };
  return new InferenceClient({ ai });
}

function consolidation(response: string): ConsolidationDeps {
  return { enabled: true, client: chatClient(response) };
}

const EXISTING = "Ana is on the pro-plan subscription tier";
const CONTESTED = "Ana subscription pro-plan tier upgraded";
const MERGED = "Ana is on the pro-plan subscription tier, recently upgraded";

describe("addMemory — write-time consolidation", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "agent-a");
  });

  it("OFF by default: a similar write inserts a second row (unchanged path)", async () => {
    const { vectorize } = captureVectorize();
    const base = { db: db(), ai: fakeAi(), vectorize };
    await addMemory(base, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: EXISTING, now: 1 });
    const res = await addMemory(base, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: CONTESTED, now: 2 });
    expect(res.consolidated).toBeUndefined();
    const rows = await db().listMemoriesByNamespace("n1");
    expect(rows).toHaveLength(2);
  });

  it("ON + contested: merges into the existing note in place (no new row)", async () => {
    const { vectorize, store } = captureVectorize();
    const first = await addMemory({ db: db(), ai: fakeAi(), vectorize }, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: EXISTING, now: 1 });
    const res = await addMemory(
      { db: db(), ai: fakeAi(), vectorize, consolidation: consolidation(MERGED) },
      { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: CONTESTED, now: 2 },
    );
    expect(res.consolidated).toBe(true);
    expect(res.id).toBe(first.id); // merged INTO the existing note

    const rows = await db().listMemoriesByNamespace("n1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe(MERGED);
    expect(rows[0]?.updated_at).toBe(2); // provenance stamped
    // the target's vector was re-upserted under the SAME id (delete-cascade stays intact)
    expect(store.at(-1)?.id).toBe(first.id);
  });

  it("ON + contested: busts the namespace summary cache in KV (FR-14 invalidation contract)", async () => {
    const { vectorize } = captureVectorize();
    const kv = new KvStore(testEnv.KV);
    await kv.put("t1", ["ns", "n1", "summary"], "stale-cached-summary"); // pre-seed the hot-path cache
    await addMemory({ db: db(), ai: fakeAi(), vectorize }, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: EXISTING, now: 1 });
    await addMemory(
      { db: db(), ai: fakeAi(), vectorize, consolidation: { ...consolidation(MERGED), kv } },
      { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: CONTESTED, now: 2 },
    );
    // Consolidation mutated the note in place → the cached summary is now stale and MUST be evicted.
    expect(await kv.get("t1", ["ns", "n1", "summary"])).toBeNull();
  });

  it("ON + not contested: an unrelated write inserts a new row", async () => {
    const { vectorize } = captureVectorize();
    await addMemory({ db: db(), ai: fakeAi(), vectorize }, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: EXISTING, now: 1 });
    const res = await addMemory(
      { db: db(), ai: fakeAi(), vectorize, consolidation: consolidation(MERGED) },
      { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: "Bruno hiking trip next Friday morning", now: 2 },
    );
    expect(res.consolidated).toBeUndefined();
    expect(await db().listMemoriesByNamespace("n1")).toHaveLength(2);
  });

  it("ON but episodic: append-only, never consolidated", async () => {
    const { vectorize } = captureVectorize();
    await addMemory({ db: db(), ai: fakeAi(), vectorize }, { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: EXISTING, kind: "episodic", now: 1 });
    const res = await addMemory(
      { db: db(), ai: fakeAi(), vectorize, consolidation: consolidation(MERGED) },
      { allowConfidential: false, tenantId: "t1", namespace: "agent-a", text: CONTESTED, kind: "episodic", now: 2 },
    );
    expect(res.consolidated).toBeUndefined();
    expect(await db().listMemoriesByNamespace("n1")).toHaveLength(2);
  });
});
