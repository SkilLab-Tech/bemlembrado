import { beforeEach, describe, expect, it } from "vitest";
import { curateTurn } from "../../src/core/curate-turn";
import type { ChatLike } from "../../src/vault/curator";
import { VaultStore } from "../../src/vault/store";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { testEnv } from "../helpers/env";

const DECISION = '{"action":"create","slug":"sky-fact","type":"fact","body":"The sky is blue."}';
const goodChat: ChatLike = { complete: () => Promise.resolve(DECISION) };
const badChat: ChatLike = { complete: () => Promise.reject(new Error("llm down")) };

async function clearVault(): Promise<void> {
  const res = await testEnv.VAULT.list();
  if (res.objects.length > 0) await testEnv.VAULT.delete(res.objects.map((o) => o.key));
}

describe("curateTurn (post-turn curation)", () => {
  let vault: VaultStore;
  beforeEach(async () => {
    await resetDb();
    await clearVault();
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "agent-a");
    vault = new VaultStore(testEnv.VAULT);
  });

  it("folds the exchange into the vault as an atomic note (R2 + D1 graph)", async () => {
    await curateTurn({ db: db(), vault, chat: goodChat }, { tenantId: "t1", namespaceId: "n1", episodeId: "e1", text: "user: why blue?\nassistant: Rayleigh.", now: 10 });

    expect(await db().getNoteBySlug("n1", "sky-fact")).not.toBeNull(); // D1 mirror
    expect((await vault.getNote("t1", "n1", "sky-fact"))?.body).toBe("The sky is blue."); // R2 source of truth
  });

  it("is best-effort: an LLM failure never throws and writes nothing", async () => {
    await expect(
      curateTurn({ db: db(), vault, chat: badChat }, { tenantId: "t1", namespaceId: "n1", episodeId: "e1", text: "x", now: 10 }),
    ).resolves.toBeUndefined();
    expect(await db().getNoteBySlug("n1", "sky-fact")).toBeNull();
  });

  it("rejects schema-invalid curator output without persisting (KFM-004)", async () => {
    const junkChat: ChatLike = { complete: () => Promise.resolve("no json here, just prose") };
    await curateTurn({ db: db(), vault, chat: junkChat }, { tenantId: "t1", namespaceId: "n1", episodeId: "e1", text: "x", now: 10 });
    expect((await db().listNotesByNamespace("n1")).length).toBe(0);
  });
});
