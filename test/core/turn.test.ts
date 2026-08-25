import { beforeEach, describe, expect, it } from "vitest";
import { addMemoryService, type Principal, type ToolCoreDeps } from "../../src/core/services";
import { assembleTurn } from "../../src/core/turn";
import { appendMessage } from "../../src/session/append";
import { captureVectorize, fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { appEnv } from "../helpers/env";

const SESSIONS = appEnv.SESSION;
const T1: Principal = { confidential: false, tenantId: "t1" };

function deps(): ToolCoreDeps {
  return { db: db(), ai: fakeAi(), vectorize: captureVectorize().vectorize, sessions: SESSIONS, now: () => 1 };
}

describe("assembleTurn (cache-aware request build)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "agent-a");
  });

  it("P0 #1: retrieved memories ride after the breakpoint, never in the static prefix", async () => {
    const d = deps();
    await addMemoryService(d, T1, { namespace: "agent-a", text: "the sky is blue" });

    const a = await assembleTurn(d, T1, { sessionId: "s1", namespace: "agent-a", systemPrompt: "You are helpful.", message: "tell me about the sky" });

    expect(a.parts.staticPrefix).toBe("system: You are helpful.\nuser: tell me about the sky");
    expect(a.parts.staticPrefix).not.toContain("the sky is blue");
    expect(a.parts.contextBlock).toContain("the sky is blue");
    expect(a.parts.placement).not.toBe("system");
  });

  it("the static prefix is byte-identical whether or not memories are present", async () => {
    const withMem = deps();
    await addMemoryService(withMem, T1, { namespace: "agent-a", text: "irrelevant memory content" });
    const a = await assembleTurn(withMem, T1, { sessionId: "s1", namespace: "agent-a", systemPrompt: "SP", message: "hello" });

    // Same conversation, empty store -> same prefix (memories cannot perturb it).
    const noMem = deps();
    const b = await assembleTurn(noMem, T1, { sessionId: "s1", namespace: "agent-a", systemPrompt: "SP", message: "hello" });

    expect(a.parts.staticPrefix).toBe(b.parts.staticPrefix);
  });

  it("includes session working-memory history in the prefix", async () => {
    const d = deps();
    await appendMessage({ db: db(), sessions: SESSIONS }, { sessionId: "s2", namespaceId: "n1", role: "user", content: "earlier question", ts: 1 });
    const a = await assembleTurn(d, T1, { sessionId: "s2", namespace: "agent-a", systemPrompt: "SP", message: "follow up" });
    expect(a.parts.staticPrefix).toContain("user: earlier question");
    expect(a.parts.staticPrefix.endsWith("user: follow up")).toBe(true);
  });

  it("is tenant-scoped: another tenant cannot assemble a turn against this namespace", async () => {
    await seedTenant("t2");
    await expect(
      assembleTurn(deps(), { confidential: false, tenantId: "t2" }, { sessionId: "s1", namespace: "agent-a", systemPrompt: "SP", message: "hi" }),
    ).rejects.toThrow();
  });
});
