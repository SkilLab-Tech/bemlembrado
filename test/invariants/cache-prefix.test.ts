import { describe, expect, it } from "vitest";
import { buildRequest, type TurnInput } from "../../src/context/contract";

/**
 * P0 invariant #1 — cache-prefix byte-identity.
 * GREEN since F3 (#60–#62) implemented buildRequest; gated via the repo variable
 * P0_CACHE_PREFIX=required.
 */
describe("P0 invariant #1 — cache-prefix byte-identity", () => {
  it("static prefix is byte-identical across turns and the Context Block never enters the system prompt", () => {
    const base: TurnInput = {
      systemPrompt: "You are an assistant.",
      history: ["user: hi", "assistant: hello"],
      latestUser: "what did I say earlier?",
      memories: ["the user prefers PIX"],
    };

    const turn1 = buildRequest(base);
    // Same conversation, different retrieved memories on the next turn:
    const turn2 = buildRequest({
      ...base,
      memories: ["the user prefers PIX", "the user is in Brazil"],
    });

    // Swapping the Context Block must NOT mutate the cached static prefix.
    expect(turn2.staticPrefix).toBe(turn1.staticPrefix);
    // Retrieved/untrusted content must never land in the system prompt / prefix.
    expect(turn1.staticPrefix).not.toContain("PIX");
    expect(["tool_result", "mid_conv_system"]).toContain(turn1.placement);
  });
});
