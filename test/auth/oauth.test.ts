import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import { hashApiKey } from "../../src/auth/api-key";
import { authServerMetadata, capScopes, protectedResourceMetadata, redirectUriMatches, redirectUriRegistrable, verifyPkceS256 } from "../../src/auth/oauth";
import { db, resetDb } from "../helpers/fixtures";
import { appEnv } from "../helpers/env";

/**
 * MCP OAuth 2.1 (FR-13). Adversarial coverage of the hand-rolled authorization-code layer:
 * discovery metadata, the 401 challenge, DCR, PKCE S256, single-use codes, redirect/resource
 * validation, scope capping, and that a granted token is a real `blt_` credential on /mcp.
 */

const PEPPER = "test-pepper"; // appEnv.API_KEY_PEPPER
const ROOT = "bl_root_oauth";
const ORIGIN = "http://localhost"; // app.request's default request origin
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function s256(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let s = "";
  for (const b of new Uint8Array(d)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function form(params: Record<string, string>): RequestInit {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() };
}
function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
async function asObj(res: Response): Promise<Record<string, unknown>> {
  return await res.json();
}
async function register(redirectUris: string[] = [REDIRECT]): Promise<string> {
  const res = await createApp().request("/oauth/register", json({ redirect_uris: redirectUris, client_name: "Claude" }), appEnv);
  return String((await asObj(res)).client_id);
}
function authQuery(clientId: string, challenge: string, over: Record<string, string> = {}): Record<string, string> {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-xyz",
    scope: "memory:read memory:write session:read",
    resource: RESOURCE,
    ...over,
  };
}

describe("OAuth pure helpers", () => {
  it("PKCE S256 verifies a correct verifier and rejects a wrong one / bad length", async () => {
    const v = "x".repeat(64);
    expect(await verifyPkceS256(v, await s256(v))).toBe(true);
    expect(await verifyPkceS256("y".repeat(64), await s256(v))).toBe(false);
    expect(await verifyPkceS256("short", await s256("short"))).toBe(false); // < 43 chars rejected
  });

  it("only https or http-loopback redirect URIs are registrable", () => {
    expect(redirectUriRegistrable("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectUriRegistrable("http://localhost/callback")).toBe(true);
    expect(redirectUriRegistrable("http://127.0.0.1/callback")).toBe(true);
    expect(redirectUriRegistrable("http://evil.example/callback")).toBe(false); // non-loopback http rejected
    expect(redirectUriRegistrable("not a url")).toBe(false);
  });

  it("redirect match is exact for https, port-agnostic for loopback (RFC 8252)", () => {
    expect(redirectUriMatches("https://claude.ai/cb", "https://claude.ai/cb")).toBe(true);
    expect(redirectUriMatches("https://claude.ai/cb", "https://claude.ai/other")).toBe(false);
    expect(redirectUriMatches("http://localhost/callback", "http://localhost:3118/callback")).toBe(true); // port ignored
    expect(redirectUriMatches("http://localhost/callback", "http://localhost:3118/evil")).toBe(false); // path still matters
  });

  it("capScopes drops memory:delete and defaults when empty", () => {
    expect(capScopes(["memory:read", "memory:delete", "session:read"])).toEqual(["memory:read", "session:read"]);
    expect(capScopes([])).toEqual(["memory:read", "memory:write", "session:read"]);
  });
});

describe("OAuth discovery metadata", () => {
  it("protected-resource metadata pins the exact MCP resource + AS", () => {
    const m = protectedResourceMetadata(ORIGIN);
    expect(m.resource).toBe(RESOURCE);
    expect(m.authorization_servers).toEqual([ORIGIN]);
  });
  it("authorization-server metadata advertises DCR + public client + S256", () => {
    const m = authServerMetadata(ORIGIN);
    expect(m.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
  });
  it("serves both well-known paths (Claude probes the /mcp-suffixed one first)", async () => {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]) {
      const res = await createApp().request(p, {}, appEnv);
      expect(res.status).toBe(200);
    }
  });
});

describe("the /mcp 401 carries the discovery challenge", () => {
  it("an unauthenticated /mcp POST returns 401 with a resource_metadata pointer", async () => {
    const res = await createApp().request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, appEnv);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
  });
});

describe("Dynamic Client Registration", () => {
  it("registers a public client for valid redirect URIs", async () => {
    const res = await createApp().request("/oauth/register", json({ redirect_uris: [REDIRECT], client_name: "Claude" }), appEnv);
    expect(res.status).toBe(201);
    const b = await asObj(res);
    expect(String(b.client_id).startsWith("blc_")).toBe(true);
    expect(b.token_endpoint_auth_method).toBe("none");
  });
  it("rejects a non-loopback http redirect URI (open-redirect guard at registration)", async () => {
    const res = await createApp().request("/oauth/register", json({ redirect_uris: ["http://evil.example/cb"] }), appEnv);
    expect(res.status).toBe(400);
    expect((await asObj(res)).error).toBe("invalid_redirect_uri");
  });
});

