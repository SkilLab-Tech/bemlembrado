import { beforeEach, describe, expect, it } from "vitest";
import {
  generateScopedToken,
  isScopedToken,
  issueScopedToken,
  resolveScopedToken,
  revokeScopedToken,
} from "../../src/auth/scoped-token";
import { db, resetDb, seedTenant } from "../helpers/fixtures";

const PEPPER = "test-pepper";

describe("generateScopedToken / isScopedToken", () => {
  it("mints a blt_-prefixed token distinguishable from the bl_ API key", () => {
    const t = generateScopedToken();
    expect(t.startsWith("blt_")).toBe(true);
    expect(isScopedToken(t)).toBe(true);
    expect(isScopedToken("bl_someapikey")).toBe(false);
  });
});

describe("scoped-token lifecycle", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedTenant("t2");
  });

  it("issues then resolves to the tenant + scopes", async () => {
    const issued = await issueScopedToken(db(), PEPPER, "t1", ["memory:read", "memory:write"], 1000);
    expect(issued.token.startsWith("blt_")).toBe(true);
    const resolved = await resolveScopedToken(db(), PEPPER, issued.token, 2000);
    expect(resolved).not.toBeNull();
    expect(resolved?.tenantId).toBe("t1");
    expect(resolved?.scopes).toStrictEqual(["memory:read", "memory:write"]);
  });

  it("returns null for an unknown token", async () => {
    expect(await resolveScopedToken(db(), PEPPER, generateScopedToken(), 1000)).toBeNull();
  });

  it("returns null once expired", async () => {
    const issued = await issueScopedToken(db(), PEPPER, "t1", ["memory:read"], 1000, { ttlSeconds: 60 });
    expect(await resolveScopedToken(db(), PEPPER, issued.token, 1000 + 30_000)).not.toBeNull(); // within ttl
    expect(await resolveScopedToken(db(), PEPPER, issued.token, 1000 + 61_000)).toBeNull(); // past ttl
  });

  it("returns null once revoked", async () => {
    const issued = await issueScopedToken(db(), PEPPER, "t1", ["memory:read"], 1000);
    expect(await revokeScopedToken(db(), "t1", issued.id, 2000)).toBe(true);
    expect(await resolveScopedToken(db(), PEPPER, issued.token, 3000)).toBeNull();
  });

  it("cannot be revoked by a different tenant (isolation)", async () => {
    const issued = await issueScopedToken(db(), PEPPER, "t1", ["memory:read"], 1000);
    expect(await revokeScopedToken(db(), "t2", issued.id, 2000)).toBe(false); // wrong tenant
    expect(await resolveScopedToken(db(), PEPPER, issued.token, 3000)).not.toBeNull(); // still valid
  });
});
