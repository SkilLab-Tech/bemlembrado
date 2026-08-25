import { describe, expect, it } from "vitest";
import { MAX_WORKING_MESSAGES, type SessionDO } from "../../src/session/session-do";
import { testEnv } from "../helpers/env";

/** Typed view of the DO namespace so RPC methods are callable on the stub. */
const SESSION = testEnv.SESSION as unknown as DurableObjectNamespace<SessionDO>;

function session(name: string): DurableObjectStub<SessionDO> {
  return SESSION.get(SESSION.idFromName(name));
}

describe("SessionDO working memory", () => {
  it("appends and reads back in order", async () => {
    const s = session("s1");
    await s.append({ role: "user", content: "hi", ts: 1 });
    await s.append({ role: "assistant", content: "hello", ts: 2 });
    const mem = await s.getWorkingMemory();
    expect(mem.map((m) => m.content)).toStrictEqual(["hi", "hello"]);
  });

  it("is isolated per session id", async () => {
    await session("a").append({ role: "user", content: "in-a", ts: 1 });
    expect(await session("b").getWorkingMemory()).toStrictEqual([]);
  });

  it("bounds the ring to the most recent MAX_WORKING_MESSAGES", async () => {
    const s = session("ring");
    for (let i = 0; i < MAX_WORKING_MESSAGES + 10; i++) {
      await s.append({ role: "user", content: String(i), ts: i });
    }
    const mem = await s.getWorkingMemory();
    expect(mem.length).toBe(MAX_WORKING_MESSAGES);
    expect(mem[0]?.content).toBe("10"); // 0..9 dropped
    expect(mem.at(-1)?.content).toBe(String(MAX_WORKING_MESSAGES + 9));
  });

  it("clear empties working memory", async () => {
    const s = session("c");
    await s.append({ role: "user", content: "x", ts: 1 });
    expect(await s.size()).toBe(1);
    await s.clear();
    expect(await s.getWorkingMemory()).toStrictEqual([]);
  });
});
