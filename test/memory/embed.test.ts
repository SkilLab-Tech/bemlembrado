import { describe, expect, it, vi } from "vitest";
import { type AiLike, EMBED_MODEL, EmbedError, embed } from "../../src/memory/embed";

function fakeAi(data: number[][] = [[0.1, 0.2, 0.3]]): AiLike {
  return {
    run: () => Promise.resolve({ data }),
  };
}

describe("embed", () => {
  it("returns the embedding vector", async () => {
    expect(await embed(fakeAi([[0.5, 0.6]]), "hello")).toStrictEqual([0.5, 0.6]);
  });

  it("calls the bge-m3 model with the text", async () => {
    const run = vi.fn(() => Promise.resolve({ data: [[0.1]] }));
    await embed({ run }, "remember this");
    expect(run).toHaveBeenCalledWith(EMBED_MODEL, { text: "remember this" });
  });

  it("rejects empty text", async () => {
    await expect(embed(fakeAi(), "")).rejects.toBeInstanceOf(EmbedError);
  });

  it("rejects when no embedding is returned", async () => {
    await expect(embed(fakeAi([]), "x")).rejects.toBeInstanceOf(EmbedError);
  });

  it("rejects an over-dimensioned embedding", async () => {
    const huge = Array.from({ length: 1537 }, () => 0);
    await expect(embed(fakeAi([huge]), "x")).rejects.toBeInstanceOf(EmbedError);
  });
});
