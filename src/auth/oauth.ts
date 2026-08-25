/**
 * MCP OAuth 2.1 (FR-13). A thin authorization-code layer so Claude's "Add custom
 * connector" UI (Individual sign-in) can install bem-lembrado. It does NOT introduce a
 * second token system: the /oauth/token endpoint mints the SAME `blt_` scoped token as
 * POST /v1/tokens (via issueScopedToken), so the existing apiKeyAuth on /mcp resolves it
 * unchanged — OAuth is simply "another way to obtain a scoped token".
 *
 * Model (verified against the 2026-07-28 MCP auth spec + claude.com/docs):
 *  - Discovery: 401 on /mcp carries WWW-Authenticate -> /.well-known/oauth-protected-resource
 *    (RFC 9728) -> /.well-known/oauth-authorization-server (RFC 8414).
 *  - Registration: Dynamic Client Registration (RFC 7591), public clients (no secret), PKCE S256.
 *  - Consent/login: the resource owner proves tenant ownership by pasting their `bl_` API key
 *    (bem-lembrado is a headless API-key product — there is no web session to federate to).
 *  - resource (RFC 8707) is validated against this server's canonical /mcp URI.
 *  - Grants default to confidential:false (LGPD Desktop-lock) and exclude memory:delete.
 *  - Clients + authorization codes live in KV with a TTL (auto-prune; no migration, no client bloat).
 *  - No refresh token in v1: access tokens are long-lived (90d) and Claude re-auths on 401.
 */
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../http/app";
import { Db } from "../db/client";
import { Internal } from "../http/errors";
import { rateLimit } from "../http/middleware/rate-limit";
import { hashApiKey } from "./api-key";
import { issueScopedToken } from "./scoped-token";
import { ALL_SCOPES, parseScopes, type Scope, serializeScopes } from "./scopes";

/** Scopes an OAuth (Individual sign-in) grant may hold — memory:delete is withheld (least privilege). */
const OAUTH_GRANTABLE: readonly Scope[] = ["memory:read", "memory:write", "session:read"];
const ACCESS_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90d — no refresh token in v1; Claude re-auths on 401.
const CODE_TTL_SECONDS = 300; // single-use authorization code
const CLIENT_TTL_SECONDS = 90 * 24 * 60 * 60; // DCR client record; TTL auto-prunes per-connection bloat
const MCP_PATH = "/mcp";

const SCOPE_LABELS: Record<Scope, string> = {
  "memory:read": "Read your stored memories",
  "memory:write": "Store new memories",
  "memory:delete": "Delete your memories",
  "session:read": "Read session context",
};

function originOf(url: string): string {
  return new URL(url).origin;
}

/** RFC 9728 protected-resource metadata. `resource` MUST equal the MCP URL the user typed. */
export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [...ALL_SCOPES],
  };
}

/** RFC 8414 authorization-server metadata. DCR + public clients + PKCE S256. */
export function authServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: [...OAUTH_GRANTABLE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
}

