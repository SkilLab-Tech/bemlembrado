/**
 * API-key hashing + constant-time verification.
 *
 * Only the hash is ever persisted (TENANT.api_key_hash); the raw key is never
 * stored. Verification is constant-time (Workers' crypto.subtle.timingSafeEqual)
 * to avoid leaking the hash via timing. Pepper comes from a Workers Secret.
 */

const KEY_PREFIX = "bl_";

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256(pepper + ":" + rawKey) as lowercase hex (always 64 chars). */
export async function hashApiKey(rawKey: string, pepper: string): Promise<string> {
  const data = new TextEncoder().encode(`${pepper}:${rawKey}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

/** Issue a new opaque API key: `bl_` + 24 random bytes (base64url). */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  const b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${KEY_PREFIX}${b64}`;
}

/** Constant-time verification of a raw key against a stored hash. */
export async function verifyApiKey(rawKey: string, storedHash: string, pepper: string): Promise<boolean> {
  const computed = await hashApiKey(rawKey, pepper);
  const a = new TextEncoder().encode(computed);
  const b = new TextEncoder().encode(storedHash);
  // Length guard: timingSafeEqual throws on unequal lengths. Our hashes are always
  // 64 hex chars, so a length mismatch means a malformed stored hash -> reject.
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(a, b);
}
