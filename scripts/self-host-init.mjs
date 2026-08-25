#!/usr/bin/env node
/**
 * `npx bemlembrado init` — self-host provisioner (F5 #117-119).
 *
 * Stands up a BemLembrado instance on the operator's OWN Cloudflare account:
 * creates D1 + KV + Vectorize + R2, writes wrangler.jsonc with the created ids,
 * applies migrations, sets the API-key pepper, deploys, and seeds the owner tenant
 * + first API key (printed ONCE). Target: a clean account to /health 200 in <15 min.
 *
 * DRY-RUN BY DEFAULT — prints the exact plan and the config it would write, and
 * changes nothing. Pass --execute to actually run it (needs `wrangler login` first).
 * The canonical plan/config live in src/cli/provision.ts (unit-tested source of
 * truth); keep this executable's plan/renderConfig in step with that module.
 *
 * Usage:
 *   npx bemlembrado init [--worker <name>] [--route <domain>] [--owner <id>] [--execute]
 */

import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const EMBEDDING_DIMENSIONS = 1024; // bge-m3 — MUST match src/memory/embed + Vectorize
const COMPAT_DATE = "2026-06-01";

function parseArgs(argv) {
  const args = { worker: "bemlembrado", route: null, owner: "owner", execute: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--execute") args.execute = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--worker") args.worker = argv[++i] ?? args.worker;
    else if (a === "--route") args.route = argv[++i] ?? null;
    else if (a === "--owner") args.owner = argv[++i] ?? args.owner;
  }
  return args;
}

function names(worker) {
  return { worker, d1: worker, kv: "KV", vectorize: `${worker}-mem`, r2: `${worker}-vault` };
}

function plan(worker) {
  const n = names(worker);
  return [
    { id: "d1", desc: "Create D1 (episodic log + source of truth)", cmd: `wrangler d1 create ${n.d1}`, captures: "d1" },
    { id: "kv", desc: "Create KV (hot-path: routing, cached summaries, dedupe)", cmd: `wrangler kv namespace create ${n.kv}`, captures: "kv" },
    { id: "vectorize", desc: `Create Vectorize (${EMBEDDING_DIMENSIONS}-dim, cosine — bge-m3)`, cmd: `wrangler vectorize create ${n.vectorize} --dimensions=${EMBEDDING_DIMENSIONS} --metric=cosine` },
    { id: "r2", desc: "Create R2 (LLM-Wiki markdown vault)", cmd: `wrangler r2 bucket create ${n.r2}` },
    { id: "config", desc: "Write wrangler.jsonc with the created ids", cmd: null },
    { id: "migrations", desc: "Apply all D1 migrations (remote)", cmd: `wrangler d1 migrations apply ${n.d1} --remote` },
    { id: "secret", desc: "Set API_KEY_PEPPER (generated random secret)", cmd: "wrangler secret put API_KEY_PEPPER" },
    { id: "deploy", desc: "Deploy the worker", cmd: "wrangler deploy" },
    { id: "seed", desc: "Seed owner tenant + first API key (printed once)", cmd: null },
  ];
}

function renderConfig(worker, route, d1Id, kvId) {
  const n = names(worker);
  const routeBlock = route ? `\n  "routes": [{ "pattern": ${JSON.stringify(route)}, "custom_domain": true }],` : "";
  return `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": ${JSON.stringify(worker)},
  "main": "src/index.ts",
  "compatibility_date": ${JSON.stringify(COMPAT_DATE)},
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "placement": { "mode": "smart" },${routeBlock}
  "d1_databases": [
    { "binding": "DB", "database_name": ${JSON.stringify(n.d1)}, "database_id": ${JSON.stringify(d1Id)}, "migrations_dir": "migrations" }
  ],
  "kv_namespaces": [
    { "binding": "KV", "id": ${JSON.stringify(kvId)} }
  ],
  "vectorize": [
    { "binding": "VECTORIZE", "index_name": ${JSON.stringify(n.vectorize)} }
  ],
  "durable_objects": {
    "bindings": [{ "name": "SESSION", "class_name": "SessionDO" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["SessionDO"] }
  ],
  "ai": { "binding": "AI" },
  "r2_buckets": [
    { "binding": "VAULT", "bucket_name": ${JSON.stringify(n.r2)} }
  ],
  "vars": { "ENVIRONMENT": "production" }
}
`;
}