describe("authorization-code flow (end to end + adversarial)", () => {
  beforeEach(async () => {
    await resetDb();
    await db().insertTenant({ id: "t1", name: "T1", plan: "pro", api_key_hash: await hashApiKey(ROOT, PEPPER), created_at: 1 });
  });

  it("HAPPY PATH: register → consent → approve → token → the blt_ token authenticates on /v1", async () => {
    const verifier = "v".repeat(64);
    const clientId = await register();
    const q = authQuery(clientId, await s256(verifier));

    const getRes = await createApp().request(`/oauth/authorize?${new URLSearchParams(q).toString()}`, {}, appEnv);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toContain("Authorize");

    const postRes = await createApp().request("/oauth/authorize", form({ ...q, api_key: ROOT, action: "approve" }), appEnv);
    expect(postRes.status).toBe(302);
    const loc = new URL(postRes.headers.get("location") ?? "");
    expect(loc.searchParams.get("state")).toBe("st-xyz");
    expect(loc.searchParams.get("iss")).toBe(ORIGIN);
    const code = loc.searchParams.get("code") ?? "";
    expect(code.length).toBeGreaterThan(0);

    const tokRes = await createApp().request("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE }), appEnv);
    expect(tokRes.status).toBe(200);
    const tok = await asObj(tokRes);
    expect(tok.token_type).toBe("Bearer");
    expect(String(tok.access_token).startsWith("blt_")).toBe(true);
    expect(tok.scope).toBe("memory:read memory:write session:read");

    const use = await createApp().request("/v1/usage", { headers: { authorization: `Bearer ${String(tok.access_token)}` } }, appEnv);
    expect(use.status).toBe(200); // the OAuth-issued token is a fully valid credential
  });

  async function codeFor(clientId: string, verifier: string, over: Record<string, string> = {}): Promise<string> {
    const q = authQuery(clientId, await s256(verifier), over);
    const res = await createApp().request("/oauth/authorize", form({ ...q, api_key: ROOT, action: "approve" }), appEnv);
    return new URL(res.headers.get("location") ?? "").searchParams.get("code") ?? "";
  }

  it("ADVERSARIAL: a wrong PKCE verifier is rejected at the token endpoint", async () => {
    const clientId = await register();
    const code = await codeFor(clientId, "v".repeat(64));
    const res = await createApp().request("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: "w".repeat(64), client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE }), appEnv);
    expect(res.status).toBe(400);
    expect((await asObj(res)).error).toBe("invalid_grant");
  });

  it("ADVERSARIAL: an authorization code is single-use (replay is rejected)", async () => {
    const clientId = await register();
    const verifier = "v".repeat(64);
    const code = await codeFor(clientId, verifier);
    const ok = await createApp().request("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE }), appEnv);
    expect(ok.status).toBe(200);
    const replay = await createApp().request("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE }), appEnv);
    expect(replay.status).toBe(400); // consumed on first exchange
  });

  it("ADVERSARIAL: a resource-indicator mismatch is rejected (audience binding)", async () => {
    const clientId = await register();
    const verifier = "v".repeat(64);
    const code = await codeFor(clientId, verifier);
    const res = await createApp().request("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: "https://someone-elses-server.example/mcp" }), appEnv);
    expect(res.status).toBe(400);
    expect((await asObj(res)).error).toBe("invalid_target");
  });

  it("ADVERSARIAL: a code issued to one client cannot be redeemed by another", async () => {
    const clientA = await register();
    const clientB = await register();
    const verifier = "v".repeat(64);
    const code = await codeFor(clientA, verifier);
    const res = await createApp().request("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientB, redirect_uri: REDIRECT, resource: RESOURCE }), appEnv);
    expect(res.status).toBe(400);
  });

  it("ADVERSARIAL: an unknown client / unregistered redirect renders an error, never redirects (open-redirect guard)", async () => {
    const unknown = await createApp().request(`/oauth/authorize?${new URLSearchParams(authQuery("blc_does_not_exist", "x".repeat(43))).toString()}`, {}, appEnv);
    expect(unknown.status).toBe(400); // rendered, not a 302 to an attacker URL

    const clientId = await register();
    const badRedirect = await createApp().request(`/oauth/authorize?${new URLSearchParams(authQuery(clientId, "x".repeat(43), { redirect_uri: "https://evil.example/cb" })).toString()}`, {}, appEnv);
    expect(badRedirect.status).toBe(400);
  });

  it("ADVERSARIAL: a wrong API key at consent yields no code (re-render, 401)", async () => {
    const clientId = await register();
    const q = authQuery(clientId, await s256("v".repeat(64)));
    const res = await createApp().request("/oauth/authorize", form({ ...q, api_key: "bl_wrong_key", action: "approve" }), appEnv);
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull(); // never issued a code
  });

  it("ADVERSARIAL: deny redirects back with access_denied and no code", async () => {
    const clientId = await register();
    const q = authQuery(clientId, await s256("v".repeat(64)));
    const res = await createApp().request("/oauth/authorize", form({ ...q, api_key: ROOT, action: "deny" }), appEnv);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("ADVERSARIAL: memory:delete cannot be obtained via OAuth (scope capping end to end)", async () => {
    const clientId = await register();
    const verifier = "v".repeat(64);
    const code = await codeFor(clientId, verifier, { scope: "memory:read memory:delete" });
    const res = await createApp().request("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE }), appEnv);
    const tok = await asObj(res);
    expect(String(tok.scope)).not.toContain("memory:delete");
    expect(String(tok.scope)).toContain("memory:read");
  });
});
