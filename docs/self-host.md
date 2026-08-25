# Self-host BemLembrado (F5 #117-119)

Run your own BemLembrado instance on your own Cloudflare account — you are the
controller *and* the operator, all data stays in your account. Target: clean
account → `/health` 200 in **under 15 minutes**.

## One command

```bash
git clone https://github.com/SkilLab-Tech/bemlembrado && cd bemlembrado
pnpm install
npx wrangler login          # authenticate to YOUR Cloudflare account
npx bemlembrado init        # DRY-RUN: prints the exact plan + config, changes nothing
npx bemlembrado init --execute   # actually provision + deploy + seed
```

Flags: `--worker <name>` (default `bemlembrado`), `--route <domain>` (custom
domain), `--owner <id>` (owner tenant id, default `owner`).

## What `--execute` does (the plan)

The canonical, tested plan lives in [`src/cli/provision.ts`](../src/cli/provision.ts):

1. `wrangler d1 create <worker>` — episodic log + source of truth
2. `wrangler kv namespace create KV` — hot-path (routing, cached summaries, dedupe)
3. `wrangler vectorize create <worker>-mem --dimensions=1024 --metric=cosine` — bge-m3 semantic memory
4. `wrangler r2 bucket create <worker>-vault` — LLM-Wiki markdown vault
5. **write `wrangler.jsonc`** with the created ids (bindings + the locked `SessionDO` DO + `migrations_dir`)
6. `wrangler d1 migrations apply <worker> --remote` — all migrations, from zero
7. `wrangler secret put API_KEY_PEPPER` — a fresh 32-byte random pepper (never in git)
8. `wrangler deploy`
9. seed the owner tenant + first API key — **printed once**, store it immediately

The API key is `bl_…`; only its `SHA-256(pepper:key)` hash is stored (never the raw key).

## Verify (<15-min gate)

```bash
curl -s https://<your-worker-url>/health            # {"status":"ok"}
curl -s https://<your-worker-url>/health/deep       # d1/kv/vectorize/ai/vault all "ok"
curl -s https://<your-worker-url>/v1/onboarding \
  -H "Authorization: Bearer <YOUR_API_KEY>"          # MCP connect string + REST base
```

## Honest scope

- **`--execute` performs irreversible external actions** (creates real Cloudflare
  resources, deploys, seeds). That is why dry-run is the default. It requires a live
  `wrangler login` and is **not** run in CI — no clean CF account is provisioned in
  the pipeline. The plan and the generated `wrangler.jsonc` are unit-verified
  (`test/cli/provision.test.ts`); the end-to-end clean-account run is verified
  manually against this runbook.
- If wrangler cannot auto-capture the D1/KV ids (`--json` output shape changes), the
  CLI stops and asks you to paste them into `wrangler.jsonc` — the rest of the plan
  is the same numbered steps above.
- **Managed / white-label** (operator runs it *for* a client, BYOK) is a separate
  path — see the DPA scaffolding in [`docs/lgpd/dpa.md`](./lgpd/dpa.md).
