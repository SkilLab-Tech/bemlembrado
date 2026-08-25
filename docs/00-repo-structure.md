# BemLembrado — Repo Structure (src layout)

```
bem-lembrado/
├── src/
│   ├── index.ts                 # Hono app + route mounting (default fetch export)
│   ├── env.ts                   # typed Env + boot-time secret/binding validation
│   ├── mcp.ts                   # Agents SDK createMcpHandler (Streamable HTTP) — 3 tools
│   ├── memory/
│   │   ├── embed.ts             # Workers AI bge-m3 (≤1536 dims; bge-m3 = 1024)
│   │   ├── add.ts               # add_memory: embed → Vectorize upsert + D1 insert
│   │   ├── search.ts            # search_memory: namespaced Vectorize query, topK≤50
│   │   └── vector-index.ts      # typed Vectorize wrapper (namespace required)
│   ├── context/
│   │   ├── assemble.ts          # assembleContextBlock(memories, provider) — THE differentiator
│   │   └── request-builder.ts   # tools → system → history → latest_user(cache_control) → context_block
│   ├── inference/
│   │   └── client.ts            # inferenceClient(provider) behind AI Gateway; failover
│   ├── session/
│   │   └── durable-object.ts    # class SessionDO (working memory + write serialization + MCP session)
│   ├── auth/
│   │   ├── api-key.ts           # hashing + constant-time verify + tenant resolution
│   │   └── namespace.ts         # required-namespace resolver (tenant-owned, 404 not 403)
│   ├── usage/
│   │   ├── telemetry.ts         # USAGE_EVENT writer + cost model
│   │   └── routes.ts            # GET /v1/usage (fresh/cache split + savings ratio)
│   ├── http/                    # app factory, error envelope, middleware (request-id, rate-limit, security-headers+CORS)
│   ├── obs/                     # structured logger (secret-redacting)
│   └── db/
│       └── client.ts            # typed D1 client (namespace/tenant required) — single source of SQL
├── migrations/                  # D1 SQL migrations (ledger: docs/00-migration-ledger.md)
├── test/
│   ├── invariants/cache-prefix.test.ts        # P0 invariant #1 (CI gate)
│   ├── invariants/tenant-isolation.test.ts    # P0 invariant #2 (CI gate)
│   ├── integration/ · perf/ · smoke/          # per-AC suites
├── .github/workflows/  ci.yml
├── README.md, LICENSE, SECURITY.md, CONTRIBUTING.md, KNOWN_FAILURE_MODES.jsonl
└── wrangler.jsonc · package.json · tsconfig.json · vitest.config.ts · eslint.config.mjs · LICENSE · CODEOWNERS
```

## Storage tiers
- **Vectorize** — semantic vectors, namespaced per tenant/agent (≤1536 dims, topK≤50, 10M/index, 10KiB metadata).
- **D1** — episodic log + entities + usage events — **source of truth**.
- **KV** — hot-path: session→DO routing, cached summaries, dedupe keys.
- **Durable Object (`SessionDO`)** — live working memory + write serialization (one per SESSION).
- **AI Gateway** — proxy to Anthropic/Workers AI: `cache_control` passthrough, logging, spend caps.

> `src/` is created empty (`.gitkeep`) by the lab bootstrap. Files above are populated across the build.
