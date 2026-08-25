# BemLembrado — Constitution (governing principles)

> Read at session start and before every phase. Non-negotiable.

## Stack (locked)
- **Runtime:** Cloudflare Workers + Hono (edge). TypeScript **strict — no `any`**.
- **MCP:** Cloudflare Agents SDK (`agents`, `createMcpHandler`, Streamable HTTP transport). Each MCP session is backed by a Durable Object.
- **Storage:** Vectorize (semantic, ≤1536 dims, topK≤50), D1 (episodic + source of truth), KV (hot-path), Durable Objects (per-session working memory + write serialization).
- **AI:** Workers AI (`bge-m3` embeddings; LLM for summarization). Outbound LLM calls proxied through **AI Gateway** (default gateway).
- **Inference providers:** Anthropic (premium, `cache_control` + mid-conv system messages) + Workers AI (default/fallback). BYOK in managed model.
- **Repo:** `SkilLab-Tech/bemlembrado` (GitHub-first).
- **Deploy:** Wrangler + GitHub Actions. **Tests:** Vitest. **Payments (V1):** Mercado Pago (PIX/BRL) + Stripe (cross-border).

## Non-negotiables
1. **Cache-correctness is a first-class invariant.** The retrieved Context Block is ALWAYS emitted *after* the cache breakpoint (tool-role message, or mid-conversation system message on Opus 4.8). It must NEVER be placed in the system prompt. Any code path that mutates the static prefix (system + tools + history-up-to-last-user) between turns is a bug. Add a test that asserts byte-identical prefix across turns.
2. **Tenant isolation is mandatory, never optional.** Every query carries a namespace; no cross-tenant vector or row access is ever possible. Add a test that proves T2 data never returns for T1's key.
3. **No data resale.** Architectural rule (unroll.me lesson). Memory is processed for the customer's agent only.
4. **LGPD by design.** Configurable TTL + retention; right-to-delete cascades to Vectorize AND D1; managed model = client is controller, BemLembrado is operator.
5. **Free-tier discipline.** Stay inside Cloudflare free tier during MVP. Flag any paid tier in PR description with R$ + timing.
6. **Verification gate (harness rule):** unvalidated output never reaches an external system. Schema-validate after every LLM call. Deterministic checks (tests/linters/types) on every code path.
7. **Faithful reporting:** tests failed = say so with output; step skipped = say so. No green-washing.

## Code quality
- DRY, minimum complexity, OWASP defaults. Secrets in Workers Secrets. API keys hashed at rest.
- Every module: error handling + edge cases a senior would expect. Inline comments only on non-obvious decisions.
- Conventional commits; one feature per PR; branch from `main`, never push to `main` without confirmation.

## Convention locks (from the build plan)
- **Naming:** repo/dir = `bem-lembrado`; product brand = `BemLembrado`; wrangler worker name = `bemlembrado`. NEVER apply another product's brand tokens — BemLembrado is its own brand.
- **Durable Object class name = `SessionDO`** (single name across wrangler.jsonc + stub + implementation, or the DO migration fails).
- **Single monotonic migration ledger** (`docs/00-migration-ledger.md`): F1 owns base tables 0001–0006; every later change is an additive ALTER / new table with the next free number. No migration-number collisions.

## KNOWN_FAILURE_MODES (seed — append as discovered)
- (empty) — populate from real traces per the failure-learning loop.
```jsonl
```
