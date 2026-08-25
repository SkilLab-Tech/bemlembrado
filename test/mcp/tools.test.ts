import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal, ToolCoreDeps } from "../../src/core/services";
import { ALL_SCOPES, type Scope } from "../../src/auth/scopes";
import { buildMcpServer } from "../../src/mcp";
import { appendMessage } from "../../src/session/append";
import { captureVectorize, fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { appEnv } from "../helpers/env";

const SESSIONS = appEnv.SESSION;

interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

/** Connect an MCP client to a server bound to (deps, principal, scopes — default full access). */
async function clientFor(deps: ToolCoreDeps, principal: Principal, scopes: readonly Scope[] = ALL_SCOPES): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), buildMcpServer(deps, principal, scopes).connect(serverTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function payload(r: ToolResult): unknown {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

describe("MCP tools (bound to the API-key tenant)", () => {
  let deps: ToolCoreDeps;

  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedTenant("t2");
    await seedTenant("t3");
    await seedNamespace("n1", "t1", "agent-a");
    await seedNamespace("n2", "t2", "agent-a"); // SAME label, different tenant
    // One shared store so an add by t1 is, in principle, queryable — isolation must still block t2.
    deps = { db: db(), ai: fakeAi(), vectorize: captureVectorize().vectorize, sessions: SESSIONS, now: () => 1 };
  });

  it("exposes the three memory tools (+ ping)", async () => {
    const client = await clientFor(deps, { confidential: false, tenantId: "t1" });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["add_memory", "search_memory", "get_session_context", "ping"]));
  });

  it("add_memory then search_memory round-trip for the bound tenant", async () => {
    const client = await clientFor(deps, { confidential: false, tenantId: "t1", keyId: "key-t1" });
    const add = await call(client, "add_memory", { namespace: "agent-a", text: "the sky is blue" });
    const { id } = payload(add) as { id: string };
    expect(id.length).toBeGreaterThan(0);

    const search = await call(client, "search_memory", { namespace: "agent-a", query: "sky" });
    const { hits } = payload(search) as { hits: { id: string; text: string | null }[] };
    expect(hits.map((h) => h.id)).toContain(id);
  });

  it("ISOLATION GATE: two keys, two tenants — T2 never sees T1's memory", async () => {
    const t1 = await clientFor(deps, { confidential: false, tenantId: "t1" });
    const t2 = await clientFor(deps, { confidential: false, tenantId: "t2" });

    await call(t1, "add_memory", { namespace: "agent-a", text: "t1-confidential" });

    // T2 searches its OWN "agent-a" (n2): resolves to a different namespace -> no leak.
    const t2search = await call(t2, "search_memory", { namespace: "agent-a", query: "confidential" });
    const t2hits = payload(t2search) as { hits: { text: string | null }[] };
    expect(t2hits.hits.every((h) => h.text !== "t1-confidential")).toBe(true);

    // A tenant with NO such namespace cannot probe it at all -> tool error.
    const t3 = await clientFor(deps, { confidential: false, tenantId: "t3" });
    const t3search = await call(t3, "search_memory", { namespace: "agent-a", query: "confidential" });
    expect(t3search.isError).toBe(true);
    expect(t3search.content[0]?.text ?? "").not.toContain("t1-confidential");
  });

  it("SCOPE GATE: a read-only scoped token cannot write or run a turn over MCP", async () => {
    // A delegated token granted only memory:read — same subset apiKeyAuth would set.
    const readOnly = await clientFor(deps, { confidential: false, tenantId: "t1", keyId: "tok:abc" }, ["memory:read"]);

    // search (memory:read) is allowed
    const ok = await call(readOnly, "search_memory", { namespace: "agent-a", query: "anything" });
    expect(ok.isError ?? false).toBe(false);

    // add_memory (memory:write) is DENIED — no escalation over MCP
    const denied = await call(readOnly, "add_memory", { namespace: "agent-a", text: "should be blocked" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text ?? "").toContain("scope");

    // and the write really did NOT happen
    const full = await clientFor(deps, { confidential: false, tenantId: "t1" });
    const after = await call(full, "search_memory", { namespace: "agent-a", query: "blocked" });
    const hits = (payload(after) as { hits: { text: string | null }[] }).hits;
    expect(hits.every((h) => h.text !== "should be blocked")).toBe(true);
  });

  it("SCOPE GATE: no scopes → every mutating/reading tool is denied (fail-closed)", async () => {
    const none = await clientFor(deps, { confidential: false, tenantId: "t1" }, []);
    const w = await call(none, "add_memory", { namespace: "agent-a", text: "x" });
    const r = await call(none, "search_memory", { namespace: "agent-a", query: "x" });
    const s = await call(none, "get_session_context", { sessionId: "s1" });
    expect(w.isError).toBe(true);
    expect(r.isError).toBe(true);
    expect(s.isError).toBe(true);
    // ping needs no scope
    const p = await call(none, "ping", {});
    expect(p.isError ?? false).toBe(false);
  });

  it("get_session_context is tenant-scoped: owner reads it, another tenant gets an error", async () => {
    await appendMessage({ db: db(), sessions: SESSIONS }, { sessionId: "s1", namespaceId: "n1", role: "user", content: "hi", ts: 1 });

    const owner = await call(await clientFor(deps, { confidential: false, tenantId: "t1" }), "get_session_context", { sessionId: "s1" });
    const ctx = payload(owner) as { messages: { content: string }[]; block: { placement: string } };
    expect(ctx.messages.map((m) => m.content)).toStrictEqual(["hi"]);
    expect(ctx.block.placement).not.toBe("system"); // P0 #1

    const intruder = await call(await clientFor(deps, { confidential: false, tenantId: "t2" }), "get_session_context", { sessionId: "s1" });
    expect(intruder.isError).toBe(true);
  });
});

