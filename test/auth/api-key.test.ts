import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, verifyApiKey } from "../../src/auth/api-key";

const PEPPER = "test-pepper";

describe("api-key", () => {
  it("hashes deterministically", async () => {
    expect(await hashApiKey("bl_abc", PEPPER)).toBe(await hashApiKey("bl_abc", PEPPER));
  });

  it("produces a different hash for a different pepper", async () => {
    expect(await hashApiKey("bl_abc", PEPPER)).not.toBe(await hashApiKey("bl_abc", "other"));
  });

  it("emits a 64-char lowercase hex hash", async () => {
    const hash = await hashApiKey("bl_abc", PEPPER);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies a correct key", async () => {
    const raw = generateApiKey();
    const stored = await hashApiKey(raw, PEPPER);
    expect(await verifyApiKey(raw, stored, PEPPER)).toBe(true);
  });

  it("rejects a wrong key", async () => {
    const stored = await hashApiKey(generateApiKey(), PEPPER);
    expect(await verifyApiKey(generateApiKey(), stored, PEPPER)).toBe(false);
  });

  it("rejects a correct key under the wrong pepper", async () => {
    const raw = generateApiKey();
    const stored = await hashApiKey(raw, PEPPER);
    expect(await verifyApiKey(raw, stored, "wrong-pepper")).toBe(false);
  });

  it("generates prefixed, unique keys", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.startsWith("bl_")).toBe(true);
    expect(a.length).toBeGreaterThan(20);
    expect(a).not.toBe(b);
  });
});
