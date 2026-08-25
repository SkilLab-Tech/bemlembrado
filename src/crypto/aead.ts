/**
 * Authenticated encryption for secrets at rest (AES-256-GCM via WebCrypto).
 *
 * Used for managed BYOK: a tenant's provider API key is encrypted with a KEK held
 * only in a Workers Secret (BYOK_KEK) and stored as ciphertext+iv in D1 — the plaintext
 * never lands in the database. GCM provides confidentiality AND integrity: decrypt throws
 * on any tampering (auth-tag mismatch), so a modified ciphertext fails closed.
 */

const IV_BYTES = 12; // 96-bit nonce, the GCM standard

export class AeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AeadError";
  }
}

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Import a base64 32-byte KEK as an AES-GCM key. Throws AeadError if the KEK is not 32 bytes. */
async function importKek(kekB64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = b64decode(kekB64);
  } catch {
    throw new AeadError("BYOK_KEK is not valid base64");
  }
  if (raw.byteLength !== 32) throw new AeadError("BYOK_KEK must be 32 bytes (base64) for AES-256-GCM");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export interface SealedSecret {
  /** base64 ciphertext (includes the GCM auth tag). */
  ciphertext: string;
  /** base64 12-byte nonce. */
  iv: string;
}

/** Encrypt a UTF-8 secret. Each call uses a fresh random IV (never reuse an IV with a key). */
export async function sealSecret(kekB64: string, plaintext: string): Promise<SealedSecret> {
  const key = await importKek(kekB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: b64encode(new Uint8Array(ct)), iv: b64encode(iv) };
}

/** Decrypt a sealed secret. Throws AeadError if the KEK is wrong or the ciphertext was tampered with. */
export async function openSecret(kekB64: string, sealed: SealedSecret): Promise<string> {
  const key = await importKek(kekB64);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(sealed.iv) }, key, b64decode(sealed.ciphertext));
    return new TextDecoder().decode(pt);
  } catch {
    throw new AeadError("decryption failed (wrong key or tampered ciphertext)");
  }
}
