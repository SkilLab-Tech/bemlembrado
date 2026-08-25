import { beforeEach, describe, expect, it } from "vitest";
import { BootError, type Env, resetEnvCacheForTest, validateEnv } from "../src/env";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as D1Database,
    KV: {} as unknown as KVNamespace,
    SESSION: {} as unknown as Env["SESSION"],
    API_KEY_PEPPER: "test-pepper",
    ENVIRONMENT: "test",
    ...overrides,
  };
}

describe("validateEnv", () => {
  beforeEach(() => {
    resetEnvCacheForTest();
  });

  it("returns a config for a valid environment", () => {
    const cfg = validateEnv(makeEnv());
    expect(cfg.environment).toBe("test");
    expect(cfg.apiKeyPepper).toBe("test-pepper");
  });

  it("throws BootError when API_KEY_PEPPER is missing", () => {
    const { API_KEY_PEPPER: _omitted, ...withoutPepper } = makeEnv();
    expect(() => validateEnv(withoutPepper as Env)).toThrow(BootError);
  });

  it("throws BootError when a required binding is missing", () => {
    const { DB: _omitted, ...withoutDb } = makeEnv();
    expect(() => validateEnv(withoutDb as Env)).toThrow(/Missing required binding: DB/);
  });

  it("enables devAuthless only outside prod-like envs", () => {
    expect(validateEnv(makeEnv({ ENVIRONMENT: "dev", DEV_AUTHLESS: "true" })).devAuthless).toBe(true);
  });

  it("fail-safe: DEV_AUTHLESS is ignored in production", () => {
    expect(
      validateEnv(makeEnv({ ENVIRONMENT: "production", DEV_AUTHLESS: "true" })).devAuthless,
    ).toBe(false);
  });

  it("never leaks secret values in error messages", () => {
    try {
      validateEnv(makeEnv({ API_KEY_PEPPER: "" }));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BootError);
      expect((err as BootError).message).not.toContain("test-pepper");
    }
  });
});
