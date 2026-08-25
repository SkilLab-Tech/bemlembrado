import { env as workerEnv } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import type { Env } from "../../src/env";

/**
 * Typed view of the pool's test env (wrangler env.test bindings + the injected
 * TEST_MIGRATIONS). `env` from cloudflare:workers is typed as the (empty here)
 * global Env, so we cast once through a single shared helper.
 */
export interface TestEnv {
  DB: D1Database;
  KV: KVNamespace;
  SESSION: DurableObjectNamespace;
  VAULT: R2Bucket;
  TEST_MIGRATIONS: D1Migration[];
}

export const testEnv = workerEnv as unknown as TestEnv;

/** The pool env typed as the app's Env, for passing into Hono `app.request(path, init, appEnv)`. */
export const appEnv = workerEnv as unknown as Env;
