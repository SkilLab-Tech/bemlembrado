import { beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "../../src/auth/api-key";
import { Db } from "../../src/db/client";
import { createApp } from "../../src/http/app";
import { readVaultExport } from "../../src/lgpd/export";
import { type Note, VaultStore } from "../../src/vault/store";
import { appEnv, testEnv } from "../helpers/env";
import { resetDb, seedNamespace } from "../helpers/fixtures";

const PEPPER = "test-pepper";
const KEY = "bl_lgpdtenant";

function note(slug: string, body: string): Note {
  return { slug, frontmatter: { id: `id-${slug}`, type: "fact", created_at: 1, updated_at: 1, links: [] }, body };
}

async function clearVault(): Promise<void> {
  const res = await testEnv.VAULT.list();
  if (res.objects.length > 0) await testEnv.VAULT.delete(res.objects.map((o) => o.key));
}

async function bearer(app: ReturnType<typeof createApp>, token: string): Promise<Response> {
  return app.request("/v1/lgpd/export", { method: "POST", headers: { authorization: `Bearer ${token}` } }, appEnv);
}

describe("REST /v1/lgpd/export — right-to-portability", () => {
  beforeEach(async () => {
    await resetDb();
    await clearVault();
    const db = new Db(testEnv.DB);
    await db.insertTenant({ id: "t1", name: "T1", plan: "pro", api_key_hash: await hashApiKey(KEY, PEPPER), created_at: 1 });
    await seedNamespace("n1", "t1", "agent-a");
    await new VaultStore(testEnv.VAULT).putNote("t1", "n1", note("ana", "Ana is a client."));
  });

  it("401 without a credential", async () => {
    expect((await createApp().request("/v1/lgpd/export", { method: "POST" }, appEnv)).status).toBe(401);
  });

  it("root API key → 200 zip with the tenant's vault (manifest + note)", async () => {
    const res = await bearer(createApp(), KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain('attachment; filename="bemlembrado-export-t1-');

    const parsed = readVaultExport(new Uint8Array(await res.arrayBuffer()));
    expect(parsed.manifest.tenant).toBe("t1");
    expect(parsed.manifest.namespaces[0]?.notes).toStrictEqual(["ana"]);
    expect(parsed.files.get("agent-a/notes/ana.md")).toContain("Ana is a client.");
  });

  it("delegated scoped token → 403 (a device token must never export the confidential tier)", async () => {
    const app = createApp();
    const issued = await app.request(
      "/v1/tokens",
      { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ scopes: ["memory:read"] }) },
      appEnv,
    );
    const { token }: { token: string } = await issued.json();
    expect((await bearer(app, token)).status).toBe(403);
  });
});
