# Cache-aware inference turn + savings telemetry (the differentiator, delivered)

Builds on the verified memory layer + the cache-aware request builder (`buildRequest`,
P0 #1 GREEN) to make BemLembrado sit IN the inference path: retrieve memory, assemble a
request whose static prefix is byte-identical across turns, call the provider, record token
usage split (fresh / cache-read / cache-write), and prove the savings. This is the
"cut your token bill up to 2x" thesis, end-to-end.

## Scope guardrails
- **Cost**: all tests use DI fakes (no real LLM calls). Live smoke uses Workers AI (free tier).
  The **headline savings proof** (real cache-read tokens on turn 2) needs **Anthropic prompt
  caching** — gated on the operator's `ANTHROPIC_API_KEY`. The savings *computation* is proven in tests
  with Anthropic-shaped usage; the live Anthropic run is the one flagged-gated item.
- **P0 #1**: the live turn's static prefix excludes retrieved memories and is byte-identical
  across turns (memories ride after the breakpoint as `tool_result`). Gate extended to the turn.
- **P0 #2**: every turn is tenant-scoped (session + namespace owned by the principal).
- **KFM-003**: retrieved/untrusted content is fenced data in a `tool_result`, never instructions.

## PRs (serial; branch -> gate -> commit -> PR -> squash-merge; staging deploy at the end)
1. `normalizeUsage` — provider usage -> {fresh, cacheRead, cacheWrite, cacheReported} (Anthropic
   reports cache; Workers AI / Maritaca don't -> honest zeros). **[this PR]**
2. cost model + `recordUsage` (best-effort `insertUsageEvent`).
3. `assembleTurn` — load history + search memory -> `buildRequest`; P0 #1 byte-identity.
4. `InferenceClient.chat(provider, messages, opts)` -> {text, usage}; usage parsed via #1.
5. `runTurn` — assemble -> chat -> appendMessage(user+assistant) -> recordUsage.
6. REST `POST /v1/turn` (rate-limited, body bounds).
7. cache_control on the Anthropic prefix + Workers AI `x-session-affinity`.
8. provider failover on the turn.
9. trusted-context sanitizer (mid-conv-system).
10. byte-identity gate extended to the live turn assembly.
11. breakpoint-budget guard (cap memory tokens / lookback).
12. `GET /v1/usage` — split + savings ratio (by namespace/session).
13. savings computation + honest-null when no cache data.
14. replay harness test (30 turns -> assert ratio computation).
15. flag turns outside the 5-min cache window.
16. wire `curate()` best-effort after a turn (flag-gated).
17. curator on a real model (`chatModel` over Workers AI).
18. `GET /v1/notes` + `GET /v1/notes/:slug`.
19. `POST /v1/notes/search` (note retrieval; separate store from episodic — no store-split).
20. OpenAPI 3.1 at `GET /openapi.json`.
21. structured access-log middleware (redacted).
22. `GET /health/deep` (D1/Vectorize reachability).
23. MCP `remember_and_respond` tool over `runTurn`.
24. docs: emitter README + usage/savings.
25. deploy staging + live turn smoke (Workers AI end-to-end).
