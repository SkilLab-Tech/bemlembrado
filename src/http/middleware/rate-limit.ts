import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app";
import { KvStore } from "../../db/kv";
import { RateLimited } from "../errors";

export interface RateLimitOptions {
  /** Max tokens in the bucket. */
  capacity: number;
  /** Tokens replenished per second. */
  refillPerSec: number;
  /** Bucket discriminator (route class), part of the KV key. */
  routeClass: string;
  /**
   * What to key the bucket on. "tenant" (default) is the authenticated tenant — skipped
   * on unauthenticated paths (auth owns rejection). "ip" keys on the client IP, for
   * PUBLIC endpoints where there is no tenant (e.g. the Founding pre-sale form).
   */
  keyBy?: "tenant" | "ip";
}

export interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface TokenDecision {
  allowed: boolean;
  bucket: Bucket;
  retryAfterSec: number;
}

/** Pure token-bucket step: refill by elapsed time, then try to consume one token. */
export function consumeToken(state: Bucket, opts: RateLimitOptions, now: number): TokenDecision {
  const elapsedSec = Math.max(0, (now - state.updatedAt) / 1000);
  const tokens = Math.min(opts.capacity, state.tokens + elapsedSec * opts.refillPerSec);
  if (tokens < 1) {
    const retryAfterSec = opts.refillPerSec > 0 ? Math.ceil((1 - tokens) / opts.refillPerSec) : 60;
    return { allowed: false, bucket: { tokens, updatedAt: now }, retryAfterSec };
  }
  return { allowed: true, bucket: { tokens: tokens - 1, updatedAt: now }, retryAfterSec: 0 };
}

function parseBucket(raw: string | null, capacity: number, now: number): Bucket {
  if (raw === null) {
    return { tokens: capacity, updatedAt: now };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Bucket>;
    return {
      tokens: typeof parsed.tokens === "number" ? parsed.tokens : capacity,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : now,
    };
  } catch {
    return { tokens: capacity, updatedAt: now };
  }
}

/**
 * Per-tenant token-bucket limiter on KV. BEST-EFFORT only — KV is eventually
 * consistent, so this is NOT a hard quota (a precise limiter needs a Durable
 * Object; deferred). Mounted AFTER auth (needs ctx.var.tenant). Off unless
 * env.RATE_LIMIT_ENABLED === "true".
 */
export function rateLimit(opts: RateLimitOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.env.RATE_LIMIT_ENABLED !== "true") {
      await next();
      return;
    }
    const key = opts.keyBy === "ip" ? (c.req.header("cf-connecting-ip") ?? "unknown") : c.var.tenant?.id;
    if (key === undefined) {
      // Tenant-keyed on an unauthenticated path — auth owns rejection.
      await next();
      return;
    }

    const kv = new KvStore(c.env.KV);
    const now = Date.now();
    const state = parseBucket(await kv.get(key, ["rl", opts.routeClass]), opts.capacity, now);
    const decision = consumeToken(state, opts, now);

    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSec));
      throw new RateLimited("rate limit exceeded");
    }

    await kv.put(key, ["rl", opts.routeClass], JSON.stringify(decision.bucket), 3600);
    await next();
  });
}
