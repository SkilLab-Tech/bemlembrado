import { describe, expect, it, vi } from "vitest";
import {
  type AiChatBinding,
  buildInferenceDeps,
  chatModel,
  completeWithFallback,
  InferenceClient,
  InferenceError,
  providerForLanguage,
  resolveChatProvider,
} from "../../src/inference/client";
import type { Env } from "../../src/env";

function fakeAiBinding(response: string) {
  const calls: { model: string; options: { gateway?: { id: string } } | undefined }[] = [];
  const ai: AiChatBinding = {
    run(model, _inputs, options) {
      calls.push({ model, options });
      return Promise.resolve({ response });
    },
  };
  return { ai, calls };
}

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe("providerForLanguage (ICP routing)", () => {
  it("routes pt-BR to Maritaca, everything else to Workers AI", () => {
    expect(providerForLanguage("pt-BR")).toBe("maritaca");
    expect(providerForLanguage("PT")).toBe("maritaca");
    expect(providerForLanguage("en-US")).toBe("workers-ai");
    expect(providerForLanguage("es-LATAM")).toBe("workers-ai");
  });
});

describe("InferenceClient — Workers AI", () => {
  it("returns the model response", async () => {
    const { ai } = fakeAiBinding("olá");
    expect(await new InferenceClient({ ai }).complete("workers-ai", "oi")).toBe("olá");
  });

  it("also parses the OpenAI-style {choices} shape (real llama-3.1 shape)", async () => {
    const ai: AiChatBinding = { run: () => Promise.resolve({ choices: [{ message: { content: "Brasília." } }] }) };
    expect(await new InferenceClient({ ai }).complete("workers-ai", "capital?")).toBe("Brasília.");
  });

  it("passes the AI Gateway id when configured", async () => {
    const { ai, calls } = fakeAiBinding("x");
    await new InferenceClient({ ai, gatewayId: "bemlembrado" }).complete("workers-ai", "p");
    expect(calls[0]?.options?.gateway?.id).toBe("bemlembrado");
  });

  it("throws when the binding is unavailable", async () => {
    await expect(new InferenceClient({}).complete("workers-ai", "p")).rejects.toBeInstanceOf(InferenceError);
  });
});

describe("InferenceClient — Maritaca", () => {
  it("parses the OpenAI-compatible response", async () => {
    const fetchImpl = fakeFetch(200, { choices: [{ message: { content: "resposta pt-BR" } }] });
    const out = await new InferenceClient({ maritacaKey: "k", fetchImpl }).complete("maritaca", "pergunta");
    expect(out).toBe("resposta pt-BR");
  });

  it("throws without a key", async () => {
    await expect(new InferenceClient({}).complete("maritaca", "p")).rejects.toBeInstanceOf(InferenceError);
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = fakeFetch(429, {});
    await expect(new InferenceClient({ maritacaKey: "k", fetchImpl }).complete("maritaca", "p")).rejects.toBeInstanceOf(InferenceError);
  });
});

describe("resolveChatProvider (key-aware routing)", () => {
  it("routes pt to Maritaca ONLY when a key is present", () => {
    expect(resolveChatProvider({ MARITACA_API_KEY: "k" }, "pt-BR")).toBe("maritaca");
    expect(resolveChatProvider({ MARITACA_API_KEY: "" }, "pt-BR")).toBe("workers-ai"); // no 500
    expect(resolveChatProvider({}, "pt-BR")).toBe("workers-ai");
    expect(resolveChatProvider({ MARITACA_API_KEY: "k" }, "en-US")).toBe("workers-ai");
  });
});

describe("buildInferenceDeps factory", () => {
  it("throws when Workers AI is unavailable (embeddings mandatory)", () => {
    expect(() => buildInferenceDeps({} as Env)).toThrow(InferenceError);
  });
  it("returns embed + chat seams from env.AI and passes the Maritaca key", async () => {
    const ai: AiChatBinding = { run: () => Promise.resolve({ response: "hi" }) };
    const env = { AI: ai, MARITACA_API_KEY: "k" } as unknown as Env;
    const bundle = buildInferenceDeps(env);
    expect(bundle.embedAi).toBeDefined();
    expect(await bundle.chat.complete("workers-ai", "p")).toBe("hi");
  });
});

describe("completeWithFallback", () => {
  it("falls back to Workers AI once when the primary provider errors", async () => {
    let calls = 0;
    const client = {
      complete: (provider: string) => {
        calls++;
        if (provider === "maritaca") return Promise.reject(new InferenceError("down"));
        return Promise.resolve("fallback-ok");
      },
    } as unknown as InferenceClient;
    expect(await completeWithFallback(client, "maritaca", "p")).toBe("fallback-ok");
    expect(calls).toBe(2);
  });
  it("does not fall back when the primary IS workers-ai (rethrows)", async () => {
    const client = { complete: () => Promise.reject(new InferenceError("down")) } as unknown as InferenceClient;
    await expect(completeWithFallback(client, "workers-ai", "p")).rejects.toBeInstanceOf(InferenceError);
  });
  it("no fallback on success", async () => {
    let calls = 0;
    const client = { complete: () => { calls++; return Promise.resolve("ok"); } } as unknown as InferenceClient;
    expect(await completeWithFallback(client, "maritaca", "p")).toBe("ok");
    expect(calls).toBe(1);
  });
});

describe("chatModel adapter", () => {
  it("wraps the client as a ChatLike/CouncilModel", async () => {
    const { ai } = fakeAiBinding("hi");
    const model = chatModel(new InferenceClient({ ai }), "workers-ai");
    expect(model.id).toBe("workers-ai");
    expect(await model.complete("p")).toBe("hi");
  });
});
