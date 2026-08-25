import { beforeEach, describe, expect, it } from "vitest";
import {
  addMemoryService,
  getSessionContextService,
  type Principal,
  searchMemoryService,
  type ToolCoreDeps,
} from "../../src/core/services";
import { Audit } from "../../src/lgpd/audit";
import { appendMessage } from "../../src/session/append";
import type { SessionDO } from "../../src/session/session-do";
import { captureVectorize, fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { testEnv } from "../helpers/env";

const SESSIONS = testEnv.SESSION as unknown as DurableObjectNamespace<SessionDO>;
const T1: Principal = { confidential: false, tenantId: "t1", keyId: "key-t1", requestId: "req-1" };

function deps(): ToolCoreDeps {
  return { db: db(), ai: fakeAi(), vectorize: captureVectorize().vectorize, sessions: SESSIONS, now: () => 1000 };
}

// A deps() whose vectorize is shared between an add and a search (same store).
function sharedDeps(): ToolCoreDeps {
  const { vectorize } = captureVectorize();
  return { db: db(), ai: fakeAi(), vectorize, sessions: SESSIONS, now: () => 1000 };
}

describe("tool-core services", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("n1", "t1", "agent-a");
  });

  it("add then search hit the SAME store (add-write is search-readable)", async () => {
    const d = sharedDeps();
    const { id } = await addMemoryService(d, T1, { namespace: "agent-a", text: "the sky is blue" });
    const { hits } = await searchMemoryService(d, T1, { namespace: "agent-a", query: "sky" });
    expect(hits.map((h) => h.id)).toContain(id);
    expect(hits.find((h) => h.id === id)?.text).toBe("the sky is blue");
  });

  it("audits write (mem target) and read (query HASHED, never raw)", async () => {
    const d = sharedDeps();
    const { id } = await addMemoryService(d, T1, { namespace: "agent-a", text: "x" });
    await searchMemoryService(d, T1, { namespace: "agent-a", query: "secret query 42" });

    const rows = await new Audit(db()).list("t1");
    expect(rows.map((r) => r.action)).toStrictEqual(["write", "read"]);
    expect(rows[0]?.target).toBe(`mem:agent-a#${id}`);
    expect(rows[0]?.actor).toBe("key-t1");
    expect(rows[1]?.target).toMatch(/^query:agent-a#[0-9a-f]{16}$/);
    expect(rows[1]?.target).not.toContain("secret query 42");
  });

  it("enforces boundary bounds (BadRequest before any store touch)", async () => {
    const d = deps();
    await expect(addMemoryService(d, T1, { namespace: "agent-a", text: "x".repeat(10_001) })).rejects.toThrow(/text/);
    await expect(addMemoryService(d, T1, { namespace: "", text: "ok" })).rejects.toThrow();
    await expect(
      addMemoryService(d, T1, { namespace: "agent-a", text: "ok", metadata: { big: "x".repeat(6000) } }),
    ).rejects.toThrow(/metadata/);
    await expect(searchMemoryService(d, T1, { namespace: "agent-a", query: "x".repeat(1001) })).rejects.toThrow(/query/);
    await expect(searchMemoryService(d, T1, { namespace: "agent-a", query: "ok", topK: 51 })).rejects.toThrow();
  });

  it("is tenant-scoped: T2 cannot add or search T1's namespace label", async () => {
    const d = deps();
    await expect(addMemoryService(d, { confidential: false, tenantId: "t2" }, { namespace: "agent-a", text: "x" })).rejects.toThrow();
    await expect(searchMemoryService(d, { confidential: false, tenantId: "t2" }, { namespace: "agent-a", query: "x" })).rejects.toThrow();
  });
});

describe("getSessionContextService", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedTenant("t2");
    await seedNamespace("n1", "t1", "agent-a");
  });

  it("returns working memory for the owner; block placement is never 'system' (P0 #1)", async () => {
    await appendMessage({ db: db(), sessions: SESSIONS }, { sessionId: "s1", namespaceId: "n1", role: "user", content: "hi", ts: 1 });
    await appendMessage({ db: db(), sessions: SESSIONS }, { sessionId: "s1", namespaceId: "n1", role: "assistant", content: "hello", ts: 2 });

    const res = await getSessionContextService(deps(), T1, { sessionId: "s1" });
    expect(res.messages.map((m) => m.content)).toStrictEqual(["hi", "hello"]);
    expect(res.block.placement).toBe("tool_result");
    expect(res.block.text).toContain("[user] hi");
    expect(res.block.text).not.toContain("system");
  });

  it("opts into mid_conv_system only when asked (Opus-4.8), still never 'system'", async () => {
    await appendMessage({ db: db(), sessions: SESSIONS }, { sessionId: "s2", namespaceId: "n1", role: "user", content: "yo", ts: 1 });
    const res = await getSessionContextService(deps(), T1, { sessionId: "s2", allowMidConvSystem: true });
    expect(res.block.placement).toBe("mid_conv_system");
  });

  it("a cross-tenant session id is a uniform 404, not an oracle", async () => {
    await appendMessage({ db: db(), sessions: SESSIONS }, { sessionId: "s1", namespaceId: "n1", role: "user", content: "t1-only", ts: 1 });
    // T2 asks for T1's session id -> NotFound, same as a nonexistent id.
    await expect(getSessionContextService(deps(), { confidential: false, tenantId: "t2" }, { sessionId: "s1" })).rejects.toThrow(/not found/);
    await expect(getSessionContextService(deps(), T1, { sessionId: "does-not-exist" })).rejects.toThrow(/not found/);
  });
});