/** `bl_` + 24 random bytes (base64url) — matches src/auth/api-key generateApiKey. */
function generateApiKey() {
  return "bl_" + randomBytes(24).toString("base64url");
}

/** SHA-256(pepper + ":" + key) hex — matches src/auth/api-key hashApiKey. */
function hashApiKey(key, pepper) {
  return createHash("sha256").update(`${pepper}:${key}`).digest("hex");
}

function run(cmd) {
  const r = spawnSync(cmd, { shell: true, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`command failed (exit ${r.status}): ${cmd}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("npx bemlembrado init [--worker <name>] [--route <domain>] [--owner <id>] [--execute]");
    console.log("  Default is DRY-RUN (prints the plan, changes nothing). --execute runs it (wrangler login required).");
    return;
  }

  const steps = plan(args.worker);
  console.log(`\nBemLembrado self-host init — worker "${args.worker}"${args.route ? ` @ ${args.route}` : ""}`);
  console.log(args.execute ? "MODE: EXECUTE (this will create real Cloudflare resources)\n" : "MODE: dry-run (nothing will change — pass --execute to run)\n");
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.desc}${s.cmd ? `\n     $ ${s.cmd}` : ""}`));

  if (!args.execute) {
    console.log("\nExample wrangler.jsonc that would be written (ids are placeholders here):");
    console.log(renderConfig(args.worker, args.route, "<d1-id>", "<kv-id>"));
    console.log("Re-run with --execute to provision. See docs/self-host.md.");
    return;
  }

  // --- EXECUTE ---------------------------------------------------------------
  // Note: wrangler create commands print ids; a fully-automated capture would parse
  // their JSON output (wrangler ... --json). Kept explicit so the operator sees each
  // step and pastes ids if capture fails. This is the documented <15-min path.
  // Execute in the SAME order the dry-run printed (plan(): d1 → kv → vectorize → r2
  // → config → migrations → secret → deploy → seed). The id-capturing steps (d1, kv)
  // run first so the rendered wrangler.jsonc can wire their ids.
  const n = names(args.worker);
  const d1Json = spawnSync(`wrangler d1 create ${n.d1} --json`, { shell: true, encoding: "utf8" });
  const kvJson = spawnSync(`wrangler kv namespace create ${n.kv} --json`, { shell: true, encoding: "utf8" });
  const d1Id = JSON.parse(d1Json.stdout || "{}")?.d1_databases?.[0]?.database_id ?? JSON.parse(d1Json.stdout || "{}")?.uuid ?? "";
  const kvId = JSON.parse(kvJson.stdout || "{}")?.id ?? "";
  if (!d1Id || !kvId) throw new Error("could not capture D1/KV ids — create them manually and paste into wrangler.jsonc (see docs/self-host.md)");
  run(`wrangler vectorize create ${n.vectorize} --dimensions=${EMBEDDING_DIMENSIONS} --metric=cosine`);
  run(`wrangler r2 bucket create ${n.r2}`);

  writeFileSync("wrangler.jsonc", renderConfig(args.worker, args.route, d1Id, kvId));
  run(`wrangler d1 migrations apply ${n.d1} --remote`);

  const pepper = randomBytes(32).toString("base64url");
  const putSecret = spawnSync("wrangler secret put API_KEY_PEPPER", { shell: true, input: pepper, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] });
  if (putSecret.status !== 0) throw new Error("failed to set API_KEY_PEPPER");

  run("wrangler deploy");

  const apiKey = generateApiKey();
  const hash = hashApiKey(apiKey, pepper);
  const insert = `INSERT INTO tenant (id, name, plan, api_key_hash, created_at) VALUES ('${args.owner}', '${args.owner}', 'open', '${hash}', ${Date.now()});`;
  run(`wrangler d1 execute ${n.d1} --remote --command ${JSON.stringify(insert)}`);

  console.log("\n✅ BemLembrado is live. Your owner API key (shown ONCE — store it now):\n");
  console.log(`   ${apiKey}\n`);
  console.log("Verify:  curl -s https://<your-worker-url>/health   → {\"status\":\"ok\"}");
  console.log("Connect: GET /v1/onboarding returns the MCP connect string.\n");
}

main();
