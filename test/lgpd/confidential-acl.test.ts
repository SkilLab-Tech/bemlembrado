import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal, ToolCoreDeps } from "../../src/core/services";
import { ALL_SCOPES, type Scope } from "../../src/auth/scopes";
import { buildMcpServer } from "../../src/mcp";
import { createApp } from "../../src/http/app";
import { issueScopedToken } from "../../src/auth/scoped-token";
import { appendMessage } from "../../src/session/append";
import { captureVectorize, fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { appEnv } from "../helpers/env";

/**
 * P4 — per-namespace confidential ACL (LGPD default-EXCLUDE). Proves the read gate is
 * DEVICE-DERIVED (from the credential, never a request param), uniform-404 (no oracle),
 * monotonic, and that the claim flows credential -> middleware -> principal end-to-end.
 */

const SESSIONS = appEnv.SESSION;
const PEPPER = "test-pepper"; // appEnv.API_KEY_PEPPER
const SECRET = "cpf 123.456.789-00 do cliente fulano";

interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}
async function clientFor(deps: ToolCoreDeps, principal: Principal, scopes: readonly Scope[] = ALL_SCOPES): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(ct), buildMcpServer(deps, principal, scopes).connect(st)]);
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}
function payload(r: ToolResult): unknown {
  return JSON.parse(r.content[0]?.text ?? "{}");
}
function errText(r: ToolResult): string {
  return r.content[0]?.text ?? "";
}

const CONF: Principal = { confidential: true, tenantId: "t1" };
const NONCONF: Principal = { confidential: false, tenantId: "t1" };

