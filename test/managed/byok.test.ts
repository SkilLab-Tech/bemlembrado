import { beforeEach, describe, expect, it } from "vitest";
import { Db } from "../../src/db/client";
import { resolveTenantKeys, storeProviderKey } from "../../src/managed/byok";
import { testEnv } from "../helpers/env";

const T0 = 1_700_000_000_000;
const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
function db() {
  return new Db(testEnv.DB);
}

describe("managed BYOK store/resolve", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DELETE FROM tenant");
    await db().insertTenant({ id: "t1", name: "t1", plan: "managed", api_key_hash: "h", created_at: T0 });
    await db().insertTenant({ id: "t2", name: "t2", plan: "managed", api_key_hash: "h2", created_at: T0 });
  });

  it("stores encrypted (no plaintext in D1) and resolves back to the override shape", async () => {
    await storeProviderKey(db(), KEK, "t1", "anthropic", "sk-ant-live-xyz", T0);
    const row = await db().getProviderKey("t1", "anthropic");
    expect(row?.ciphertext).not.toContain("sk-ant"); // plaintext never stored
    expect(await resolveTenantKeys(db(), KEK, "t1")).toStrictEqual({ anthropicKey: "sk-ant-live-xyz" });
  });

  it("rotates in place (upsert) and resolves the latest value", async () => {
    await storeProviderKey(db(), KEK, "t1", "maritaca", "old-key", T0);
    await storeProviderKey(db(), KEK, "t1", "maritaca", "new-key", T0 + 1);
    expect((await db().listProviderKeyMeta("t1")).filter((k) => k.provider === "maritaca")).toHaveLength(1);
    expect((await resolveTenantKeys(db(), KEK, "t1")).maritacaKey).toBe("new-key");
  });

  it("is tenant-scoped: t2 never resolves t1's key; delete is scoped too", async () => {
    await storeProviderKey(db(), KEK, "t1", "anthropic", "t1-key", T0);
    expect(await resolveTenantKeys(db(), KEK, "t2")).toStrictEqual({});
    expect(await db().deleteProviderKey("t2", "anthropic")).toBe(false); // wrong tenant → no-op
    expect(await db().getProviderKey("t1", "anthropic")).not.toBeNull(); // unchanged
    expect(await db().deleteProviderKey("t1", "anthropic")).toBe(true);
    expect(await resolveTenantKeys(db(), KEK, "t1")).toStrictEqual({});
  });

  it("tenant delete CASCADEs BYOK keys (LGPD right-to-erasure)", async () => {
    await storeProviderKey(db(), KEK, "t1", "anthropic", "k", T0);
    await testEnv.DB.prepare("DELETE FROM tenant WHERE id = ?").bind("t1").run();
    expect(await db().getProviderKey("t1", "anthropic")).toBeNull();
  });
});
