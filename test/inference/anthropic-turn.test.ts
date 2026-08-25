import { describe, expect, it } from "vitest";
import { type ChatTurn, InferenceClient, InferenceError } from "../../src/inference/client";
import { normalizeUsage } from "../../src/inference/usage";

interface AnthropicBody {
  system: string;
  messages: { role: string; content: string | { type: string; text: string; cache_control?: unknown }[] }[];
}

function captureFetch(response: unknown): { fetchImpl: typeof fetch; body: () => AnthropicBody; headers: () => Record<string, string> } {
  let captured: AnthropicBody | null = null;
  let hdrs: Record<string, string> = {};
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    captured = JSON.parse((init?.body as string | undefined) ?? "{}") as AnthropicBody;
    hdrs = (init?.headers ?? {}) as Record<string, string>;
    return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
  }) as unknown as typeof fetch;
  return { fetchImpl, body: () => captured as unknown as AnthropicBody, headers: () => hdrs };
}

const TURN: ChatTurn = {
  system: "You are helpful.",
  history: [
    { role: "user", content: "earlier q" },
    { role: "assistant", content: "earlier a" },
  ],
  user: "why is the sky blue?",
  context: "<retrieved-memory>\nthe sky is blue\n</retrieved-memory>",
};

describe("anthropic cache-aware turn", () => {
  it("puts cache_control on the user block and leaves the Context Block AFTER it uncached (P0 #1)", async () => {
    const cap = captureFetch({ content: [{ type: "text", text: "Rayleigh scattering." }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4000 } });
    const client = new InferenceClient({ anthropicKey: "sk-test", fetchImpl: cap.fetchImpl });
    const res = await client.chatTurn("anthropic", TURN);

    expect(res.text).toBe("Rayleigh scattering.");
    const body = cap.body();
    // system is the trusted prompt only — never the retrieved memory.
    expect(body.system).toBe("You are helpful.");
    expect(JSON.stringify(body.system)).not.toContain("the sky is blue");

    // history preserved + a single final user message with two blocks.
    const finalMsg = body.messages[body.messages.length - 1];
    expect(finalMsg?.role).toBe("user");
    const blocks = finalMsg?.content as { text: string; cache_control?: unknown }[];
    expect(blocks[0]?.text).toBe("why is the sky blue?");
    expect(blocks[0]?.cache_control).toStrictEqual({ type: "ephemeral" }); // breakpoint on the question
    expect(blocks[1]?.text).toContain("the sky is blue"); // context AFTER
    expect(blocks[1]?.cache_control).toBeUndefined(); // ...and NOT cached -> swappable

    // auth header carries the key, not echoed elsewhere.
    expect(cap.headers()["x-api-key"]).toBe("sk-test");
  });

  it("normalizes Anthropic usage -> cache-read counted, cacheReported true", () => {
    const u = normalizeUsage("anthropic", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100 }, "claude-haiku-4-5-20251001");
    expect(u).toMatchObject({ provider: "anthropic", fresh: 15, cacheRead: 4000, cacheWrite: 100, cacheReported: true });
  });

  it("throws InferenceError without a key", async () => {
    await expect(new InferenceClient({}).chatTurn("anthropic", TURN)).rejects.toBeInstanceOf(InferenceError);
  });

  it("workers-ai chatTurn merges the Context Block into the final user message (no consecutive-user; no system leak)", async () => {
    const seen: { role: string; content: string }[] = [];
    const ai = { run: (_m: string, inputs: { messages: { role: string; content: string }[] }) => { seen.push(...inputs.messages); return Promise.resolve({ response: "ok" }); } };
    await new InferenceClient({ ai }).chatTurn("workers-ai", TURN);

    // system is the trusted prompt only — retrieved memory never leaks into it.
    expect(seen[0]).toStrictEqual({ role: "system", content: "You are helpful." });
    expect(seen[0]?.content).not.toContain("the sky is blue");

    // The final message is a SINGLE user turn carrying both the question and the
    // context — Llama/OpenAI templates reject consecutive same-role turns (live 500).
    const last = seen[seen.length - 1];
    expect(last?.role).toBe("user");
    expect(last?.content).toContain("why is the sky blue?");
    expect(last?.content).toContain("the sky is blue"); // context merged in, not a separate turn

    // No two adjacent messages share a role (the actual regression: consecutive users).
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]?.role).not.toBe(seen[i - 1]?.role);
    }
  });
});
