import { beforeEach, describe, expect, it } from "vitest";
import { requireNamespace, resolveNamespace } from "../../src/auth/namespace";
import { BadRequest, NotFound } from "../../src/http/errors";
import { KvStore } from "../../src/db/kv";
import { createApp } from "../../src/http/app";
import { appEnv, testEnv } from "../helpers/env";
import { db, resetDb, seedMemory, seedNamespace, seedTenant } from "../helpers/fixtures";

/**
 * F1 close-out: a reusable Miniflare integration harness proving the data layer
 * end to end + the P0 invariant-#2 surfaces. Reused by F2/F3.
 */
describe("data-layer integration", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("cross-tenant isolation across D1: T2 rows never surface for T1", async () => {
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("n1", "t1", "a");
    await seedNamespace("n2", "t2", "a");
    await seedMemory("m1", "n1", "t1 data");
    await seedMemory("m2", "n2", "t2 data");
    const t1Rows = await db().listMemoriesByNamespace("n1");
    expect(t1Rows.map((r) => r.id)).toStrictEqual(["m1"]);
  });

  it("resolveNamespace is tenant-scoped, cross-tenant -> NotFound", async () => {
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("n2", "t2", "only-t2");
    await expect(resolveNamespace(db(), "t1", "only-t2", false)).rejects.toBeInstanceOf(NotFound);
  });

  it("requireNamespace rejects a missing namespace", () => {
    expect(() => requireNamespace(undefined)).toThrow(BadRequest);
  });

  it("KV keys are tenant-prefixed so hot-path entries never collide", async () => {
    const kv = new KvStore(testEnv.KV);
    await kv.put("t1", ["sess"], "t1-route");
    await kv.put("t2", ["sess"], "t2-route");
    expect(await kv.get("t1", ["sess"])).toBe("t1-route");
    expect(await kv.get("t2", ["sess"])).toBe("t2-route");
  });

  it("app: /health is 200 and unauthenticated", async () => {
    const res = await createApp().request("/health", {}, appEnv);
    expect(res.status).toBe(200);
  });

  it("app: a guarded /v1 route is 401 without a key (auth on by default in test env)", async () => {
    const app = createApp();
    app.get("/v1/guarded", (c) => c.text("secret"));
    const res = await app.request("/v1/guarded", {}, appEnv);
    expect(res.status).toBe(401);
  });
});