describe("confidential ACL (P4) — MCP surface", () => {
  let deps: ToolCoreDeps;

  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedNamespace("nsc", "t1", "cofre");
    await db().setNamespaceConfidential("t1", "nsc");
    // one shared vector store so a write is searchable back
    deps = { db: db(), ai: fakeAi(), vectorize: captureVectorize().vectorize, sessions: SESSIONS, now: () => 1 };
    // seed the secret INTO the confidential namespace, via an authorized (confidential) writer
    await call(await clientFor(deps, CONF), "add_memory", { namespace: "cofre", text: SECRET });
  });

  it("A-1 ADVERSARIAL: a non-confidential caller cannot read the confidential ns even with client params begging for it", async () => {
    const c = await clientFor(deps, NONCONF);
    const res = await call(c, "search_memory", { namespace: "cofre", query: "cpf", include_confidential: true, tier: "confidential" });
    expect(res.isError).toBe(true);
    expect(errText(res)).not.toContain("123.456.789-00"); // the secret never leaks
  });

  it("A-2 no oracle: the confidential-ns error is identical to a nonexistent-ns error", async () => {
    const c = await clientFor(deps, NONCONF);
    const confidentialErr = errText(await call(c, "search_memory", { namespace: "cofre", query: "x" }));
    const missingErr = errText(await call(c, "search_memory", { namespace: "does-not-exist", query: "x" }));
    expect(confidentialErr).toBe(missingErr);
    expect(confidentialErr).toContain("namespace not found");
  });

  it("A-3 authorized read works (the gate is not a blanket deny)", async () => {
    const c = await clientFor(deps, CONF);
    const res = await call(c, "search_memory", { namespace: "cofre", query: "cpf" });
    expect(res.isError ?? false).toBe(false);
    const { hits } = payload(res) as { hits: { text: string | null }[] };
    expect(hits.some((h) => h.text === SECRET)).toBe(true);
  });

  it("A-4 Desktop-shaped token (read-only, non-confidential): no write, no confidential read", async () => {
    const c = await clientFor(deps, NONCONF, ["memory:read", "session:read"]);
    const w = await call(c, "add_memory", { namespace: "cofre", text: "x" });
    expect(w.isError).toBe(true);
    expect(errText(w)).toContain("scope"); // denied by scope before anything else
    const r = await call(c, "search_memory", { namespace: "cofre", query: "cpf" });
    expect(r.isError).toBe(true); // confidential ns invisible
  });

  it("A-5 a non-confidential full-scope caller cannot WRITE into the confidential ns", async () => {
    const c = await clientFor(deps, NONCONF); // full scopes, but confidential:false
    const w = await call(c, "add_memory", { namespace: "cofre", text: "pollution" });
    expect(w.isError).toBe(true); // resolver 404s before any insert
    // and nothing landed: an authorized search still returns only the original secret
    const r = await call(await clientFor(deps, CONF), "search_memory", { namespace: "cofre", query: "pollution", topK: 50 });
    const { hits } = payload(r) as { hits: { text: string | null }[] };
    expect(hits.some((h) => h.text === "pollution")).toBe(false);
  });

  it("A-6 monotonic by construction: no un-mark method exists at the data layer", async () => {
    const layer = db() as unknown as Record<string, unknown>;
    expect(typeof layer.setNamespaceConfidential).toBe("function");
    expect(layer.clearNamespaceConfidential).toBeUndefined();
    expect(layer.setNamespacePublic).toBeUndefined();
    // re-marking is idempotent and never downgrades
    await db().setNamespaceConfidential("t1", "nsc");
    const ns = await db().getNamespace("t1", "cofre");
    expect(ns?.confidential).toBe(1);
  });

  it("A-7 session ACL: a session in a confidential ns follows the same claim", async () => {
    await appendMessage({ db: db(), sessions: SESSIONS }, { sessionId: "s", namespaceId: "nsc", role: "user", content: "segredo", ts: 1, id: "mm" });
    const denied = await call(await clientFor(deps, NONCONF), "get_session_context", { sessionId: "s" });
    expect(denied.isError).toBe(true);
    const ok = await call(await clientFor(deps, CONF), "get_session_context", { sessionId: "s" });
    expect(ok.isError ?? false).toBe(false);
    const ctx = payload(ok) as { messages: { content: string }[] };
    expect(ctx.messages.map((m) => m.content)).toContain("segredo");
  });

  it("A-8 create_namespace confidential:true is born confidential — closes the 'sensitive ns born public' gap", async () => {
    const created = payload(await call(await clientFor(deps, CONF), "create_namespace", { namespace: "exames", confidential: true })) as {
      created: boolean;
      confidential: boolean;
    };
    expect(created.created).toBe(true);
    expect(created.confidential).toBe(true);
    // a non-confidential caller cannot even see the freshly-created confidential ns (uniform 404)
    expect((await call(await clientFor(deps, NONCONF), "get_page", { namespace: "exames" })).isError).toBe(true);
    // the confidential creator can (the gate is not a blanket deny)
    expect((await call(await clientFor(deps, CONF), "get_page", { namespace: "exames" })).isError ?? false).toBe(false);
  });

  it("A-8b confidential:true is applied on CREATION only — an existing visible ns is never silently hidden", async () => {
    await call(await clientFor(deps, CONF), "create_namespace", { namespace: "publico2" }); // born public
    const again = payload(await call(await clientFor(deps, CONF), "create_namespace", { namespace: "publico2", confidential: true })) as {
      created: boolean;
      confidential: boolean;
    };
    expect(again.created).toBe(false);
    expect(again.confidential).toBe(false); // NOT flipped — no griefing of a tenant's own data
    const seen = payload(await call(await clientFor(deps, NONCONF), "list_namespaces", {})) as { namespaces: { label: string }[] };
    expect(seen.namespaces.map((n) => n.label)).toContain("publico2"); // still visible to a non-confidential caller
  });

  it("A-8c sensitive-read trail (mig 0022): a confidential read audits confidential=1, a public read 0", async () => {
    await call(await clientFor(deps, CONF), "create_namespace", { namespace: "aberto" }); // public
    await call(await clientFor(deps, CONF), "get_page", { namespace: "aberto" }); // public read
    await call(await clientFor(deps, CONF), "get_page", { namespace: "cofre" }); // confidential read (seeded in beforeEach)
    const reads = (await db().listAuditEventsByTenant("t1")).filter((e) => e.action === "read");
    const confidential = reads.filter((e) => e.confidential === 1);
    const open = reads.filter((e) => e.confidential === 0);
    expect(confidential.length).toBe(1); // exactly the cofre read — the flag is sourced at the resolve choke point
    expect(confidential[0]?.target).toContain("cofre");
    expect(open.some((e) => (e.target ?? "").includes("aberto"))).toBe(true); // the public read is marked 0, not conflated
  });
});

