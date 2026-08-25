import { beforeEach, describe, expect, it } from "vitest";
import { appendMessage } from "../../src/session/append";
import { type SessionDO, sessionStub } from "../../src/session/session-do";
import { db, resetDb, seedNamespace, seedTenant } from "../helpers/fixtures";
import { testEnv } from "../helpers/env";

const SESSIONS = testEnv.SESSION as unknown as DurableObjectNamespace<SessionDO>;

function deps() {
  return { db: db(), sessions: SESSIONS };
}
function workingMemory(namespaceId: string, sessionId: string) {
  return sessionStub(SESSIONS, namespaceId, sessionId).getWorkingMemory();
}

describe("appendMessage (DO + D1)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedTenant("t1");
    await seedNamespace("n1", "t1", "agent-a");
  });

  it("persists to D1 MESSAGE and mirrors into DO working memory", async () => {
    await appendMessage(deps(), { sessionId: "s1", namespaceId: "n1", role: "user", content: "hi", ts: 1, id: "m1" });
    await appendMessage(deps(), { sessionId: "s1", namespaceId: "n1", role: "assistant", content: "hello", ts: 2, id: "m2" });

    // D1 source of truth (also auto-created the session row)
    expect(await db().getSession("s1")).not.toBeNull();
    const rows = await db().listMessagesBySession("s1");
    expect(rows.map((r) => r.id)).toStrictEqual(["m1", "m2"]);
    // DO working memory mirror
    expect((await workingMemory("n1", "s1")).map((m) => m.content)).toStrictEqual(["hi", "hello"]);
  });

  it("N concurrent appends to the same session lose no writes (serialization gate)", async () => {
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendMessage(deps(), { sessionId: "race", namespaceId: "n1", role: "user", content: `m${String(i)}`, ts: i, id: `m${String(i)}` }),
      ),
    );
    // D1: all N rows present
    expect((await db().listMessagesBySession("race")).length).toBe(N);
    // DO working memory: all N appended, none lost to a read-modify-write race
    expect((await workingMemory("n1", "race")).length).toBe(N);
  });

  it("auto-generates a message id when none is given", async () => {
    const id = await appendMessage(deps(), { sessionId: "s2", namespaceId: "n1", role: "user", content: "x", ts: 1 });
    expect(id.length).toBeGreaterThan(0);
    expect((await db().listMessagesBySession("s2"))[0]?.id).toBe(id);
  });
});
