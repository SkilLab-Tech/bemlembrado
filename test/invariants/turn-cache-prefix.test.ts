import { beforeEach, describe, expect, it } from "vitest";
import { addMemoryService, type Principal, type ToolCoreDeps } from "../../src/core/services";
import { assembleTurn } from "../../src/core/turn";
import { appendMessage } from "../../src/session/append";
import { captureVectorize, fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { appEnv } from "../helpers/env";

const SESSIONS = appEnv.SESSION;
const T1: Principal = { confidential: false, tenantId: "t1" };

/**
 * P0 invariant #1 — extended to the LIVE multi-turn assembly (turn-batch).
 * Across turns of a session the cacheable prefix must be APPEND-ONLY (turn N+1's
 * prefix begins with turn N's, byte-for-byte) and INDEPENDENT of the retrieved
 * memories (which change per turn). Gated via P0_CACHE_PREFIX=required.
 */
describe("P0 invariant #1 — live turn assembly", () => {
  let deps: ToolCoreDeps;
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "agent-a");
    deps = { db: db(), ai: fakeAi(), vectorize: captureVectorize().vectorize, sessions: SESSIONS, now: () => 1 };
  });

  it("the cacheable prefix is append-only across turns and never carries retrieved memories", async () => {
    await addMemoryService(deps, T1, { namespace: "agent-a", text: "MEM-TURN-1" });

    const t1 = await assembleTurn(deps, T1, { sessionId: "s1", namespace: "agent-a", systemPrompt: "SP", message: "A" });
    expect(t1.parts.staticPrefix).toBe("system: SP\nuser: A");
    expect(t1.parts.staticPrefix).not.toContain("MEM");

    // Turn 1 happens: persist the exchange, and the memory set CHANGES.
    await appendMessage({ db: db(), sessions: SESSIONS }, { sessionId: "s1", namespaceId: "n1", role: "user", content: "A", ts: 1 });
    await appendMessage({ db: db(), sessions: SESSIONS }, { sessionId: "s1", namespaceId: "n1", role: "assistant", content: "reply-1", ts: 2 });
    await addMemoryService(deps, T1, { namespace: "agent-a", text: "MEM-TURN-2-DIFFERENT" });

    const t2 = await assembleTurn(deps, T1, { sessionId: "s1", namespace: "agent-a", systemPrompt: "SP", message: "B" });

    // Append-only: turn 2's prefix starts with turn 1's prefix, byte-for-byte.
    expect(t2.parts.staticPrefix.startsWith(t1.parts.staticPrefix)).toBe(true);
    expect(t2.parts.staticPrefix).toBe("system: SP\nuser: A\nassistant: reply-1\nuser: B");
    // Memory-independent: neither turn's prefix carries any retrieved memory.
    expect(t2.parts.staticPrefix).not.toContain("MEM");
    // The changed memory shows up ONLY in the (post-breakpoint) Context Block.
    expect(t2.parts.contextBlock).toContain("MEM");
    expect(t2.parts.placement).not.toBe("system");
  });
});
