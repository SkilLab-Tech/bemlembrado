import { describe, expect, it } from "vitest";
import { PROVIDERS, type Provider, placementFor } from "../../src/inference/providers";

describe("provider-capability map", () => {
  it("declares the three ICP providers with correct cache traits", () => {
    expect(PROVIDERS.anthropic.supportsCacheControl).toBe(true);
    expect(PROVIDERS.anthropic.supportsMidConvSystem).toBe(true);
    expect(PROVIDERS["workers-ai"].implicitPrefixCache).toBe(true);
    expect(PROVIDERS["workers-ai"].supportsCacheControl).toBe(false);
    expect(PROVIDERS.maritaca.supportsMidConvSystem).toBe(false);
  });

  it("placementFor never returns a system placement", () => {
    const providers: Provider[] = ["anthropic", "workers-ai", "maritaca"];
    for (const p of providers) {
      expect(["tool_result", "mid_conv_system"]).toContain(placementFor(p));
      expect(["tool_result", "mid_conv_system"]).toContain(placementFor(p, { allowMidConvSystem: true }));
    }
  });

  it("mid_conv_system only for Anthropic + opt-in; everyone else tool_result", () => {
    expect(placementFor("anthropic", { allowMidConvSystem: true })).toBe("mid_conv_system");
    expect(placementFor("anthropic")).toBe("tool_result"); // no opt-in
    expect(placementFor("workers-ai", { allowMidConvSystem: true })).toBe("tool_result"); // unsupported
    expect(placementFor("maritaca", { allowMidConvSystem: true })).toBe("tool_result");
  });
});
