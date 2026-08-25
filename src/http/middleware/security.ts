import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app";

/**
 * OWASP baseline headers on every response (including error envelopes). Set
 * before next() so they survive both normal and onError-rendered responses.
 * CSP is restrictive (default-src 'none') — this is a JSON API, not a web app;
 * a future web console (V2) would relax it.
 */
export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  await next();
});

/** Explicit CORS policy for the REST + MCP-over-HTTP surfaces. */
export const corsPolicy = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type", "x-api-key"],
  maxAge: 86_400,
});
