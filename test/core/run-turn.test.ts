import { beforeEach, describe, expect, it } from "vitest";
import { addMemoryService, type Principal } from "../../src/core/services";
import { buildChatMessages, runTurn, type TurnDeps } from "../../src/core/run-turn";
import { assembleTurn } from "../../src/core/turn";
import { type AiChatBinding, InferenceClient } from "../../src/inference/client";
import { sessionStub } from "../../src/session/session-do";
import { captureVectorize, fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { appEnv } from "../helpers/env";

const SESSIONS = appEnv.SESSION;
const T1: Principal = { confidential: false, tenantId: "t1" };
const REPLY = "the sky is blue due to Rayleigh scattering";

function turnDeps(): TurnDeps {
  const chatAi: AiChatBinding = {
    run: () => Promise.resolve({ response: REPLY, usage: { prompt_tokens: 50, completion_tokens: 12 } }),
  };
  return {
    db: db(),
    ai: fakeAi(),
    vectorize: captureVectorize().vectorize,
    sessions: SESSIONS,
    now: () => 1000,
    chat: new InferenceClient({ ai: chatAi }),
  };
}

describe("runTurn", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "agent-a");
  });

  it("retrieves memory, replies, persists the exchange, records usage", async () => {
    const d = turnDeps();
    await addMemoryService(d, T1, { namespace: "agent-a", text: "the sky is blue" });

    const res = await runTurn(d, T1, {
      sessionId: "s1",
      namespace: "agent-a",
      systemPrompt: "You are helpful.",
      message: "why is the sky blue?",
      chatProvider: "workers-ai",
    });

    expect(res.reply).toBe(REPLY);
    expect(res.usage).toMatchObject({ provider: "workers-ai", fresh: 62, cacheReported: false });
    expect(res.provenance.some((h) => h.text === "the sky is blue")).toBe(true);

    // exchange persisted to working memory
    const wm = await sessionStub(SESSIONS, "n1", "s1").getWorkingMemory();
    expect(wm.map((m) => m.content)).toStrictEqual(["why is the sky blue?", REPLY]);

    // usage recorded
    const usage = await db().listUsageEventsByTenant("t1");
    expect(usage.length).toBe(1);
    expect(usage[0]?.tokens_fresh).toBe(62);
  });

  it("buildChatMessages keeps memory out of the system prompt; Context Block is the trailing message (P0 #1)", async () => {
    const d = turnDeps();
    await addMemoryService(d, T1, { namespace: "agent-a", text: "MEMORY-MARKER" });
    const assembled = await assembleTurn(d, T1, { sessionId: "s9", namespace: "agent-a", systemPrompt: "SYS-PROMPT", message: "q" });

    const messages = buildChatMessages(assembled, "SYS-PROMPT", "q");
    expect(messages[0]).toStrictEqual({ role: "system", content: "SYS-PROMPT" });
    expect(messages[0]?.content).not.toContain("MEMORY-MARKER");
    const last = messages[messages.length - 1];
    expect(last?.content).toContain("MEMORY-MARKER");
    expect(last?.content).toContain("<retrieved-memory>");
  });
});