describe("MCP namespace tools (create_namespace / list_namespaces)", () => {
  let deps: ToolCoreDeps;

  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedTenant("t2");
    deps = { db: db(), ai: fakeAi(), vectorize: captureVectorize().vectorize, sessions: SESSIONS, now: () => 1 };
  });

  it("lists the two namespace tools", async () => {
    const names = (await (await clientFor(deps, { confidential: false, tenantId: "t1" })).listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["create_namespace", "list_namespaces"]));
  });

  it("create → list shows it → re-create is idempotent (created:false)", async () => {
    const client = await clientFor(deps, { confidential: false, tenantId: "t1" });

    const created = payload(await call(client, "create_namespace", { namespace: "agent-a" })) as { label: string; created: boolean };
    expect(created).toMatchObject({ label: "agent-a", created: true });

    const list = payload(await call(client, "list_namespaces", {})) as { namespaces: { label: string }[] };
    expect(list.namespaces.map((n) => n.label)).toContain("agent-a");

    const again = payload(await call(client, "create_namespace", { namespace: "agent-a" })) as { created: boolean };
    expect(again.created).toBe(false);
    expect((await db().listNamespacesByTenant("t1")).filter((n) => n.label === "agent-a")).toHaveLength(1);
  });

  it("CONFIDENTIAL GATE: a non-confidential caller cannot list or create over a confidential namespace", async () => {
    await seedNamespace("nsc", "t1", "cofre");
    await db().setNamespaceConfidential("t1", "nsc");

    // list omits the confidential row for a non-confidential principal, shows it for a confidential one
    const nonconf = await clientFor(deps, { confidential: false, tenantId: "t1" });
    const conf = await clientFor(deps, { confidential: true, tenantId: "t1" });
    expect((payload(await call(nonconf, "list_namespaces", {})) as { namespaces: { label: string }[] }).namespaces.map((n) => n.label)).not.toContain("cofre");
    expect((payload(await call(conf, "list_namespaces", {})) as { namespaces: { label: string }[] }).namespaces.map((n) => n.label)).toContain("cofre");

    // create on the hidden label is a uniform 404 (no existence/id oracle) for the non-confidential caller
    const blocked = await call(nonconf, "create_namespace", { namespace: "cofre" });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]?.text ?? "").toContain("not found");
  });

  it("SCOPE GATE: create_namespace needs memory:write; list_namespaces needs memory:read", async () => {
    const readOnly = await clientFor(deps, { confidential: false, tenantId: "t1" }, ["memory:read"]);
    const denied = await call(readOnly, "create_namespace", { namespace: "nope" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text ?? "").toContain("scope");
    expect((await db().listNamespacesByTenant("t1")).filter((n) => n.label === "nope")).toHaveLength(0);

    const none = await clientFor(deps, { confidential: false, tenantId: "t1" }, []);
    expect((await call(none, "list_namespaces", {})).isError).toBe(true);
  });

  it("is tenant-scoped: list never leaks another tenant's namespaces", async () => {
    await seedNamespace("o1", "t2", "secret-ns");
    const t1 = await clientFor(deps, { confidential: false, tenantId: "t1" });
    const labels = (payload(await call(t1, "list_namespaces", {})) as { namespaces: { label: string }[] }).namespaces.map((n) => n.label);
    expect(labels).not.toContain("secret-ns");
  });
});

