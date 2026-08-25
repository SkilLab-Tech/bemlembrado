import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal, ToolCoreDeps } from "../../src/core/services";
import { ALL_SCOPES, type Scope } from "../../src/auth/scopes";
import { hashApiKey } from "../../src/auth/api-key";
import { buildMcpServer } from "../../src/mcp";
import { createApp } from "../../src/http/app";
import { captureVectorize, fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { appEnv } from "../helpers/env";

/**
 * PR-C: the `search_second_brain` alias (one handler, no second code path) + confidential-aware
 * device-token issuance. The adversarial HTTP block proves the Desktop default (confidential:false)
 * cannot reach the confidential tier and that the claim flows issuance -> middleware -> principal.
 */

const SESSIONS = appEnv.SESSION;
const PEPPER = "test-pepper"; // appEnv.API_KEY_PEPPER
const SECRET = "the sky is blue";

interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}
async function clientFor(deps: ToolCoreDeps, principal: Principal, scopes: readonly Scope[] = ALL_SCOPES): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(ct), buildMcpServer(deps, principal, scopes).connect(st)]);
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}
function errText(r: ToolResult): string {
  return r.content[0]?.text ?? "";
}

describe("search_second_brain alias — MCP surface", () => {
  let deps: ToolCoreDeps;

  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "agent-a");
    deps = { db: db(), ai: fakeAi(), vectorize: captureVectorize().vectorize, sessions: SESSIONS, now: () => 1 };
    await call(await clientFor(deps, { confidential: false, tenantId: "t1" }), "add_memory", { namespace: "agent-a", text: SECRET });
  });

  it("returns a byte-identical payload to search_memory for the same args (no second implementation)", async () => {
    const c = await clientFor(deps, { confidential: false, tenantId: "t1" });
    const args = { namespace: "agent-a", query: "sky" };
    const canonical = await call(c, "search_memory", args);
    const alias = await call(c, "search_second_brain", args);
    expect(alias.content[0]?.text).toBe(canonical.content[0]?.text); // exact same JSON
    expect(errText(alias)).toContain(SECRET); // and it really ran the search
  });

  it("shares the memory:read gate — allowed with the scope, an error without it (no bypass)", async () => {
    const ok = await call(await clientFor(deps, { confidential: false, tenantId: "t1" }, ["memory:read"]), "search_second_brain", { namespace: "agent-a", query: "x" });
    expect(ok.isError ?? false).toBe(false);
    const denied = await call(await clientFor(deps, { confidential: false, tenantId: "t1" }, []), "search_second_brain", { namespace: "agent-a", query: "x" });
    expect(denied.isError).toBe(true);
    expect(errText(denied)).toContain("scope");
  });
});

describe("confidential-aware device-token issuance (HTTP)", () => {
  const ROOT = "bl_root_t1";

  beforeEach(async () => {
    await resetDb();
    await db().insertTenant({ id: "t1", name: "T1", plan: "pro", api_key_hash: await hashApiKey(ROOT, PEPPER), created_at: 1 });
    await seedNamespace("np", "t1", "publico");
    await seedNamespace("nsc", "t1", "cofre");
    await db().setNamespaceConfidential("t1", "nsc");
  });

  async function req(method: string, path: string, tok: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${tok}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    return createApp().request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, appEnv);
  }
  async function mint(scopes: string[], confidential?: boolean): Promise<{ status: number; token: string; confidential: boolean }> {
    const res = await req("POST", "/v1/tokens", ROOT, confidential === undefined ? { scopes } : { scopes, confidential });
    const raw: unknown = await res.json();
    const body = raw as { token: string; confidential: boolean };
    return { status: res.status, token: body.token, confidential: body.confidential };
  }

  it("ADVERSARIAL: a Desktop-shaped mint (no confidential field) defaults to confidential:false and cannot reach the confidential tier", async () => {
    const desktop = await mint(["memory:read", "session:read"]);
    expect(desktop.status).toBe(201);
    expect(desktop.confidential).toBe(false); // the locked default — issuance did not silently elevate
    // the claim flows issuance -> middleware -> principal -> resolver: confidential ns is a uniform 404
    expect((await req("GET", "/v1/notes?namespace=cofre", desktop.token)).status).toBe(404);
    expect((await req("GET", "/v1/notes?namespace=publico", desktop.token)).status).toBe(200);
    // and a read-only device cannot escalate to a write, confidential or not
    expect((await req("POST", "/v1/namespaces", desktop.token, { namespace: "x" })).status).toBe(403);
  });

  it("an explicit {confidential:true} mint reaches the confidential tier (the switch is real, not a stub)", async () => {
    const priv = await mint(["memory:read"], true);
    expect(priv.confidential).toBe(true);
    expect((await req("GET", "/v1/notes?namespace=cofre", priv.token)).status).toBe(200);
  });

  it("GET /v1/tokens echoes the device tier but NEVER the hash", async () => {
    await mint(["memory:read"], true);
    const res = await req("GET", "/v1/tokens", ROOT);
    const raw = await res.text();
    expect(raw).not.toContain("token_hash");
    const parsed: unknown = JSON.parse(raw);
    const body = parsed as { tokens: { confidential: boolean }[] };
    expect(body.tokens[0]?.confidential).toBe(true);
  });
});
