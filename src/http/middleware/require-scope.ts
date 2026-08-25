import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app";
import { hasAllScopes, type Scope } from "../../auth/scopes";
import { Forbidden, Internal } from "../errors";

/**
 * Scope enforcement. Mount AFTER apiKeyAuth (which sets `c.var.scopes`):
 * an API key carries ALL scopes, a scoped token only its granted subset. A request
 * missing any required scope is 403 forbidden. Fail-closed: if scopes were never set
 * (auth didn't run) it is a server misconfiguration → 500, never an open door.
 */
export function requireScope(...required: Scope[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const granted = c.var.scopes;
    if (granted === undefined) {
      throw new Internal("scope check ran before auth");
    }
    if (!hasAllScopes(granted, required)) {
      throw new Forbidden(`missing required scope: ${required.join(" ")}`);
    }
    await next();
  });
}

/**
 * Full-access gate for privileged, self-referential admin ops (token issuance/
 * revocation — F5 #116). Gated on CREDENTIAL TYPE, not scope-set equality: only the
 * tenant root API key qualifies. A delegated scoped token can NEVER mint/revoke
 * tokens — even one minted with every scope — closing the privilege-escalation path
 * (a token with all scopes is still not the root credential). Fail-closed: if the
 * type was never set (auth didn't run) it's a server misconfiguration → 500.
 */
export function requireFullAccess() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const credentialType = c.var.credentialType;
    if (credentialType === undefined) {
      throw new Internal("full-access check ran before auth");
    }
    if (credentialType !== "apiKey") {
      throw new Forbidden("token management requires the tenant API key, not a delegated token");
    }
    await next();
  });
}
