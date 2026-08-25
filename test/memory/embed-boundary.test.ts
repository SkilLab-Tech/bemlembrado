import { describe, expect, it } from "vitest";
import { type AiLike, assertEmbedDims, EMBED_DIMS, EmbedError, embed } from "../../src/memory/embed";

function aiReturning(dims: number): AiLike {
  return { run: () => Promise.resolve({ data: [Array.from({ length: dims }, () => 0.1)] }) };
}

describe("embed — boundaries", () => {
  it("rejects whitespace-only text", async () => {
    await expect(embed(aiReturning(8), "   \n\t ")).rejects.toBeInstanceOf(EmbedError);
  });

  it("accepts an embedding at exactly the 1536-dim cap", async () => {
    expect(await embed(aiReturning(1536), "x")).toHaveLength(1536);
  });

  it("accepts the bge-m3 native 1024-dim vector", async () => {
    expect(await embed(aiReturning(1024), "x")).toHaveLength(1024);
  });

  it("accepts a single-character input", async () => {
    expect(await embed(aiReturning(4), "a")).toHaveLength(4);
  });

  it("assertEmbedDims accepts the 1024-dim vector and rejects a mismatch (live 1024-vs-1536 trap)", () => {
    expect(EMBED_DIMS).toBe(1024);
    expect(() => { assertEmbedDims(Array.from({ length: 1024 }, () => 0.1)); }).not.toThrow();
    expect(() => { assertEmbedDims(Array.from({ length: 1536 }, () => 0.1)); }).toThrow(EmbedError);
  });

  it("passes long input through to the model unchanged", async () => {
    let received = "";
    const ai: AiLike = {
      run: (_model, inputs) => {
        received = Array.isArray(inputs.text) ? inputs.text.join("") : inputs.text;
        return Promise.resolve({ data: [[0.1]] });
      },
    };
    const long = "lorem ".repeat(5000);
    await embed(ai, long);
    expect(received).toBe(long);
  });
});
