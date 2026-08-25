import { describe, expect, it } from "vitest";
import { hasAllScopes, hasScope, isScope, parseScopes, serializeScopes } from "../../src/auth/scopes";

describe("scopes", () => {
  it("recognizes known scopes only", () => {
    expect(isScope("memory:read")).toBe(true);
    expect(isScope("memory:nuke")).toBe(false);
  });

  it("parses a space-separated string, dropping unknown + duplicates", () => {
    expect(parseScopes("memory:read memory:read bogus memory:write")).toStrictEqual(["memory:read", "memory:write"]);
    expect(parseScopes("")).toStrictEqual([]);
  });

  it("round-trips through serialize", () => {
    const scopes = parseScopes("memory:read session:read");
    expect(parseScopes(serializeScopes(scopes))).toStrictEqual(scopes);
  });

  it("hasScope / hasAllScopes", () => {
    const granted = parseScopes("memory:read memory:write");
    expect(hasScope(granted, "memory:read")).toBe(true);
    expect(hasScope(granted, "memory:delete")).toBe(false);
    expect(hasAllScopes(granted, ["memory:read", "memory:write"])).toBe(true);
    expect(hasAllScopes(granted, ["memory:read", "memory:delete"])).toBe(false);
    expect(hasAllScopes(granted, [])).toBe(true);
  });
});