describe("confidential ACL (P4) — claim flows credential -> middleware -> principal (HTTP)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedNamespace("np", "t1", "publico");
    await seedNamespace("nsc", "t1", "cofre");
    await db().setNamespaceConfidential("t1", "nsc");
  });

  async function tokenWith(scopes: readonly Scope[], confidential: boolean): Promise<string> {
    const issued = await issueScopedToken(db(), PEPPER, "t1", scopes, 1, confidential ? { confidential: true } : {});
    return issued.token;
  }
  async function token(confidential: boolean): Promise<string> {
    return tokenWith(["memory:read"], confidential);
  }
  async function get(path: string, tok: string): Promise<Response> {
    return createApp().request(path, { headers: { authorization: `Bearer ${tok}` } }, appEnv);
  }
  async function req(method: string, path: string, tok: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${tok}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    return createApp().request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, appEnv);
  }
  async function getJson<T>(path: string, tok: string): Promise<T> {
    const raw: unknown = await (await get(path, tok)).json();
    return raw as T;
  }

  it("A-10 a non-confidential token 404s on the confidential ns; a confidential token 200s (GET /v1/notes)", async () => {
    expect((await get("/v1/notes?namespace=cofre", await token(false))).status).toBe(404);
    expect((await get("/v1/notes?namespace=publico", await token(false))).status).toBe(200);
    expect((await get("/v1/notes?namespace=cofre", await token(true))).status).toBe(200);
  });

  it("A-9 label leak: GET /v1/namespaces hides the confidential label from a non-confidential caller", async () => {
    const hidden = await getJson<{ namespaces: { label: string }[] }>("/v1/namespaces", await token(false));
    expect(hidden.namespaces.map((n) => n.label)).toEqual(["publico"]);
    const full = await getJson<{ namespaces: { label: string; confidential: boolean }[] }>("/v1/namespaces", await token(true));
    expect(full.namespaces.map((n) => n.label).sort()).toEqual(["cofre", "publico"]);
    expect(full.namespaces.find((n) => n.label === "cofre")?.confidential).toBe(true);
  });

  it("A-11 create oracle: POST /v1/namespaces on a confidential label is a uniform 404 for a non-confidential writer (no created:false / id leak)", async () => {
    // The exact attack the review found: a routine non-confidential memory:write token probing a hidden label.
    const denied = await req("POST", "/v1/namespaces", await tokenWith(["memory:write"], false), { namespace: "cofre" });
    expect(denied.status).toBe(404); // NOT 200 created:false, NOT 201
    expect(await denied.text()).not.toContain("nsc"); // the deterministic namespace id never leaks
    // The gate does not break normal creation: a free label still creates (201).
    const created = await req("POST", "/v1/namespaces", await tokenWith(["memory:write"], false), { namespace: "novo" });
    expect(created.status).toBe(201);
    // A confidential writer gets the authorized idempotent 200 on the same label.
    const ok = await req("POST", "/v1/namespaces", await tokenWith(["memory:write"], true), { namespace: "cofre" });
    expect(ok.status).toBe(200);
  });

  it("A-12 delete-by-id oracle: a non-confidential memory:delete token cannot cascade-delete the confidential ns via its deterministic id", async () => {
    const denied = await req("DELETE", "/v1/namespaces/nsc", await tokenWith(["memory:delete"], false));
    expect(denied.status).toBe(404); // uniform with a nonexistent / cross-tenant id
    // and it really is NOT gone: a confidential reader still sees the label.
    const stillThere = await getJson<{ namespaces: { label: string }[] }>("/v1/namespaces", await tokenWith(["memory:read"], true));
    expect(stillThere.namespaces.map((n) => n.label)).toContain("cofre");
    // the gate is not a blanket deny: a confidential memory:delete token CAN erase it.
    const ok = await req("DELETE", "/v1/namespaces/nsc", await tokenWith(["memory:delete"], true));
    expect(ok.status).toBe(200);
  });
});
