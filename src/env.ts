import { z } from "zod";
import type { SessionDO } from "./session/session-do";

/**
 * Worker environment: Cloudflare bindings + vars + secrets.
 *
 * `wrangler types` (worker-configuration.d.ts) is the source of truth for binding
 * shapes; this view adds the validated runtime config. VECTORIZE/AI are optional
 * because the test environment (wrangler env.test) omits them (no local sim).
 * Secrets arrive via Workers Secrets — never from wrangler.jsonc, never logged.
 */
export interface Env {
  // bindings
  DB: D1Database;
  KV: KVNamespace;
  SESSION: DurableObjectNamespace<SessionDO>;
  VECTORIZE?: VectorizeIndex;
  AI?: Ai;
  /** R2 vault — LLM-Wiki markdown notes (source of truth). Locally simulable (Miniflare). */
  VAULT?: R2Bucket;
  // vars
  ENVIRONMENT?: string;
  DEV_AUTHLESS?: string;
  CF_AIGATEWAY_ID?: string;
  RATE_LIMIT_ENABLED?: string;
  /** "true" enables post-turn LLM-Wiki curation (off by default; uses Workers AI). */
  CURATOR_ENABLED?: string;
  /** "true" enables the scheduled retention purge to actually delete (off = dry-run count only). */
  RETENTION_PURGE_ENABLED?: string;
  /** "true" enables write-time consolidation on add_memory (off = no fetch, no model call, no cost). */
  CONSOLIDATION_ENABLED?: string;
  /** Declared data-residency region for this deployment (global|br|sa|us|eu|apac; default global). */
  DATA_RESIDENCY?: string;
  /** "true" enables volume-abuse quotas on add_memory (off = no count query, no hot-path cost). */
  ABUSE_GUARDS_ENABLED?: string;
  /** "true" enforces per-plan entitlement caps (F6; off = no plan gating). Composes with abuse guards (most restrictive wins). */
  PLAN_GATING_ENABLED?: string;
  /** "true" makes the turn path use a tenant's stored BYOK provider key over the platform key (off = zero hot-path cost, unchanged behavior). */
  BYOK_ENABLED?: string;
  /** "true" persists redacted inference/turn failures to the KV failure corpus (off = no write). */
  FAILURE_CORPUS_ENABLED?: string;
  /** Override the per-namespace memory cap (positive int; default 50000). */
  MAX_MEMORIES_PER_NAMESPACE?: string;
  /** Override the per-tenant namespace cap (positive int; default 1000). */
  MAX_NAMESPACES_PER_TENANT?: string;
  /** Override the per-cycle default-inference turn cap (positive int; default 100000 = runaway backstop). */
  MAX_TURNS_PER_CYCLE?: string;
  /** Stripe Price id (price_...) per paid plan — created in the Stripe dashboard. Absence => that plan can't checkout via Stripe. */
  STRIPE_PRICE_STARTER?: string;
  STRIPE_PRICE_PRO?: string;
  // secrets
  API_KEY_PEPPER?: string;
  ANTHROPIC_API_KEY?: string;
  /** Maritaca (pt-BR specialist) chat key. Optional — absence falls back to Workers AI. */
  MARITACA_API_KEY?: string;
  CF_ACCOUNT_ID?: string;
  /** Stripe secret key (sk_...). Absence => Stripe checkout is not configured (cross-border rail; gated on the maintainer). */
  STRIPE_SECRET_KEY?: string;
  /** Stripe webhook signing secret (whsec_...). Absence => the Stripe webhook rejects all deliveries (not configured). */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Base64 32-byte KEK for managed BYOK secret sealing (AES-256-GCM). Absence => BYOK is not configured. */
  BYOK_KEK?: string;
}

export class BootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootError";
  }
}

export type Environment = "dev" | "test" | "staging" | "production";

export interface AppConfig {
  readonly environment: Environment;
  readonly devAuthless: boolean;
  readonly apiKeyPepper: string;
}

const REQUIRED_BINDINGS = ["DB", "KV", "SESSION"] as const;

const configSchema = z.object({
  API_KEY_PEPPER: z.string().min(1),
  ENVIRONMENT: z.enum(["dev", "test", "staging", "production"]).default("dev"),
  DEV_AUTHLESS: z.enum(["true", "false"]).optional(),
});

let cached: AppConfig | undefined;

/**
 * Validate the environment once (memoized per isolate) and fail closed with a
 * BootError if a required binding or secret is missing. Error messages carry
 * field NAMES only — never secret values.
 */
export function validateEnv(env: Env): AppConfig {
  if (cached) return cached;

  // A runtime presence check: the typed bindings are non-null in the type system,
  // but at boot they may genuinely be missing, so inspect via an untyped view.
  const bag = env as unknown as Record<string, unknown>;
  for (const binding of REQUIRED_BINDINGS) {
    if (bag[binding] == null) {
      throw new BootError(`Missing required binding: ${binding}`);
    }
  }

  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new BootError(`Invalid environment config: ${fields}`);
  }

  const environment = parsed.data.ENVIRONMENT;
  const isProdLike = environment === "staging" || environment === "production";
  cached = {
    environment,
    // Fail-safe: an accidentally-set DEV_AUTHLESS must never open the gate in prod.
    devAuthless: parsed.data.DEV_AUTHLESS === "true" && !isProdLike,
    apiKeyPepper: parsed.data.API_KEY_PEPPER,
  };
  return cached;
}

/** Test-only: reset the memoized config between cases. */
export function resetEnvCacheForTest(): void {
  cached = undefined;
}
