import { describe, expect, it } from "vitest";
import { AeadError, openSecret, sealSecret } from "../../src/crypto/aead";

// A valid 32-byte base64 KEK (all-zero bytes is fine for a test vector).
const KEK = btoa(String.fromCharCode(...new Uint8Array(32)));
const OTHER_KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));

describe("AEAD (AES-256-GCM secret sealing, #145)", () => {
  it("round-trips a secret and uses a fresh IV each time", async () => {
    const s1 = await sealSecret(KEK, "sk-ant-secret-123");
    const s2 = await sealSecret(KEK, "sk-ant-secret-123");
    expect(s1.iv).not.toBe(s2.iv); // never reuse an IV with a key
    expect(s1.ciphertext).not.toBe(s2.ciphertext);
    expect(await openSecret(KEK, s1)).toBe("sk-ant-secret-123");
    expect(await openSecret(KEK, s2)).toBe("sk-ant-secret-123");
  });

  it("fails closed on the wrong key or a tampered ciphertext", async () => {
    const sealed = await sealSecret(KEK, "top-secret");
    await expect(openSecret(OTHER_KEK, sealed)).rejects.toBeInstanceOf(AeadError);
    const tampered = { ...sealed, ciphertext: btoa("garbage-not-the-real-ct") };
    await expect(openSecret(KEK, tampered)).rejects.toBeInstanceOf(AeadError);
  });

  it("rejects a KEK that is not 32 bytes", async () => {
    await expect(sealSecret(btoa("short"), "x")).rejects.toBeInstanceOf(AeadError);
  });
});