/** The 401 challenge Claude reads to start discovery. */
export function bearerChallenge(origin: string): string {
  return `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE S256: BASE64URL(SHA256(code_verifier)) === code_challenge. */
export async function verifyPkceS256(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  if (codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return b64url(new Uint8Array(digest)) === codeChallenge;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** A redirect_uri may be registered only if it is https or an http loopback (RFC 8252). */
export function redirectUriRegistrable(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && isLoopback(u.hostname);
}

/** Match a requested redirect against a registered one — exact, except the port is ignored for loopback (RFC 8252 §7.3). */
export function redirectUriMatches(registered: string, requested: string): boolean {
  let r: URL;
  let q: URL;
  try {
    r = new URL(registered);
    q = new URL(requested);
  } catch {
    return false;
  }
  if (r.protocol === "http:" && isLoopback(r.hostname) && q.protocol === "http:" && isLoopback(q.hostname)) {
    return r.hostname === q.hostname && r.pathname === q.pathname;
  }
  return registered === requested;
}

/** Intersect requested scopes with the OAuth-grantable set; default to the full grantable set when none apply. */
export function capScopes(requested: readonly Scope[]): Scope[] {
  const capped = requested.filter((s) => OAUTH_GRANTABLE.includes(s));
  return capped.length > 0 ? capped : [...OAUTH_GRANTABLE];
}

const ClientZ = z.object({
  client_id: z.string(),
  redirect_uris: z.array(z.string()),
  client_name: z.string().optional(),
  created_at: z.number(),
});
type OAuthClient = z.infer<typeof ClientZ>;

const CodeZ = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string(),
  tenant_id: z.string(),
  scopes: z.string(),
  resource: z.string(),
  created_at: z.number(),
});
type AuthCode = z.infer<typeof CodeZ>;

async function getClient(kv: KVNamespace, id: string): Promise<OAuthClient | null> {
  const raw = await kv.get(`oauth:client:${id}`);
  if (raw === null) return null;
  const parsed = ClientZ.safeParse(JSON.parse(raw) as unknown);
  return parsed.success ? parsed.data : null;
}

async function takeCode(kv: KVNamespace, code: string): Promise<AuthCode | null> {
  const key = `oauth:code:${code}`;
  const raw = await kv.get(key);
  if (raw === null) return null;
  // single-use: consume on read so a replay finds nothing.
  // ponytail: KV get+delete is not atomic, so two simultaneous exchanges of one code could both
  // read it — benign here because PKCE binds redemption to the code_verifier the legit client holds;
  // move to a Durable Object if strict atomic single-use is ever required.
  await kv.delete(key);
  const parsed = CodeZ.safeParse(JSON.parse(raw) as unknown);
  return parsed.success ? parsed.data : null;
}

function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `${prefix}${b64url(bytes)}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The host a grant's token will be delivered to — shown on consent so a user can spot a phishing client. */
function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

interface ConsentParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  scope: string;
  resource: string;
}

function renderConsent(clientName: string, scopes: readonly Scope[], p: ConsentParams, error?: string): string {
  const hidden = (Object.keys(p) as (keyof ConsentParams)[])
    .map((k) => `<input type="hidden" name="${esc(k)}" value="${esc(p[k])}">`)
    .join("\n      ");
  const items = scopes.map((s) => `<li>${esc(SCOPE_LABELS[s])}</li>`).join("\n        ");
  const err = error !== undefined ? `<p class="err">${esc(error)}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Authorize · BemLembrado</title><style>
:root{color-scheme:dark}body{margin:0;background:#0b0e14;color:#e6edf3;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{width:min(92vw,420px);background:#11161f;border:1px solid #1e2733;border-radius:14px;padding:28px}
h1{font-size:19px;margin:0 0 4px}.sub{color:#8b98a9;font-size:14px;margin:0 0 18px}
ul{margin:0 0 18px;padding-left:20px}li{margin:2px 0}
label{display:block;font-size:13px;color:#8b98a9;margin:0 0 6px}
input[type=password]{width:100%;box-sizing:border-box;background:#0b0e14;border:1px solid #263140;border-radius:8px;color:#e6edf3;padding:11px;font:inherit}
.row{display:flex;gap:10px;margin-top:18px}button{flex:1;border:0;border-radius:8px;padding:12px;font:inherit;font-weight:600;cursor:pointer}
.approve{background:#0d9488;color:#fff}.deny{background:#1e2733;color:#e6edf3}
.err{background:#3a1720;border:1px solid #7d2a3b;color:#ffb3c0;border-radius:8px;padding:10px;font-size:14px;margin:0 0 14px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#5eead4;margin-right:7px;vertical-align:middle}
</style></head><body><form class="card" method="post" action="/oauth/authorize">
      <h1><span class="dot"></span>Authorize connection</h1>
      <p class="sub"><strong>${esc(clientName)}</strong> is requesting access to your BemLembrado memory:</p>
      ${err}
      <ul>
        ${items}
      </ul>
      <p class="sub">After you authorize, a connection token is delivered to <strong>${esc(hostOf(p.redirect_uri))}</strong>. Only continue if you recognize it.</p>
      <label for="k">Paste your BemLembrado API key (starts with <code>bl_</code>) to authorize</label>
      <input id="k" type="password" name="api_key" autocomplete="off" placeholder="bl_..." required>
      ${hidden}
      <div class="row">
        <button class="deny" type="submit" name="action" value="deny">Deny</button>
        <button class="approve" type="submit" name="action" value="approve">Authorize</button>
      </div>
</form></body></html>`;
}