describe("MCP page/decision tools (get_page / log_decision — P5 tool reconcile)", () => {
  let deps: ToolCoreDeps;

  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedTenant("t2");
    await seedTenant("t3");
    await seedNamespace("n1", "t1", "agent-a");
    await seedNamespace("n2", "t2", "agent-a"); // SAME label, different tenant
    // Strictly increasing clock (not a fixed `now`) — get_page orders by created_at DESC,
    // and a tied created_at across two adds would make that order undefined.
    let clock = 0;
    deps = { db: db(), ai: fakeAi(), vectorize: captureVectorize().vectorize, sessions: SESSIONS, now: () => ++clock };
  });

  it("lists the two tools", async () => {
    const names = (await (await clientFor(deps, { confidential: false, tenantId: "t1" })).listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_page", "log_decision"]));
  });

  it("log_decision writes a retrievable memory composed as '# title' + body + a refs footer", async () => {
    const client = await clientFor(deps, { confidential: false, tenantId: "t1" });
    const logged = payload(
      await call(client, "log_decision", { namespace: "agent-a", title: "Adopt Postgres", body: "Chosen for JSONB support.", refs: ["PR#42"] }),
    ) as { id: string };
    expect(logged.id.length).toBeGreaterThan(0);

    const page = payload(await call(client, "get_page", { namespace: "agent-a" })) as { memories: { id: string; text: string | null }[] };
    const row = page.memories.find((m) => m.id === logged.id);
    expect(row?.text).toBe("# Adopt Postgres\n\nChosen for JSONB support.\n\nRefs: PR#42");
  });

  it("get_page lists a namespace's memories newest-first, clamped to `limit` (distinct from search_memory's ranking)", async () => {
    const client = await clientFor(deps, { confidential: false, tenantId: "t1" });
    const { id: firstId } = payload(await call(client, "add_memory", { namespace: "agent-a", text: "first" })) as { id: string };
    const { id: secondId } = payload(await call(client, "add_memory", { namespace: "agent-a", text: "second" })) as { id: string };

    const full = payload(await call(client, "get_page", { namespace: "agent-a" })) as { memories: { id: string }[] };
    expect(full.memories.map((m) => m.id)).toEqual([secondId, firstId]);

    const capped = payload(await call(client, "get_page", { namespace: "agent-a", limit: 1 })) as { memories: { id: string }[] };
    expect(capped.memories.map((m) => m.id)).toEqual([secondId]);
  });

  it("ISOLATION GATE: get_page is tenant-scoped — T2 never sees T1's page, and a tenant with no such namespace cannot probe it", async () => {
    const t1 = await clientFor(deps, { confidential: false, tenantId: "t1" });
    const t2 = await clientFor(deps, { confidential: false, tenantId: "t2" });

    await call(t1, "add_memory", { namespace: "agent-a", text: "t1-only" });

    // T2's OWN "agent-a" (n2) resolves to a different namespace -> no leak.
    const t2page = payload(await call(t2, "get_page", { namespace: "agent-a" })) as { memories: { text: string | null }[] };
    expect(t2page.memories.every((m) => m.text !== "t1-only")).toBe(true);

    // A tenant with no such namespace at all cannot probe it -> tool error, never a leak.
    const t3 = await clientFor(deps, { confidential: false, tenantId: "t3" });
    const t3page = await call(t3, "get_page", { namespace: "agent-a" });
    expect(t3page.isError).toBe(true);
    expect(t3page.content[0]?.text ?? "").not.toContain("t1-only");
  });

  it("SCOPE GATE: get_page needs memory:read; log_decision needs memory:write", async () => {
    const writeOnly = await clientFor(deps, { confidential: false, tenantId: "t1" }, ["memory:write"]);
    const deniedRead = await call(writeOnly, "get_page", { namespace: "agent-a" });
    expect(deniedRead.isError).toBe(true);
    expect(deniedRead.content[0]?.text ?? "").toContain("scope");

    const readOnly = await clientFor(deps, { confidential: false, tenantId: "t1" }, ["memory:read"]);
    const deniedWrite = await call(readOnly, "log_decision", { namespace: "agent-a", title: "x", body: "y" });
    expect(deniedWrite.isError).toBe(true);
    expect(deniedWrite.content[0]?.text ?? "").toContain("scope");
  });
});
