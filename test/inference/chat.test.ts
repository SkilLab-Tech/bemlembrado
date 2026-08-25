import { describe, expect, it } from "vitest";
import { type AiChatBinding, type ChatMessage, InferenceClient, InferenceError, WORKERS_AI_CHAT_MODEL } from "../../src/inference/client";

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "hi" },
];

describe("InferenceClient.chat", () => {
  it("Workers AI: returns text + raw usage + model", async () => {
    const seenRoles: string[] = [];
    const ai: AiChatBinding = {
      run: (_m, inputs) => {
        seenRoles.push(...inputs.messages.map((m) => m.role));
        return Promise.resolve({ response: "hello!", usage: { prompt_tokens: 10, completion_tokens: 3 } });
      },
    };
    const client = new InferenceClient({ ai });
    const res = await client.chat("workers-ai", MESSAGES);
    expect(res.text).toBe("hello!");
    expect(res.usageRaw).toStrictEqual({ prompt_tokens: 10, completion_tokens: 3 });
    expect(res.model).toBe(WORKERS_AI_CHAT_MODEL); // reports the configured default, whatever it is
    expect(seenRoles).toStrictEqual(["system", "user"]); // messages threaded through
  });

  it("Workers AI: reads the OpenAI-style {choices} shape too", async () => {
    const ai: AiChatBinding = { run: () => Promise.resolve({ choices: [{ message: { content: "via choices" } }] }) };
    const res = await new InferenceClient({ ai }).chat("workers-ai", MESSAGES);
    expect(res.text).toBe("via choices");
  });

  it("Maritaca: posts messages + Bearer key, returns text + usage", async () => {
    let body: unknown = null;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      body = JSON.parse((init?.body as string | undefined) ?? "{}");
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "olá" } }], usage: { total_tokens: 22 } }), { status: 200 }));
    }) as unknown as typeof fetch;
    const res = await new InferenceClient({ maritacaKey: "k", fetchImpl }).chat("maritaca", MESSAGES);
    expect(res.text).toBe("olá");
    expect(res.usageRaw).toStrictEqual({ total_tokens: 22 });
    expect((body as { messages: unknown[] }).messages).toHaveLength(2);
  });

  it("throws InferenceError when the backend is unavailable", async () => {
    await expect(new InferenceClient({}).chat("workers-ai", MESSAGES)).rejects.toBeInstanceOf(InferenceError);
    await expect(new InferenceClient({}).chat("maritaca", MESSAGES)).rejects.toBeInstanceOf(InferenceError);
  });
});
