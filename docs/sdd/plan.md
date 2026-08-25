# BemLembrado — Plan (how)

## Architecture (edge-first)
```
Agent (MCP client | REST) → Worker (Hono router + Agents SDK / createMcpHandler)
  ├─ Durable Object   (one per SESSION: working memory, write serialization, MCP session state) — class SessionDO
  ├─ Workers AI       (bge-m3 embeddings; LLM summarize/extract — V1)
  ├─ Vectorize        (semantic search, namespaced per tenant/agent; ≤1536 dims; topK≤50)
  ├─ D1               (episodic log + entities + usage events — source of truth)
  ├─ KV               (session→DO routing, cached summaries, dedupe keys)
  └─ AI Gateway       (proxy to Anthropic/OpenAI/Workers AI: cache_control passthrough, logging, spend caps)
```

## Key design decisions
1. **Context Block emitter (the differentiator).** A pure function `assembleContextBlock(memories, provider)` returns `{role, content, placement_guidance}`. For Anthropic: role `tool` (fake tool_result) OR mid-conv `system` (Opus 4.8); guidance instructs the caller to set `cache_control` on the last user message so the block sits *outside* the cached prefix. The emitter must NOT touch the static prefix. **Untrusted/retrieved content goes in `tool_result`, never in a mid-conv system message** (Anthropic guidance).
2. **Prefix stability.** History up to and including the latest user message is the cached region. The previous assistant reply (generated after the old block) is folded into history and cached from then on. Implement as an explicit request-builder that orders: `tools → system → history → latest_user(cache_control) → context_block`.
3. **Provider routing.** `inferenceClient(provider)` behind AI Gateway. Anthropic native passthrough preserves `cache_control`. Workers AI path uses `x-session-affinity` for its native prefix cache (same static-first/volatile-last rule). Anthropic 5xx/timeout fails over to Workers AI default.
4. **Tenant isolation.** Namespace is a required arg on every store/query; enforced at the data layer, not just the API layer.
5. **Embeddings.** `bge-m3` (≤1536 dims — actually 1024, fits Vectorize). Do not select 3072-dim models in V1.

## Libraries
`hono`, `agents` (CF Agents SDK), `@cloudflare/workers-types`, `zod`, `workers-oauth-provider` (V1), `@anthropic-ai/sdk` (baseURL → AI Gateway), `vitest`, `@cloudflare/vitest-pool-workers`, `wrangler`. Mercado Pago + Stripe SDKs (V1).

## Data model
The data model lives in `migrations/`. Bindings in `wrangler.jsonc`: `VECTORIZE`, `DB` (D1), `KV`, `SESSION` (DO namespace, class SessionDO), `AI` (Workers AI), `AI_GATEWAY` config.

## Environments
`dev` (local Wrangler + Miniflare), `staging` (workers.dev), `production` (custom domain). Never infer prod from urgency; default to staging.

## Testing strategy
- Deterministic: types (strict), Vitest unit + integration on Miniflare via `@cloudflare/vitest-pool-workers` (single-worker isolation for shared DO/D1 state).
- **Invariant tests:** (a) cache-prefix byte-identity across turns; (b) tenant isolation; (c) topK/dim limits respected.
- Statistical (V1): retrieval relevance eval set (≥5 golden cases); cost-savings replay (≥30 turns) asserting savings ratio ≥1.5x.

## Constraints
Vectorize: 10M vectors/index, topK≤50, 1536 dims, 10KiB metadata/vector. Cache TTL 5 min (Anthropic) — telemetry must flag turns that miss the window. Free-tier ceilings per constitution.
