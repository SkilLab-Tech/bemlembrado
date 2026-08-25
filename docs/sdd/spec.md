# BemLembrado — Spec (what + why)

## What we are building (MVP)
A cache-aware, edge-native agent memory layer on Cloudflare. Agents store and retrieve memory via an MCP server (and a REST API); retrieved context is emitted **below the cache breakpoint** to preserve the model provider's prompt cache, cutting token cost on long conversations. Multi-provider (Anthropic + Workers AI) via AI Gateway. BR localization (LGPD residency, BRL/PIX, pt-BR) is the wedge.

## Why
No competitor (Zep, Mem0, Letta, Cognee, Supermemory, Memobase, LangMem, Redis) markets cache-aware placement; most inject memory into the system prompt and break the cache. None addresses Brazil. Open-core + managed lets the client own the instance (lower support + LGPD surface).

## User stories (MVP, P0)
- **US-1** As an *agent*, I call `add_memory(text, namespace)` so a fact is embedded and stored, returning an id.
  - AC: Given an MCP connection, When `add_memory` is called, Then memory persists (Vectorize + D1) and an id returns in <1s p95.
- **US-2** As an *agent*, I call `search_memory(query, namespace, topK)` to get the most relevant memories.
  - AC: Given memories in ns=A, When searching ns=A, Then only A's memories return ranked by similarity, topK≤50, p95<300ms.
- **US-3** As an *agent*, I call `get_session_context(session_id, provider)` to receive a Context Block ready to attach **after** the cache breakpoint.
  - AC: Given provider=anthropic, Then the response is a tool/mid-conv-system message + guidance to set `cache_control` on the latest user message, and the static prefix is byte-identical to the previous turn.
- **US-4** As a *dev*, I authenticate with an API key so my tenant's data is isolated.
  - AC: Given T1's key, When querying, Then no T2 data ever returns; invalid key → 401.
- **US-5** As a *dev*, I read `/v1/usage` to see token savings.
  - AC: Given a multi-turn session, Then per-turn fresh vs cache-read token split + savings ratio return.
- **US-6** As a *dev*, concurrent writes to one session never lose updates.
  - AC: Given N concurrent `add_memory` to one session, Then the Durable Object serializes them; final state contains all N.

## Out of scope (MVP) — stated positively
Graph memory, web console, B2C public tier, >1536-dim embeddings, framework integrations, multi-region outside BR/CF edge.

## Definition of done (MVP)
All P0 ACs pass under Vitest; the cache-prefix invariant test passes; tenant-isolation test passes; deployed to a Workers staging env; cost telemetry shows a measurable fresh-vs-cache split on a ≥30-turn replay.
