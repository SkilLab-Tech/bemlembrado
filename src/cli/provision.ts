/**
 * Self-host provisioner core (F5 #117-119). Pure, Web-API-only planning for
 * `npx bemlembrado init`: the ordered `wrangler` command plan to stand up a
 * BemLembrado instance on the operator's OWN Cloudflare account, plus the
 * wrangler.jsonc that wires the created resources.
 *
 * NO side effects here — the executable (scripts/self-host-init.mjs) collects the
 * created ids and runs the plan; this module is the TESTED source of truth for WHAT
 * gets run and HOW the config is shaped.
 *
 * PARITY CAVEAT: scripts/ is a no-build Node CLI and cannot import this TS module,
 * and the workerd test pool cannot read the .mjs off disk — so parity is NOT machine-
 * enforced. The .mjs hand-mirrors this plan; keep the two in step MANUALLY (same step
 * order + the EMBEDDING_DIMENSIONS constant). test/cli/provision.test.ts locks THIS
 * module's contract (order, dims, secret-not-var); the .mjs is verified by dry-run.
 */

/** bge-m3 embedding size — MUST match src/memory/embed and the Vectorize index. */
export const EMBEDDING_DIMENSIONS = 1024;
/** Keep in step with wrangler.jsonc so a self-host worker behaves like the reference. */
export const COMPAT_DATE = "2026-06-01";
export const DEFAULT_WORKER_NAME = "bemlembrado";

/** Resource names derived from the worker name (stable, predictable, collision-scoped per account). */
export interface ResourceNames {
  readonly workerName: string;
  readonly d1Name: string;
  readonly kvBinding: "KV";
  readonly vectorizeIndex: string;
  readonly r2Bucket: string;
}

export function resourceNames(workerName: string = DEFAULT_WORKER_NAME): ResourceNames {
  return {
    workerName,
    d1Name: workerName,
    kvBinding: "KV",
    vectorizeIndex: `${workerName}-mem`,
    r2Bucket: `${workerName}-vault`,
  };
}

/** Concrete ids captured from `wrangler … create` output, needed to render the config. */
export interface ResourceIds {
  readonly d1DatabaseId: string;
  readonly kvNamespaceId: string;
  readonly route?: string;
}

export interface PlanStep {
  readonly id: string;
  readonly description: string;
  /** Exact shell command, or null for a non-shell step (e.g. "write the config file"). */
  readonly command: string | null;
  /** This step's output yields an id that must be pasted into wrangler.jsonc. */
  readonly capturesId?: "d1" | "kv";
}

/**
 * The ordered provisioning plan. Create the four stores, write the config with their
 * ids, apply migrations, set the pepper secret, deploy, then seed the owner tenant +
 * API key. Resource creation is idempotent-ish (wrangler errors if a name exists — the
 * executor surfaces that so the operator can reuse or rename).
 */
export function provisioningPlan(workerName: string = DEFAULT_WORKER_NAME): PlanStep[] {
  const n = resourceNames(workerName);
  return [
    { id: "d1", description: "Create the D1 database (episodic log + source of truth)", command: `wrangler d1 create ${n.d1Name}`, capturesId: "d1" },
    { id: "kv", description: "Create the KV namespace (hot-path: routing, cached summaries, dedupe)", command: `wrangler kv namespace create ${n.kvBinding}`, capturesId: "kv" },
    { id: "vectorize", description: `Create the Vectorize index (${String(EMBEDDING_DIMENSIONS)}-dim, cosine — bge-m3)`, command: `wrangler vectorize create ${n.vectorizeIndex} --dimensions=${String(EMBEDDING_DIMENSIONS)} --metric=cosine` },
    { id: "r2", description: "Create the R2 bucket (LLM-Wiki markdown vault)", command: `wrangler r2 bucket create ${n.r2Bucket}` },
    { id: "config", description: "Write wrangler.jsonc with the created resource ids", command: null },
    { id: "migrations", description: "Apply all D1 migrations to the remote database", command: `wrangler d1 migrations apply ${n.d1Name} --remote` },
    { id: "secret", description: "Set the API-key pepper (a strong random secret; never stored in git)", command: "wrangler secret put API_KEY_PEPPER" },
    { id: "deploy", description: "Deploy the worker", command: "wrangler deploy" },
    { id: "seed", description: "Seed the owner tenant + first API key (bemlembrado init generates the key and prints it once)", command: null },
  ];
}

/** Escape a value for safe embedding in a double-quoted JSON string. */
function jsonString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Render a self-host wrangler.jsonc wiring the operator's created resources. Mirrors
 * the reference config's bindings exactly (DB/KV/VECTORIZE/SESSION=SessionDO/AI/VAULT
 * + the v1 SessionDO migration + migrations_dir), minus the reference account's ids.
 */
export function renderWranglerConfig(names: ResourceNames, ids: ResourceIds): string {
  const routeBlock =
    ids.route !== undefined && ids.route.length > 0
      ? `\n  "routes": [{ "pattern": ${jsonString(ids.route)}, "custom_domain": true }],`
      : "";
  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": ${jsonString(names.workerName)},
  "main": "src/index.ts",
  "compatibility_date": ${jsonString(COMPAT_DATE)},
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "placement": { "mode": "smart" },${routeBlock}
  "d1_databases": [
    { "binding": "DB", "database_name": ${jsonString(names.d1Name)}, "database_id": ${jsonString(ids.d1DatabaseId)}, "migrations_dir": "migrations" }
  ],
  "kv_namespaces": [
    { "binding": "KV", "id": ${jsonString(ids.kvNamespaceId)} }
  ],
  "vectorize": [
    { "binding": "VECTORIZE", "index_name": ${jsonString(names.vectorizeIndex)} }
  ],
  "durable_objects": {
    "bindings": [{ "name": "SESSION", "class_name": "SessionDO" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["SessionDO"] }
  ],
  "ai": { "binding": "AI" },
  "r2_buckets": [
    { "binding": "VAULT", "bucket_name": ${jsonString(names.r2Bucket)} }
  ],
  "vars": { "ENVIRONMENT": "production" }
}
`;
}
