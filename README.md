# BemLembrado Core

A cache-aware, edge-native **agent memory layer** for Cloudflare Workers. It gives an
AI agent durable, per-tenant memory — semantic search, capture, and right-to-erasure —
exposed over both an **MCP server** (Streamable HTTP) and a plain **REST API**.

The design goal that shapes everything else: the retrieved memory (the "Context Block")
is always emitted **after** the prompt-cache breakpoint, never spliced into the system
prompt. The static prefix (tools + system + history up to the last user turn) stays
byte-identical across turns, so adding memory does not invalidate the model's prompt
cache. Two CI-enforced invariants guard this and tenant isolation.

## What's here

- **Memory engine** — capture + semantic retrieval over Vectorize, with D1 as the
  source of truth and KV as the hot path.
- **MCP server** — `ping`, `add_memory`, `create_namespace`, `list_namespaces`,
  `get_page`, `log_decision`, `search_memory`, `get_session_context`,
  `remember_and_respond` (see `src/mcp/catalog.ts`).
- **REST API** — the same surface for non-MCP clients (`src/http`).
- **LGPD-by-design** — configurable retention; right-to-delete cascades to Vectorize
  **and** D1 **and** KV; lossless per-tenant export; confidential namespaces with a
  server-side default-exclude filter. See `docs/lgpd/` and `docs/sdd/constitution.md`.
- **Self-host** — `npx bemlembrado init` scaffolds the Cloudflare resources; migrations
  live in `migrations/`.

## Not

- **Not zero-knowledge.** Embedding and (optional) curation run on the operator's
  compute and require plaintext. The honest guarantee is protection at rest and in
  transit and hard tenant isolation — *not* that the operator cannot read your data.
- **No benchmark claims here.** Measure it on your own workload.

## Stack

Cloudflare Workers + Hono · TypeScript (strict, zero `any`) · MCP via the Agents SDK ·
Vectorize (bge-m3, 1024-dim, cosine) · D1 · KV · Durable Objects · R2 · Workers AI.

## Quickstart (self-host)

```bash
git clone https://github.com/SkilLab-Tech/bemlembrado && cd bemlembrado
pnpm install
cp .dev.vars.example .dev.vars      # fill in your secrets — never commit .dev.vars

# provision Cloudflare resources, then paste the ids into wrangler.jsonc
npx bemlembrado init

pnpm exec wrangler d1 migrations apply bemlembrado --local
pnpm dev
```

`wrangler.jsonc` ships with placeholder (all-zero) resource ids — replace them with the
ids `wrangler` prints when you create your D1 database, KV namespace, Vectorize index,
and R2 bucket. Full walkthrough in [`docs/self-host.md`](docs/self-host.md).

## Tests

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm test:invariants     # the two P0 gates: cache-prefix byte-identity + tenant isolation
```

## License — Fair Source, converts to Apache-2.0

This is **not** an OSI "open source" project. It is **source-available** under the
[Business Source License 1.1](LICENSE) (SPDX: `BUSL-1.1`):

- **Free** for non-production use, and for production use **up to 5 named users**.
- **Beyond 5 named users** in production, you need a commercial license —
  contact `licenciamento@bemlembrado.com`.
- Each released version **automatically converts to Apache License 2.0** on its Change
  Date (two years after that version is published). At that point it becomes true open
  source, permanently.

BemLembrado is a product of Automation Labs Tecnologia LTDA (The Labs Group). The name and logo are trademarks and are
not licensed for use by the BSL grant.
