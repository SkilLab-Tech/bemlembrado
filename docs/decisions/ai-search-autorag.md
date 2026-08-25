# ADR: Cloudflare AI Search (ex-AutoRAG) — DEFER, keep Vectorize

**Date:** 2026-07-01 · **Status:** Accepted (DEFER) · **Method:** verified research workflow (verified against live CF docs, 2026-06-30/07-01).

## Context
Product RAG directive: "use CF Workers AI as default for AI + embeddings, and CF AI Search + Vectorize for RAG." This ADR records what adopting **AI Search** (Cloudflare's managed RAG, renamed from AutoRAG on 2025-09-25; migrated to managed infra 2026-06-18; still **open beta**, no GA) would actually mean for BemLembrado, and why we defer it.

We already have: R2 vault (`bemlembrado-vault*`, markdown = source of truth) + Vectorize (`bemlembrado-mem*`, 1024-dim bge-m3) with retrieval scoped by **Vectorize's native namespace** — a server-enforced filter injected by *our* code (`VectorStore.query(values, namespaceId, topK)`), CI-gated by the tenant-isolation invariant (P0 #2).

## Decision: DEFER
Keep Vectorize (as-is) as the RAG store. Do **not** replace or augment-in-prod with AI Search now. Build a thin DI `RetrievalProvider` seam (flag-off) so AI Search can be A/B-measured later without a rewrite.

## Why (verified)
1. **Tenant isolation on a shared instance — REFUTED (~90%).** AI Search's metadata filter (`ai_search_options.retrieval.filters`) is *applied* server-side but *supplied by the caller* per query — **fail-open** (omitted/malformed filter → results across all tenants). CF docs describe it behaviorally, never as a security boundary. Adopting it would move our P0-critical guarantee from code we control to a caller-supplied string on a beta product — a **downgrade**. The only server-enforced option is **instance-per-tenant** (`ai_search_namespaces`), capped at **5,000 instances/account (Paid)** + heavy per-tenant lifecycle → non-viable at scale.
2. **It's beta and just had a breaking migration** (managed-index, BYO-index closed 2026-06-18). Wrong risk trade for a non-negotiable invariant.
3. **Duplicate index + double embedding.** AI Search builds its **own** managed index — it **cannot** reuse `bemlembrado-mem`. Adopting it = a second embedding pass over the vault + a parallel opaque index (bge-m3 1024 *is* selectable, so vectors are the same kind, just duplicated).
4. **The one genuine draw is retrieval quality** — built-in hybrid (vector+BM25), reranking (`bge-reranker-base`), query rewriting, R2 auto-sync. Worth **measuring**, not adopting blind.

## Cost & the provisioning gate
Service layer is **free during open beta** (limits: 100 instances Free / 5,000 Paid · 20k queries/mo Free / unlimited Paid · 100k files/instance · 4MB/file). Only **Workers AI + AI Gateway** bill (Neurons $0.011/1k; a ~200-tok embed ≈ 0.2 Neurons, inside the 10k/day free pool; the answer-LLM via `chatCompletions()` dominates — prefer retrieval-only `search()`). **Future pricing is unpublished** (≥30-day notice promised) → vendor-lock risk on a non-negotiable path. **Provisioning is cost-bearing + cost-uncertain → requires explicit maintainer approval. Do not provision autonomously.**

## The seam to build now (zero provisioning, testable via DI fake — no local sim exists)
- `src/retrieval/RetrievalProvider.ts` — `retrieve({ namespaceId, query, topK }): Promise<Chunk[]>`; **`namespaceId` non-optional** (type system forbids an unscoped call).
- `VectorizeRetrievalProvider` — existing bge-m3 → `Vectorize.query()` path, refactored to the interface. **Default.**
- `AiSearchRetrievalProvider` — wraps `env.MY_SEARCH.search(...)`, **constructs the tenant filter internally from `namespaceId`, never accepts a caller filter** (enforced wrapper). Gated by `AI_SEARCH_ENABLED` (default false).
- `FakeRetrievalProvider` + `test/retrieval/isolation.test.ts` — CI gate: tenant A never sees tenant B through the interface. Runs today, zero provisioning.

## If ever adopted (gated steps, maintainer approval required)
- Create instance (`wrangler ai-search create bemlembrado-search --type r2 --source bemlembrado-vault`); **pin embedding to `@cf/baai/bge-m3` at creation — one-way door, do NOT use Smart Default**.
- Bind `"ai_search": [{ "binding": "MY_SEARCH", "instance_name": "bemlembrado-search" }]`.
- Scope tenants by R2 folder prefix `note:{namespaceId}/`; filter with a **lexicographic range** (`folder: { $gte: "note:{ns}/", $lt: "note:{ns}0" }`), NOT `$eq` (misses nested chunks) or a naive prefix (`note:1/` catches `note:10/`).

## Open / <70% confidence (verify on a live instance before trusting)
- Filter operator syntax: binding page shows bare (`eq`) vs REST/filtering page shows `$`-prefixed (`$eq`) — **disagree**; confirm against `compatibility_date`.
- Range terminator correctness (`note:{ns}0`) not catching sibling namespaces.
- R2 sync latency (write→queryable): auto every 6h, manual as often as 30s, **eventual not synchronous** — a possible gap vs our write-then-immediately-read memory pattern; measure.
- Free-tier 20k-query cap: per-instance or per-account? Chunk-size default. Post-beta pricing/GA date.

**Convert DEFER → AUGMENT only if** a measured hybrid+rerank retrieval-quality gap on *our* corpus justifies it. The seam makes that a flag-flip + one gated provisioning step.
