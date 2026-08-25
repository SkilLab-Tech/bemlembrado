import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/obs/log";

function capture() {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  return { logger, lines };
}

function parse(line: string | undefined): Record<string, unknown> {
  return JSON.parse(line ?? "{}") as Record<string, unknown>;
}

describe("logger", () => {
  it("emits valid JSON with level + message + fields", () => {
    const { logger, lines } = capture();
    logger.log("info", "hello", { route: "/health" });
    expect(lines).toHaveLength(1);
    const entry = parse(lines[0]);
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("hello");
    expect(entry.route).toBe("/health");
  });

  it("redacts top-level secret keys, keeps the rest", () => {
    const { logger, lines } = capture();
    logger.log("info", "auth", { api_key: "bl_secret", tenant_id: "t1" });
    const entry = parse(lines[0]);
    expect(entry.api_key).toBe("[redacted]");
    expect(entry.tenant_id).toBe("t1");
  });

  it("redacts nested secret keys recursively", () => {
    const { logger, lines } = capture();
    logger.log("warn", "x", { meta: { authorization: "Bearer abc", ok: 1 } });
    const entry = parse(lines[0]) as { meta: Record<string, unknown> };
    expect(entry.meta.authorization).toBe("[redacted]");
    expect(entry.meta.ok).toBe(1);
  });

  it("redacts pepper / cpf / email (PII)", () => {
    const { logger, lines } = capture();
    logger.log("info", "pii", { pepper: "p", cpf: "00000000000", email: "a@b.com" });
    const entry = parse(lines[0]);
    expect(entry.pepper).toBe("[redacted]");
    expect(entry.cpf).toBe("[redacted]");
    expect(entry.email).toBe("[redacted]");
  });

  it("never emits a raw secret value anywhere in the line", () => {
    const { logger, lines } = capture();
    logger.log("info", "x", { api_key: "TOPSECRET" });
    expect(lines[0]).not.toContain("TOPSECRET");
  });

  it("redacts new secret fields by suffix/substring (maritaca_api_key, *_token, x_api_key, Authorization)", () => {
    const { logger, lines } = capture();
    logger.log("info", "secrets", {
      MARITACA_API_KEY: "m",
      maritaca_api_key: "m2",
      x_api_key: "x",
      refresh_token: "r",
      Authorization: "Bearer z",
      cloudflare_api_token: "c",
    });
    const entry = parse(lines[0]);
    for (const k of ["MARITACA_API_KEY", "maritaca_api_key", "x_api_key", "refresh_token", "Authorization", "cloudflare_api_token"]) {
      expect(entry[k]).toBe("[redacted]");
    }
  });

  it("does NOT over-redact innocent fields containing 'key' as a substring", () => {
    const { logger, lines } = capture();
    logger.log("info", "x", { monkey: "ok", keyboard_layout: "abnt2", turkey: "bird" });
    const entry = parse(lines[0]);
    expect(entry.monkey).toBe("ok");
    expect(entry.keyboard_layout).toBe("abnt2");
    expect(entry.turkey).toBe("bird");
  });
});
