import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "../../src/core/services";
import type { TurnDeps } from "../../src/core/run-turn";
import { ALL_SCOPES } from "../../src/auth/scopes";
import { type AiChatBinding, InferenceClient } from "../../src/inference/client";
import { buildMcpServer, type McpTurnOptions } from "../../src/mcp";
import { sessionStub } from "../../src/session/session-do";
import { captureVectorize, fakeAi } from "../helpers/fakes";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { appEnv } from "../helpers/env";

const SESSIONS = appEnv.SESSION;
const REPLY = "blue because of Rayleigh scattering";

interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

function turnOptions(): McpTurnOptions {
  const chatAi: AiChatBinding = { run: () => Promise.resolve({ response: REPLY, usage: { prompt_tokens: 30, completion_tokens: 9 } }) };
  const deps: TurnDeps = {
    db: db(),
    ai: fakeAi(),
    vectorize: captureVectorize().vectorize,
    sessions: SESSIONS,
    now: () => 1000,
    chat: new InferenceClient({ ai: chatAi }),
  };
  return { deps, resolveProvider: () => "workers-ai" };
}

async function clientFor(principal: Principal): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(ct), buildMcpServer({ db: db(), ai: fakeAi(), vectorize: captureVectorize().vectorize, sessions: SESSIONS, now: () => 1 }, principal, ALL_SCOPES, { turn: turnOptions() }).connect(st)]);
  return client;
}

describe("MCP remember_and_respond tool", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "agent-a");
  });

  it("is listed alongside the memory tools", async () => {
    const names = (await (await clientFor({ confidential: false, tenantId: "t1" })).listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["add_memory", "search_memory", "get_session_context", "remember_and_respond"]));
  });

  it("runs a full turn: replies + persists the exchange to working memory", async () => {
    const client = await clientFor({ confidential: false, tenantId: "t1" });
    const res = (await client.callTool({ name: "remember_and_respond", arguments: { sessionId: "s1", namespace: "agent-a", message: "why is the sky blue?" } })) as ToolResult;
    const payload = JSON.parse(res.content[0]?.text ?? "{}") as { reply: string; sessionId: string };
    expect(payload.reply).toBe(REPLY);

    const wm = await sessionStub(SESSIONS, "n1", "s1").getWorkingMemory();
    expect(wm.map((m) => m.content)).toStrictEqual(["why is the sky blue?", REPLY]);
  });

  it("validates input (missing message -> tool error)", async () => {
    const client = await clientFor({ confidential: false, tenantId: "t1" });
    const res = (await client.callTool({ name: "remember_and_respond", arguments: { sessionId: "s1", namespace: "agent-a" } })) as ToolResult;
    expect(res.isError).toBe(true);
  });
});
