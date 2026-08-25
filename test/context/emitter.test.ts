import { describe, expect, it } from "vitest";
import { buildRequest, type TurnInput } from "../../src/context/contract";

const base: TurnInput = {
  systemPrompt: "You are an assistant.",
  history: ["user: hi", "assistant: hello"],
  latestUser: "what did I say earlier?",
  memories: ["the user prefers PIX"],
};

describe("buildRequest — cache-aware emitter", () => {
  it("static prefix is byte-identical across turns regardless of memories", () => {
    const t1 = buildRequest(base);
    const t2 = buildRequest({ ...base, memories: ["the user prefers PIX", "the user is in Brazil", "extra"] });
    const t3 = buildRequest({ ...base, memories: [] });
    expect(t2.staticPrefix).toBe(t1.staticPrefix);
    expect(t3.staticPrefix).toBe(t1.staticPrefix);
  });

  it("memories live in the post-breakpoint context block, never the prefix", () => {
    const r = buildRequest(base);
    expect(r.staticPrefix).not.toContain("PIX");
    expect(r.contextBlock).toContain("PIX");
    expect(r.contextBlock).toContain("<retrieved-memory>");
  });

  it("empty memories -> empty context block, prefix unchanged", () => {
    expect(buildRequest({ ...base, memories: [] }).contextBlock).toBe("");
  });

  it("placement follows the provider-capability map", () => {
    expect(buildRequest(base).placement).toBe("tool_result"); // default anthropic, no opt-in
    expect(buildRequest(base, { provider: "anthropic", allowMidConvSystem: true }).placement).toBe("mid_conv_system");
    expect(buildRequest(base, { provider: "workers-ai", allowMidConvSystem: true }).placement).toBe("tool_result");
    expect(buildRequest(base, { provider: "maritaca" }).placement).toBe("tool_result");
  });

  it("a changed conversation DOES change the prefix (sanity: prefix tracks the real inputs)", () => {
    const r1 = buildRequest(base);
    const r2 = buildRequest({ ...base, latestUser: "different question" });
    expect(r2.staticPrefix).not.toBe(r1.staticPrefix);
  });
});
