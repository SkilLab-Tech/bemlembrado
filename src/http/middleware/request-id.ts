import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app";

/**
 * Reads an inbound `x-request-id` (or mints a uuid), stores it on the context for
 * downstream handlers + the error envelope, and echoes it on the response. Mount
 * first in the global chain.
 */
export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id = incoming !== undefined && incoming.length > 0 ? incoming : crypto.randomUUID();
  c.set("requestId", id);
  await next();
  c.header("x-request-id", id);
});
