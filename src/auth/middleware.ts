import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../http/app";
import { Db } from "../db/client";
import { Internal, Unauthorized } from "../http/errors";
import { createLogger } from "../obs/log";
import { hashApiKey } from "./api-key";
import { bearerChallenge } from "./oauth";
import { isScopedToken, resolveScopedToken } from "./scoped-token";
import { ALL_SCOPES } from "./scopes";

const DEV_TENANT = { id: "dev", plan: "open" } as const;

function extractKey(authHeader: string | undefined, apiKeyHeader: string | undefined): string | null {
  if (authHeader?.startsWith("Bearer ") === true) {
    return authHeader.slice("Bearer ".length);
  }
  if (apiKeyHeader !== undefined && apiKeyHeader.length > 0) {
    return apiKeyHeader;
  }
  return null;
}

/**
 * Resolves the tenant from `Authorization: Bearer <key>` (or `x-api-key`): hashes
 * the key and looks up TENANT.api_key_hash. On success sets `ctx.var.tenant`
 * (the ONLY source of tenant identity downstream — no handler re-parses the key);
 * missing/invalid -> 401. Mount on /v1 + /mcp, NEVER on /health.
 */
export const apiKeyAuth = createMiddleware<AppEnv>(async (c, next) => {
  // Authless dev mode: bypass auth with a synthetic tenant. FAIL-SAFE — ignored
  // entirely in staging/production regardless of the flag value.
  const environment = c.env.ENVIRONMENT ?? "dev";
  const isProdLike = environment === "staging" || environment === "production";
  if (c.env.DEV_AUTHLESS === "true" && !isProdLike) {
    createLogger().log("warn", "DEV_AUTHLESS active — bypassing API-key auth", { environment });
    c.set("tenant", { id: DEV_TENANT.id, plan: DEV_TENANT.plan });
    c.set("keyId", "dev");
    c.set("scopes", [...ALL_SCOPES]);
    c.set("credentialType", "apiKey"); // dev bypass stands in for the root credential
    c.set("confidentialAccess", true); // root-equivalent (prod-disabled at :32)
    await next();
    return;
  }

  const pepper = c.env.API_KEY_PEPPER;
  if (pepper === undefined || pepper.length === 0) {
    throw new Internal("auth is not configured");
  }

  // On the MCP endpoint a 401 must carry the OAuth discovery challenge so Claude's
  // connector UI can begin the authorization flow (RFC 9728 resource_metadata pointer).
  const unauthorized = (message: string): Unauthorized => {
    if (c.req.path === "/mcp" || c.req.path.startsWith("/mcp/")) {
      c.header("WWW-Authenticate", bearerChallenge(new URL(c.req.url).origin));
    }
    return new Unauthorized(message);
  };

  const raw = extractKey(c.req.header("authorization"), c.req.header("x-api-key"));
  if (raw === null) {
    throw unauthorized("missing api key");
  }

  const db = new Db(c.env.DB);

  // Scoped token (blt_): delegated, least-privilege. Resolves to a tenant + a SUBSET
  // of scopes; an unknown/expired/revoked token is a 401 (never silent full access).
  if (isScopedToken(raw)) {
    const resolved = await resolveScopedToken(db, pepper, raw, Date.now());
    if (resolved === null) {
      throw unauthorized("invalid token");
    }
    const tenant = await db.getTenantById(resolved.tenantId);
    if (tenant === null) {
      throw unauthorized("invalid token"); // tenant deleted out from under the token
    }
    c.set("tenant", { id: tenant.id, plan: tenant.plan });
    c.set("keyId", `tok:${resolved.id.slice(0, 8)}`);
    c.set("scopes", resolved.scopes);
    c.set("credentialType", "token"); // delegated — can NEVER pass requireFullAccess
    c.set("confidentialAccess", resolved.confidential); // the DEVICE claim; Desktop mints get false
    await next();
    return;
  }

  // API key (bl_ / other): full access.
  const hash = await hashApiKey(raw, pepper);
  const tenant = await db.getTenantByApiKeyHash(hash);
  if (tenant === null) {
    throw unauthorized("invalid api key");
  }

  c.set("tenant", { id: tenant.id, plan: tenant.plan });
  // Non-reversible key fingerprint (12 hex of the peppered hash) — distinguishes
  // keys in audit/logs without ever surfacing the key or the full hash.
  c.set("keyId", hash.slice(0, 12));
  c.set("scopes", [...ALL_SCOPES]);
  c.set("credentialType", "apiKey"); // the root tenant credential
  c.set("confidentialAccess", true); // the tenant root credential owns all of its own data
  await next();
});
