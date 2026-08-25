import type { Db } from "../db/client";
import { hashApiKey } from "./api-key";
import { parseScopes, type Scope, serializeScopes } from "./scopes";

/**
 * Scoped access tokens — OAuth-style delegated auth. Issue a least-privilege
 * token for a tenant, persist only its hash (SHA-256 + pepper, same discipline as the
 * API key), and resolve it back to { tenantId, scopes } while enforcing expiry +
 * revocation. The full authorization-code redirect/consent flow layers on top of this
 * token model later; this is the storage + verification foundation.
 */

const TOKEN_PREFIX = "blt_";

export interface IssuedToken {
  id: string;
  /** The raw token — returned ONCE at issue time; only its hash is stored. */
  token: string;
  scopes: Scope[];
  expiresAt: number | null;
  /** LGPD device claim: may this token read confidential namespaces (mig 0020). */
  confidential: boolean;
}

export interface ResolvedToken {
  id: string;
  tenantId: string;
  scopes: Scope[];
  /** LGPD device claim from oauth_token.confidential (default false — the Desktop lock). */
  confidential: boolean;
}

/** A scoped token is `blt_` + 24 random bytes (base64url) — distinct prefix from the `bl_` API key. */
export function generateScopedToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  const b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${TOKEN_PREFIX}${b64}`;
}

/** True when a raw credential looks like a scoped token (vs the `bl_` API key). */
export function isScopedToken(raw: string): boolean {
  return raw.startsWith(TOKEN_PREFIX);
}

export interface IssueOptions {
  /** Seconds until expiry (omit for a non-expiring token). */
  ttlSeconds?: number;
  /** Explicit id (defaults to a uuid). */
  id?: string;
  /** LGPD claim. DEFAULT FALSE — the locked Desktop default. Monotonic: no update path (revoke + re-mint to change). */
  confidential?: boolean;
}

/** Issue + persist a scoped token for a tenant. Returns the raw token (only once). */
export async function issueScopedToken(
  db: Db,
  pepper: string,
  tenantId: string,
  scopes: readonly Scope[],
  now: number,
  opts: IssueOptions = {},
): Promise<IssuedToken> {
  const token = generateScopedToken();
  const tokenHash = await hashApiKey(token, pepper);
  const id = opts.id ?? crypto.randomUUID();
  const expiresAt = opts.ttlSeconds !== undefined ? now + opts.ttlSeconds * 1000 : null;
  await db.insertOauthToken({
    id,
    tenant_id: tenantId,
    token_hash: tokenHash,
    scopes: serializeScopes([...scopes]),
    created_at: now,
    expires_at: expiresAt,
    revoked_at: null,
    confidential: opts.confidential === true ? 1 : 0,
  });
  return { id, token, scopes: [...scopes], expiresAt, confidential: opts.confidential === true };
}

/**
 * Resolve a raw scoped token to its tenant + scopes, or null when it is unknown,
 * revoked, or expired. Constant work regardless of outcome beyond the hash lookup.
 */
export async function resolveScopedToken(db: Db, pepper: string, rawToken: string, now: number): Promise<ResolvedToken | null> {
  const tokenHash = await hashApiKey(rawToken, pepper);
  const row = await db.getOauthTokenByHash(tokenHash);
  if (row === null) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at <= now) return null;
  return { id: row.id, tenantId: row.tenant_id, scopes: parseScopes(row.scopes), confidential: (row.confidential ?? 0) === 1 };
}

/** Revoke a token by id, tenant-scoped. Returns true when a live token was revoked. */
export async function revokeScopedToken(db: Db, tenantId: string, id: string, now: number): Promise<boolean> {
  return (await db.revokeOauthToken(tenantId, id, now)) > 0;
}
