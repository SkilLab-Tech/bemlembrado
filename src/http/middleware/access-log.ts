import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app";
import { createLogger } from "../../obs/log";

/**
 * Structured access log (turn-batch). One line per request — method, path, status,
 * latency, request id, and the authed tenant + key fingerprint when present. Emitted
 * AFTER the handler so the status + tenant (set by auth) are known. Fields flow
 * through the redacting logger; key_id is a non-reversible fingerprint, not a secret.
 * Mount right after the request-id middleware.
 */
export const accessLog = createMiddleware<AppEnv>(async (c, next) => {
  const start = Date.now();
  await next();
  createLogger().log("info", "request", {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    duration_ms: Date.now() - start,
    request_id: c.var.requestId,
    tenant: c.var.tenant?.id,
    key_id: c.var.keyId,
  });
});