function redirectBack(redirectUri: string, params: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Mount the OAuth 2.1 endpoints. All are PUBLIC (no apiKeyAuth) — call BEFORE the
 * apiKeyAuth mounts in createApp. Paths (/.well-known/*, /oauth/*) never collide with /v1 or /mcp.
 */
export function registerOAuth(app: Hono<AppEnv>): void {
  // --- Discovery (RFC 9728 / RFC 8414). The /mcp-suffixed protected-resource path is what Claude probes first. ---
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(originOf(c.req.url))));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResourceMetadata(originOf(c.req.url))));
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(authServerMetadata(originOf(c.req.url))));

  // --- Dynamic Client Registration (RFC 7591). Public client: no secret issued. ---
  const RegisterZ = z.object({
    redirect_uris: z.array(z.string()).min(1),
    client_name: z.string().max(200).optional(),
    token_endpoint_auth_method: z.string().optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
  });
  app.post("/oauth/register", rateLimit({ capacity: 20, refillPerSec: 0.1, routeClass: "oauth:register", keyBy: "ip" }), async (c) => {
    const parsed = RegisterZ.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_client_metadata", error_description: "redirect_uris is required" }, 400);
    }
    const uris = parsed.data.redirect_uris;
    if (!uris.every(redirectUriRegistrable)) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be https or http loopback" }, 400);
    }
    const client: OAuthClient = {
      client_id: randomToken("blc_"),
      redirect_uris: uris,
      created_at: Date.now(),
      ...(parsed.data.client_name !== undefined ? { client_name: parsed.data.client_name } : {}),
    };
    await c.env.KV.put(`oauth:client:${client.client_id}`, JSON.stringify(client), { expirationTtl: CLIENT_TTL_SECONDS });
    return c.json(
      {
        client_id: client.client_id,
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        ...(client.client_name !== undefined ? { client_name: client.client_name } : {}),
      },
      201,
    );
  });

  // --- Authorization endpoint: GET renders consent, POST records the decision. ---
  app.get("/oauth/authorize", async (c) => {
    const q = c.req.query();
    const origin = originOf(c.req.url);
    const client = await getClient(c.env.KV, q.client_id ?? "");
    // Pre-redirect_uri-validation errors MUST render, never redirect (open-redirect guard).
    if (client === null) return c.html(errorPage("Unknown or expired client. Reconnect from your app."), 400);
    const redirectUri = q.redirect_uri ?? "";
    if (!client.redirect_uris.some((r) => redirectUriMatches(r, redirectUri))) {
      return c.html(errorPage("The redirect target is not registered for this client."), 400);
    }
    const state = q.state ?? "";
    // Post-validation protocol errors redirect back with an OAuth error (RFC 6749 §4.1.2.1).
    if ((q.response_type ?? "") !== "code") return c.redirect(redirectBack(redirectUri, { error: "unsupported_response_type", state }), 302);
    if ((q.code_challenge_method ?? "") !== "S256" || (q.code_challenge ?? "").length === 0) {
      return c.redirect(redirectBack(redirectUri, { error: "invalid_request", error_description: "PKCE S256 required", state }), 302);
    }
    if ((q.resource ?? "") !== `${origin}${MCP_PATH}`) {
      return c.redirect(redirectBack(redirectUri, { error: "invalid_target", state }), 302);
    }
    const scopes = capScopes(parseScopes(q.scope ?? ""));
    const params: ConsentParams = {
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: q.code_challenge ?? "",
      code_challenge_method: "S256",
      state,
      scope: serializeScopes(scopes),
      resource: q.resource ?? "",
    };
    return c.html(renderConsent(client.client_name ?? "An application", scopes, params));
  });

  app.post("/oauth/authorize", async (c) => {
    const body = await c.req.parseBody();
    const f = (k: string): string => (typeof body[k] === "string" ? body[k] : "");
    const origin = originOf(c.req.url);
    const clientId = f("client_id");
    const redirectUri = f("redirect_uri");
    // Re-validate client + redirect against KV — hidden form fields are attacker-controllable.
    const client = await getClient(c.env.KV, clientId);
    if (!client?.redirect_uris.some((r) => redirectUriMatches(r, redirectUri))) {
      return c.html(errorPage("Invalid authorization request."), 400);
    }
    const state = f("state");
    const codeChallenge = f("code_challenge");
    const resource = f("resource");
    if (codeChallenge.length === 0 || resource !== `${origin}${MCP_PATH}`) {
      return c.redirect(redirectBack(redirectUri, { error: "invalid_request", state }), 302);
    }
    const scopes = capScopes(parseScopes(f("scope")));
    if (f("action") !== "approve") {
      return c.redirect(redirectBack(redirectUri, { error: "access_denied", state }), 302);
    }
    // Login = prove tenant ownership with the `bl_` API key. Invalid -> re-render consent (no code).
    const pepper = c.env.API_KEY_PEPPER;
    if (pepper === undefined || pepper.length === 0) throw new Internal("auth is not configured");
    const db = new Db(c.env.DB);
    const tenant = await db.getTenantByApiKeyHash(await hashApiKey(f("api_key"), pepper));
    if (tenant === null) {
      const params: ConsentParams = { client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge, code_challenge_method: "S256", state, scope: serializeScopes(scopes), resource };
      return c.html(renderConsent(client.client_name ?? "An application", scopes, params, "That API key was not recognized. Check it and try again."), 401);
    }
    const code = randomToken("blcode_");
    const record: AuthCode = { client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge, tenant_id: tenant.id, scopes: serializeScopes(scopes), resource, created_at: Date.now() };
    await c.env.KV.put(`oauth:code:${code}`, JSON.stringify(record), { expirationTtl: CODE_TTL_SECONDS });
    // iss (RFC 9207) — advertised in AS metadata, so it MUST be present on the redirect.
    return c.redirect(redirectBack(redirectUri, { code, state, iss: origin }), 302);
  });

  // --- Token endpoint (form-urlencoded in, JSON out). Mints a `blt_` scoped token. ---
  app.post("/oauth/token", async (c) => {
    c.header("Cache-Control", "no-store");
    const body = await c.req.parseBody();
    const f = (k: string): string => (typeof body[k] === "string" ? body[k] : "");
    const origin = originOf(c.req.url);
    if (f("grant_type") !== "authorization_code") {
      return c.json({ error: "unsupported_grant_type" }, 400);
    }
    const record = await takeCode(c.env.KV, f("code"));
    if (record === null) return c.json({ error: "invalid_grant", error_description: "unknown or used code" }, 400);
    if (record.created_at + CODE_TTL_SECONDS * 1000 <= Date.now()) return c.json({ error: "invalid_grant", error_description: "expired code" }, 400);
    if (record.client_id !== f("client_id")) return c.json({ error: "invalid_grant", error_description: "client mismatch" }, 400);
    if (record.redirect_uri !== f("redirect_uri")) return c.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    if (record.resource !== `${origin}${MCP_PATH}` || record.resource !== f("resource")) return c.json({ error: "invalid_target" }, 400);
    if (!(await verifyPkceS256(f("code_verifier"), record.code_challenge))) {
      return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    }
    const pepper = c.env.API_KEY_PEPPER;
    if (pepper === undefined || pepper.length === 0) throw new Internal("auth is not configured");
    const scopes = capScopes(parseScopes(record.scopes));
    const issued = await issueScopedToken(new Db(c.env.DB), pepper, record.tenant_id, scopes, Date.now(), {
      ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
      confidential: false,
    });
    return c.json({
      access_token: issued.token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: serializeScopes(issued.scopes),
    });
  });
}

function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Authorization error · BemLembrado</title>
<style>body{margin:0;background:#0b0e14;color:#e6edf3;font:16px/1.5 system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{width:min(92vw,420px);background:#11161f;border:1px solid #7d2a3b;border-radius:14px;padding:28px}h1{font-size:18px;margin:0 0 8px}p{color:#8b98a9;margin:0}</style></head>
<body><div class="card"><h1>Authorization error</h1><p>${esc(message)}</p></div></body></html>`;
}
