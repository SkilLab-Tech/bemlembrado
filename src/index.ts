/**
 * BemLembrado Worker entrypoint.
 *
 * Exports the Hono app (built by createApp) and the SessionDO Durable Object.
 * The DO class name is LOCKED to `SessionDO` (must match wrangler.jsonc, or the
 * Durable Object migration fails). SessionDO holds per-session working memory
 * (src/session/session-do.ts).
 */
import { Db } from "./db/client";
import type { Env } from "./env";
import { createApp } from "./http/app";
import { createLogger } from "./obs/log";
import { runRetentionSweep } from "./lgpd/retention";

export { SessionDO } from "./session/session-do";

/** The Hono app, also exported for tests (app.request) — the default export below
 * wraps it with the scheduled handler for the Workers runtime. */
export const app = createApp();

/**
 * Worker handlers: `fetch` (the Hono app) + `scheduled` (the retention cron, F5
 * #110–111). The cron is best-effort and flag-gated (dry-run unless
 * RETENTION_PURGE_ENABLED="true"); a failure is logged, never thrown, so it can't
 * wedge the schedule. Cron cadence is declared in wrangler.jsonc (triggers.crons).
 */
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      runRetentionSweep(env, new Db(env.DB), Date.now()).catch((err: unknown) => {
        createLogger().log("error", "retention_sweep_failed", { error: err instanceof Error ? err.message : "unknown error" });
      }),
    );
  },
} satisfies ExportedHandler<Env>;
