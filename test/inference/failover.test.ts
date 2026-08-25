import { describe, expect, it } from "vitest";
import { type ChatTurn, chatTurnWithFallback, InferenceClient, InferenceError } from "../../src/inference/client";

const TURN: ChatTurn = { system: "S", history: [], user: "hi" };
const okAi = { run: () => Promise.resolve({ response: "from workers-ai", usage: { prompt_tokens: 3 } }) };

describe("chatTurnWithFallback", () => {
  it("falls back to Workers AI when the primary (maritaca, no key) is unavailable", async () => {
    const client = new InferenceClient({ ai: okAi }); // no maritacaKey -> maritaca throws
    const { result, provider } = await chatTurnWithFallback(client, "maritaca", TURN);
    expect(provider).toBe("workers-ai");
    expect(result.text).toBe("from workers-ai");
  });

  it("falls back to Workers AI when Anthropic (no key) is unavailable", async () => {
    const { provider } = await chatTurnWithFallback(new InferenceClient({ ai: okAi }), "anthropic", TURN);
    expect(provider).toBe("workers-ai");
  });

  it("does NOT loop: a Workers AI failure re-raises (no second attempt)", async () => {
    const client = new InferenceClient({}); // no ai binding -> workers-ai throws
    await expect(chatTurnWithFallback(client, "workers-ai", TURN)).rejects.toBeInstanceOf(InferenceError);
  });

  it("returns the primary provider when it succeeds (no fallback)", async () => {
    const { provider } = await chatTurnWithFallback(new InferenceClient({ ai: okAi }), "workers-ai", TURN);
    expect(provider).toBe("workers-ai");
  });
});
