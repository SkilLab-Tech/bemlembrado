import { describe, expect, it } from "vitest";
import { type AiChatBinding, InferenceClient } from "../../src/inference/client";
import {
  consolidationPrompt,
  fallbackMerge,
  isValidConsolidation,
  summarizeConsolidation,
} from "../../src/council/summarize";

/** A Workers AI binding stub: returns a canned response, or throws to simulate a model error. */
function fakeAi(response: string | Error): AiChatBinding {
  return {
    run(_model, _inputs, _options) {
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve({ response });
    },
  };
}

const client = (response: string | Error): InferenceClient => new InferenceClient({ ai: fakeAi(response) });

describe("fallbackMerge", () => {
  it("concatenates both notes loss-free", () => {
    expect(fallbackMerge("Ana on pro-plan.", "Ana prefers email.")).toBe("Ana on pro-plan.\nAna prefers email.");
  });
  it("handles an empty side", () => {
    expect(fallbackMerge("", "only incoming")).toBe("only incoming");
    expect(fallbackMerge("only existing", "  ")).toBe("only existing");
  });
});

describe("isValidConsolidation", () => {
  it("accepts a note retaining both sides", () => {
    const body = "Ana is on the pro-plan and prefers email contact.";
    expect(isValidConsolidation(body, "Ana is on the pro-plan.", "Ana prefers email contact.")).toBe(true);
  });
  it("rejects a note that dropped the incoming fact", () => {
    const body = "Ana is on the pro-plan."; // 'email' fact gone
    expect(isValidConsolidation(body, "Ana is on the pro-plan.", "Ana prefers email contact.")).toBe(false);
  });
  it("rejects empty output", () => {
    expect(isValidConsolidation("   ", "existing facts here", "incoming facts here")).toBe(false);
  });
  it("rejects output over the size cap", () => {
    const body = "x".repeat(50);
    expect(isValidConsolidation(body, "existing here", "incoming here", 10)).toBe(false);
  });
});

describe("consolidationPrompt", () => {
  it("includes the topic and both notes", () => {
    const p = consolidationPrompt({ topic: "ana", existing: "on pro-plan", incoming: "prefers email" });
    expect(p).toContain("ana");
    expect(p).toContain("on pro-plan");
    expect(p).toContain("prefers email");
    expect(p.toLowerCase()).toContain("prefer the new value");
  });
});

describe("summarizeConsolidation", () => {
  const input = { topic: "ana", existing: "Ana is on the pro-plan.", incoming: "Ana prefers email contact." };

  it("returns the guarded model output when it retains both sides", async () => {
    const merged = "Ana is on the pro-plan and prefers email contact.";
    const res = await summarizeConsolidation({ client: client(merged) }, input);
    expect(res.valid).toBe(true);
    expect(res.body).toBe(merged);
  });

  it("falls back to a loss-free merge when the model drops a fact", async () => {
    const res = await summarizeConsolidation({ client: client("Ana is on the pro-plan.") }, input);
    expect(res.valid).toBe(false);
    expect(res.body).toBe(fallbackMerge(input.existing, input.incoming));
  });

  it("falls back when the model call throws", async () => {
    const res = await summarizeConsolidation({ client: client(new Error("model down")) }, input);
    expect(res.valid).toBe(false);
    expect(res.body).toBe(fallbackMerge(input.existing, input.incoming));
  });
});
