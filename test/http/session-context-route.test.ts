import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { createApp } from "../../src/http/app";
import { appendMessage } from "../../src/session/append";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { appEnv } from "../helpers/env";

const SESSIONS = appEnv.SESSION;

// dev-authless (tenant "dev"); deliberately NO AI/VECTORIZE — proving a session
// read needs neither.
function devEnv(overrides: Partial<Env> = {}): Env {
  return { ...appEnv, DEV_AUTHLESS: "true", ENVIRONMENT: "dev", ...overrides };
}

interface ContextBody {
  sessionId: string;
  messages: { role: string; content: string }[];
  block: { text: string; placement: string };
}

async function getContext(sessionId: string, env: Env, query = ""): Promise<Response> {
  return createApp().request(`/v1/sessions/${sessionId}/context${query}`, {}, env);
}

describe("REST GET /v1/sessions/:id/context", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("dev");
    await seedNamespace("nd", "dev", "agent-a");
    await appendMessage({ db: db(), sessions: SESSIONS }, { sessionId: "s1", namespaceId: "nd", role: "user", content: "hi", ts: 1 });
    await appendMessage({ db: db(), sessions: SESSIONS }, { sessionId: "s1", namespaceId: "nd", role: "assistant", content: "hello", ts: 2 });
  });

  it("returns the owner's working memory; block placement is never 'system' (P0 #1)", async () => {
    const res = await getContext("s1", devEnv());
    expect(res.status).toBe(200);
    const raw: unknown = await res.json();
    const body = raw as ContextBody;
    expect(body.messages.map((m) => m.content)).toStrictEqual(["hi", "hello"]);
    expect(body.block.placement).toBe("tool_result");
    expect(body.block.text).toContain("[user] hi");
    expect(body.block.placement).not.toBe("system");
  });

  it("opts into mid_conv_system via query flag (Opus-4.8), never 'system'", async () => {
    const res = await getContext("s1", devEnv(), "?allowMidConvSystem=true");
    const raw: unknown = await res.json();
    expect((raw as ContextBody).block.placement).toBe("mid_conv_system");
  });

  it("unknown session id -> 404", async () => {
    expect((await getContext("nope", devEnv())).status).toBe(404);
  });

  it("cross-tenant session id -> 404 (uniform, no oracle)", async () => {
    await seedTenant("other");
    await seedNamespace("no", "other", "agent-a");
    await appendMessage({ db: db(), sessions: SESSIONS }, { sessionId: "s-other", namespaceId: "no", role: "user", content: "secret", ts: 1 });
    // "dev" asks for another tenant's session id -> same 404 as a nonexistent id.
    expect((await getContext("s-other", devEnv())).status).toBe(404);
  });

  it("401 without an API key (auth gates /v1/*)", async () => {
    expect((await getContext("s1", appEnv)).status).toBe(401);
  });
});
