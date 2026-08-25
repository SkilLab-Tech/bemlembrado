# The cache-aware emitter + savings telemetry

BemLembrado's differentiator: it sits **in** the inference path and emits the retrieved
Context Block **after** the provider's cache breakpoint — never in the cached prefix.
The large stable prefix (system + history) stays byte-identical across turns, so the
provider's prompt cache keeps hitting it even as the retrieved memories change per turn.
That is the "cut your token bill up to 2×" claim, and it is enforced as **P0 invariant #1**
(`pnpm test:invariants`).

## The turn

`POST /v1/turn` (and the MCP `remember_and_respond` tool) run one turn:

1. **assemble** (`assembleTurn`) — resolve the tenant-owned namespace, load the session's
   working-memory history, semantic-search the namespace for relevant memories, and
   `buildRequest` into a stable prefix + a retrieved Context Block. Memories are excluded
   from the prefix by construction, so it is append-only across turns (P0 #1).
2. **chat** (`InferenceClient.chatTurn`) — call the provider with the cache breakpoint placed
   correctly (see matrix).
3. **persist** — append the user + assistant messages to D1 (source of truth) + the
   `SessionDO` working memory.
4. **record usage** — one `USAGE_EVENT` with the token split.
5. **(optional) curate** — fold the exchange into the LLM-Wiki vault as a note (flag-gated
   `CURATOR_ENABLED`, best-effort).

## Placement matrix

| Provider | Cache mechanism | Context Block placement |
|---|---|---|
| **anthropic** | `cache_control: ephemeral` on the user block; the Context Block is a later block in the same user message **without** a marker → uncached, swappable | after the breakpoint |
| **workers-ai** | native prefix cache (implicit) | trailing message after `[system, …history, user]` |
| **maritaca** | none reported | trailing message |

In every case the Context Block is **never** the system prompt (P0 #1), and on the trusted
Opus-4.8 `mid_conv_system` placement the content is run through `sanitizeTrustedContext`
(strips control tokens / fence-breakout / role-spoofing — KFM-003).

## Provider routing

Workers AI is the **default** for chat + bge-m3 embeddings (RAG over Vectorize). `resolveChatProvider`:
- explicit `provider: "anthropic"` → Anthropic **only if** `ANTHROPIC_API_KEY` is set (premium, opt-in);
- `lang` pt-* + `MARITACA_API_KEY` → Maritaca (pt-BR specialist);
- otherwise Workers AI.

On an `InferenceError` the turn fails over once to Workers AI (`chatTurnWithFallback`), and
usage is normalized against the provider that actually served the turn.

## Reading savings — `GET /v1/usage`

```json
{ "turns": 30, "tokensFresh": 3600, "tokensCacheRead": 145000, "tokensCacheWrite": 5000,
  "savingsRatio": 0.976, "costUsd": null }
```

- `savingsRatio = cacheRead / (cacheRead + fresh)` — the share of input served from cache.
- **`savingsRatio` is `null`** when no turn reported cache accounting. Only Anthropic reports
  cache tokens today; Workers AI / Maritaca return honest zeros, so the ratio is unmeasurable
  (we never invent a number).
- `costUsd` is `null` unless explicit per-model rates are supplied — we don't hardcode (and
  stale) provider prices. At Anthropic cache pricing (read 0.1×, write 1.25×) a high cache-read
  share is a >1.5× input-cost reduction (see `test/usage/savings-replay.test.ts`).
- `GET /v1/usage?session=<id>` adds `coldTurns`: turns whose gap exceeded the 5-minute
  ephemeral-cache window (prefix likely evicted → that turn re-paid a cache-write).

## Gated for the live savings proof

The mechanism + the measurement pipeline are tested with DI fakes + Anthropic-shaped usage.
The **live** cache-read proof needs `ANTHROPIC_API_KEY` (premium + cost) — the one flagged-gated
item. Everything else runs on free Workers AI.
