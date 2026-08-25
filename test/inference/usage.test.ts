import { describe, expect, it } from "vitest";
import { normalizeAnthropicUsage, normalizeOpenAiUsage, normalizeUsage } from "../../src/inference/usage";

describe("normalizeUsage", () => {
  it("Anthropic: splits fresh vs cache-read vs cache-write, marks cacheReported", () => {
    const u = normalizeAnthropicUsage(
      { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 2000, cache_read_input_tokens: 8000 },
      "claude-opus-4-8",
    );
    expect(u).toStrictEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
      fresh: 140,
      cacheRead: 8000,
      cacheWrite: 2000,
      cacheReported: true,
    });
  });

  it("OpenAI-style (Workers AI / Maritaca): no cache accounting -> honest zeros, cacheReported false", () => {
    const u = normalizeOpenAiUsage("workers-ai", { prompt_tokens: 50, completion_tokens: 20 }, "@cf/zai-org/glm-4.7-flash");
    expect(u.fresh).toBe(70);
    expect(u.cacheRead).toBe(0);
    expect(u.cacheWrite).toBe(0);
    expect(u.cacheReported).toBe(false);
  });

  it("falls back to total_tokens when prompt/completion are absent", () => {
    expect(normalizeOpenAiUsage("maritaca", { total_tokens: 99 }, null).fresh).toBe(99);
  });

  it("never throws on malformed/missing usage -> zeros", () => {
    expect(normalizeUsage("workers-ai", null, null).fresh).toBe(0);
    expect(normalizeUsage("workers-ai", { prompt_tokens: "nope" }, null).fresh).toBe(0);
    expect(normalizeAnthropicUsage(undefined, null).cacheRead).toBe(0);
    expect(normalizeAnthropicUsage({ cache_read_input_tokens: -5 }, null).cacheRead).toBe(0);
  });

  it("dispatch maps provider to the OpenAI-style normalizer", () => {
    expect(normalizeUsage("maritaca", { prompt_tokens: 1, completion_tokens: 1 }, "sabiazinho-3").provider).toBe("maritaca");
    expect(normalizeUsage("workers-ai", { prompt_tokens: 1 }, null).provider).toBe("workers-ai");
  });
});
